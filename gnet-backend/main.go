// gnet_file_server.go - Advanced file upload server with auth, retry, pause/resume
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/panjf2000/gnet/v2"
)

// ============================================
// Configuration
// ============================================

const (
	GNET_PORT = ":8081"

	S3_ENDPOINT   = "http://minio:9000"
	S3_REGION     = "us-east-1"
	S3_ACCESS_KEY = "admin"
	S3_SECRET_KEY = "strongpassword"
	S3_BUCKET     = "uploads"

	// Protocol structure: size_of_auth_token|auth_token|size_of_payload|payload
	// Header: auth_token_size(4 bytes) | auth_token | payload_size(4 bytes) | command(1 byte) | payload

	// Protocol commands
	CMD_INIT_UPLOAD   = 0x01 // Initialize upload session
	CMD_UPLOAD_CHUNK  = 0x02 // Upload a chunk
	CMD_PAUSE_UPLOAD  = 0x03 // Pause upload
	CMD_RESUME_UPLOAD = 0x04 // Resume upload
	CMD_CANCEL_UPLOAD = 0x05 // Cancel upload
	CMD_GET_STATUS    = 0x06 // Get upload status

	// Response codes
	RESP_OK           = 0x10 // Success
	RESP_ERROR        = 0x11 // Error
	RESP_READY        = 0x12 // Session ready
	RESP_CHUNK_ACK    = 0x13 // Chunk acknowledged
	RESP_COMPLETE     = 0x14 // Upload complete
	RESP_STATUS       = 0x15 // Status response
	RESP_PAUSED       = 0x16 // Upload paused
	RESP_RESUMED      = 0x17 // Upload resumed
	RESP_CANCELLED    = 0x18 // Upload cancelled
	RESP_AUTH_FAILED  = 0x19 // Authentication failed
	RESP_DUPLICATE    = 0x1A // Duplicate chunk (already received)

	// Session states
	STATE_INITIALIZED = "initialized"
	STATE_UPLOADING   = "uploading"
	STATE_PAUSED      = "paused"
	STATE_COMPLETED   = "completed"
	STATE_CANCELLED   = "cancelled"
	STATE_FAILED      = "failed"

	// File constraints
	MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024 // 10 GB
	MIN_CHUNK_SIZE = 5 * 1024 * 1024         // 5 MB (S3 minimum for multipart)
	MAX_CHUNK_SIZE = 100 * 1024 * 1024       // 100 MB

	// Timeouts
	SESSION_TIMEOUT = 2 * time.Hour
)

// Supported file types
var SUPPORTED_EXTENSIONS = map[string]string{
	".mp4":  "video/mp4",
	".pdf":  "application/pdf",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
	".mov":  "video/quicktime",
	".avi":  "video/x-msvideo",
	".mkv":  "video/x-matroska",
}

// ============================================
// S3 Client
// ============================================

type S3Client struct {
	client *s3.Client
	bucket string
}

func NewS3Client() (*S3Client, error) {
	customResolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
		if service == s3.ServiceID {
			return aws.Endpoint{
				URL:               S3_ENDPOINT,
				SigningRegion:     S3_REGION,
				HostnameImmutable: true,
			}, nil
		}
		return aws.Endpoint{}, fmt.Errorf("unknown endpoint requested")
	})

	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(S3_REGION),
		config.WithEndpointResolverWithOptions(customResolver),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			S3_ACCESS_KEY,
			S3_SECRET_KEY,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	})

	// Ensure bucket exists
	ctx := context.Background()
	_, err = client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(S3_BUCKET),
	})
	if err != nil {
		_, err = client.CreateBucket(ctx, &s3.CreateBucketInput{
			Bucket: aws.String(S3_BUCKET),
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create bucket: %w", err)
		}
		log.Printf("✅ Created S3 bucket: %s", S3_BUCKET)
	}

	return &S3Client{
		client: client,
		bucket: S3_BUCKET,
	}, nil
}

// ============================================
// Authentication
// ============================================

type AuthManager struct {
	tokens map[string]*TokenInfo
	mu     sync.RWMutex
}

type TokenInfo struct {
	UserID    string
	Username  string
	ExpiresAt time.Time
}

func NewAuthManager() *AuthManager {
	am := &AuthManager{
		tokens: make(map[string]*TokenInfo),
	}

	// Add some demo tokens for testing
	am.AddToken("test_token_user123", "user_123", "testuser", 24*time.Hour)
	am.AddToken("test_token_user456", "user_456", "john_doe", 24*time.Hour)

	return am
}

func (am *AuthManager) ValidateToken(token string) (*TokenInfo, bool) {
	am.mu.RLock()
	defer am.mu.RUnlock()

	info, exists := am.tokens[token]
	if !exists {
		return nil, false
	}

	if time.Now().After(info.ExpiresAt) {
		return nil, false
	}

	return info, true
}

func (am *AuthManager) AddToken(token, userID, username string, duration time.Duration) {
	am.mu.Lock()
	defer am.mu.Unlock()

	am.tokens[token] = &TokenInfo{
		UserID:    userID,
		Username:  username,
		ExpiresAt: time.Now().Add(duration),
	}
	log.Printf("🔑 Added auth token for user: %s (expires in %v)", username, duration)
}

// ============================================
// Upload Session
// ============================================

type ChunkInfo struct {
	Index      uint32
	Size       uint32
	Hash       string
	UploadedAt time.Time
	PartNumber int32
	ETag       string
}

type UploadSession struct {
	SessionID      string
	UserID         string
	Username       string
	FileName       string
	S3Key          string // user_id/timestamp/filename
	FileExtension  string
	ContentType    string
	TotalChunks    uint32
	ChunkSize      uint32
	TotalSize      uint64
	State          string
	ReceivedChunks map[uint32]*ChunkInfo
	UploadID       string
	CompletedParts []types.CompletedPart
	CreatedAt      time.Time
	UpdatedAt      time.Time
	PausedAt       *time.Time
	mu             sync.Mutex
}

func (us *UploadSession) AddChunk(index uint32, size uint32, hash string, partNumber int32, etag string) bool {
	us.mu.Lock()
	defer us.mu.Unlock()

	// Check if chunk already exists (duplicate)
	if existing, exists := us.ReceivedChunks[index]; exists {
		log.Printf("⚠️  Duplicate chunk detected: session=%s, chunk=%d (hash: %s)", us.SessionID, index, hash)
		// Verify hash matches
		if existing.Hash == hash {
			return true // Same chunk, skip (idempotent)
		}
		log.Printf("❌ Hash mismatch for chunk %d: expected %s, got %s", index, existing.Hash, hash)
		return false
	}

	// Add new chunk
	us.ReceivedChunks[index] = &ChunkInfo{
		Index:      index,
		Size:       size,
		Hash:       hash,
		UploadedAt: time.Now(),
		PartNumber: partNumber,
		ETag:       etag,
	}

	us.CompletedParts = append(us.CompletedParts, types.CompletedPart{
		PartNumber: aws.Int32(partNumber),
		ETag:       aws.String(etag),
	})

	us.State = STATE_UPLOADING
	us.UpdatedAt = time.Now()
	return false // Not duplicate
}

func (us *UploadSession) GetProgress() (received, total uint32) {
	us.mu.Lock()
	defer us.mu.Unlock()
	return uint32(len(us.ReceivedChunks)), us.TotalChunks
}

func (us *UploadSession) IsComplete() bool {
	us.mu.Lock()
	defer us.mu.Unlock()
	return len(us.ReceivedChunks) == int(us.TotalChunks)
}

func (us *UploadSession) GetMissingChunks() []uint32 {
	us.mu.Lock()
	defer us.mu.Unlock()

	missing := make([]uint32, 0)
	for i := uint32(0); i < us.TotalChunks; i++ {
		if _, exists := us.ReceivedChunks[i]; !exists {
			missing = append(missing, i)
		}
	}
	return missing
}

func (us *UploadSession) Pause() {
	us.mu.Lock()
	defer us.mu.Unlock()
	now := time.Now()
	us.State = STATE_PAUSED
	us.PausedAt = &now
	us.UpdatedAt = now
}

func (us *UploadSession) Resume() {
	us.mu.Lock()
	defer us.mu.Unlock()
	us.State = STATE_UPLOADING
	us.PausedAt = nil
	us.UpdatedAt = time.Now()
}

func (us *UploadSession) Cancel() {
	us.mu.Lock()
	defer us.mu.Unlock()
	us.State = STATE_CANCELLED
	us.UpdatedAt = time.Now()
}

// ============================================
// Session Manager
// ============================================

type SessionManager struct {
	sessions map[string]*UploadSession
	mu       sync.RWMutex
	s3Client *S3Client
	authMgr  *AuthManager
}

func NewSessionManager(s3Client *S3Client, authMgr *AuthManager) *SessionManager {
	sm := &SessionManager{
		sessions: make(map[string]*UploadSession),
		s3Client: s3Client,
		authMgr:  authMgr,
	}

	go sm.cleanupLoop()

	return sm
}

func (sm *SessionManager) CreateSession(userID, username, fileName string, totalChunks, chunkSize uint32) (*UploadSession, error) {
	// Validate file extension
	ext := strings.ToLower(filepath.Ext(fileName))
	contentType, supported := SUPPORTED_EXTENSIONS[ext]
	if !supported {
		return nil, fmt.Errorf("unsupported file type: %s (supported: mp4, pdf, jpg, png, gif, webp, mov, avi, mkv)", ext)
	}

	// Validate file size
	totalSize := uint64(totalChunks) * uint64(chunkSize)
	if totalSize > MAX_FILE_SIZE {
		return nil, fmt.Errorf("file size exceeds maximum: %d bytes (max: %d)", totalSize, MAX_FILE_SIZE)
	}

	// Validate chunk size
	if chunkSize < MIN_CHUNK_SIZE {
		return nil, fmt.Errorf("chunk size too small: %d bytes (min: %d)", chunkSize, MIN_CHUNK_SIZE)
	}
	if chunkSize > MAX_CHUNK_SIZE {
		return nil, fmt.Errorf("chunk size too large: %d bytes (max: %d)", chunkSize, MAX_CHUNK_SIZE)
	}

	// Generate S3 key: user_id/timestamp/filename
	timestamp := time.Now().Format("20060102_150405")
	s3Key := fmt.Sprintf("%s/%s/%s", userID, timestamp, fileName)

	// Generate session ID
	sessionID := fmt.Sprintf("%s_%d", userID, time.Now().UnixNano())

	sm.mu.Lock()
	defer sm.mu.Unlock()

	session := &UploadSession{
		SessionID:      sessionID,
		UserID:         userID,
		Username:       username,
		FileName:       fileName,
		S3Key:          s3Key,
		FileExtension:  ext,
		ContentType:    contentType,
		TotalChunks:    totalChunks,
		ChunkSize:      chunkSize,
		TotalSize:      totalSize,
		State:          STATE_INITIALIZED,
		ReceivedChunks: make(map[uint32]*ChunkInfo),
		CompletedParts: make([]types.CompletedPart, 0),
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	sm.sessions[sessionID] = session
	log.Printf("📦 Created session: %s (user: %s, file: %s, size: %.2f MB, chunks: %d, s3: %s)",
		sessionID, username, fileName, float64(totalSize)/(1024*1024), totalChunks, s3Key)

	return session, nil
}

func (sm *SessionManager) GetSession(sessionID string) *UploadSession {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.sessions[sessionID]
}

func (sm *SessionManager) DeleteSession(sessionID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	delete(sm.sessions, sessionID)
}

func (sm *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		sm.mu.Lock()
		now := time.Now()
		for id, session := range sm.sessions {
			shouldCleanup := false

			switch session.State {
			case STATE_COMPLETED, STATE_CANCELLED:
				// Clean up finished sessions after 1 hour
				if now.Sub(session.UpdatedAt) > 1*time.Hour {
					shouldCleanup = true
				}
			case STATE_PAUSED:
				// Clean up paused sessions after SESSION_TIMEOUT
				if now.Sub(session.UpdatedAt) > SESSION_TIMEOUT {
					shouldCleanup = true
				}
			default:
				// Clean up stale active sessions
				if now.Sub(session.UpdatedAt) > SESSION_TIMEOUT {
					shouldCleanup = true
				}
			}

			if shouldCleanup {
				log.Printf("🧹 Cleaning up session: %s (state: %s, age: %v)", id, session.State, now.Sub(session.CreatedAt))

				// Abort S3 multipart upload if not completed
				if session.UploadID != "" && session.State != STATE_COMPLETED {
					_, err := sm.s3Client.client.AbortMultipartUpload(context.Background(), &s3.AbortMultipartUploadInput{
						Bucket:   aws.String(sm.s3Client.bucket),
						Key:      aws.String(session.S3Key),
						UploadId: aws.String(session.UploadID),
					})
					if err != nil {
						log.Printf("⚠️  Failed to abort multipart upload for session %s: %v", id, err)
					}
				}

				delete(sm.sessions, id)
			}
		}
		sm.mu.Unlock()
	}
}

// ============================================
// File Upload Server (gnet)
// ============================================

type FileUploadServer struct {
	gnet.BuiltinEventEngine

	sessionMgr *SessionManager
	s3Client   *S3Client
	authMgr    *AuthManager
}

type ClientContext struct {
	buffer      []byte
	session     *UploadSession
	userID      string
	username    string
	mu          sync.Mutex
}

func (fus *FileUploadServer) OnBoot(eng gnet.Engine) (action gnet.Action) {
	log.Printf("🚀 File upload server started on %s", GNET_PORT)
	log.Printf("📦 S3: %s/%s", S3_ENDPOINT, S3_BUCKET)
	log.Printf("📁 Upload path format: user_id/timestamp/filename")
	log.Printf("📄 Supported formats: mp4, pdf, jpg, png, gif, webp, mov, avi, mkv")
	log.Printf("📊 Max file size: %.2f GB, Chunk size: %d-%d MB",
		float64(MAX_FILE_SIZE)/(1024*1024*1024),
		MIN_CHUNK_SIZE/(1024*1024),
		MAX_CHUNK_SIZE/(1024*1024))
	return gnet.None
}

func (fus *FileUploadServer) OnOpen(c gnet.Conn) (out []byte, action gnet.Action) {
	log.Printf("✅ Client connected: %s", c.RemoteAddr())

	ctx := &ClientContext{
		buffer: make([]byte, 0, 8192),
	}
	c.SetContext(ctx)

	return nil, gnet.None
}

func (fus *FileUploadServer) OnTraffic(c gnet.Conn) (action gnet.Action) {
	ctx := c.Context().(*ClientContext)

	// Read all available data
	data, err := c.Next(-1)
	if err != nil {
		log.Printf("❌ Error reading data: %v", err)
		return gnet.Close
	}

	ctx.mu.Lock()
	ctx.buffer = append(ctx.buffer, data...)
	ctx.mu.Unlock()

	// Process messages
	for {
		ctx.mu.Lock()
		bufLen := len(ctx.buffer)
		ctx.mu.Unlock()

		if bufLen < 4 {
			break // Need at least auth token size
		}

		ctx.mu.Lock()
		authTokenSize := binary.BigEndian.Uint32(ctx.buffer[0:4])
		ctx.mu.Unlock()

		if authTokenSize > 1024 {
			log.Printf("❌ Invalid auth token size: %d", authTokenSize)
			c.AsyncWrite(fus.errorResponse("Invalid auth token size"), nil)
			return gnet.Close
		}

		headerSize := 4 + int(authTokenSize) + 4
		if bufLen < headerSize {
			break // Need complete header
		}

		ctx.mu.Lock()
		authToken := string(ctx.buffer[4 : 4+authTokenSize])
		payloadSize := binary.BigEndian.Uint32(ctx.buffer[4+authTokenSize : headerSize])
		ctx.mu.Unlock()

		totalSize := headerSize + int(payloadSize)
		if bufLen < totalSize {
			break // Need complete message
		}

		// Authenticate
		tokenInfo, valid := fus.authMgr.ValidateToken(authToken)
		if !valid {
			log.Printf("❌ Authentication failed for token: %s", authToken)
			c.AsyncWrite(fus.authFailedResponse(), nil)

			ctx.mu.Lock()
			ctx.buffer = ctx.buffer[totalSize:]
			ctx.mu.Unlock()
			continue
		}

		ctx.userID = tokenInfo.UserID
		ctx.username = tokenInfo.Username

		// Extract payload
		ctx.mu.Lock()
		payload := ctx.buffer[headerSize:totalSize]
		ctx.mu.Unlock()

		if len(payload) < 1 {
			log.Printf("❌ Empty payload")
			c.AsyncWrite(fus.errorResponse("Empty payload"), nil)

			ctx.mu.Lock()
			ctx.buffer = ctx.buffer[totalSize:]
			ctx.mu.Unlock()
			continue
		}

		// Process command
		cmd := payload[0]
		cmdData := payload[1:]

		var response []byte
		switch cmd {
		case CMD_INIT_UPLOAD:
			response = fus.handleInitUpload(ctx, cmdData)
		case CMD_UPLOAD_CHUNK:
			response = fus.handleUploadChunk(ctx, cmdData)
		case CMD_PAUSE_UPLOAD:
			response = fus.handlePauseUpload(ctx, cmdData)
		case CMD_RESUME_UPLOAD:
			response = fus.handleResumeUpload(ctx, cmdData)
		case CMD_CANCEL_UPLOAD:
			response = fus.handleCancelUpload(ctx, cmdData)
		case CMD_GET_STATUS:
			response = fus.handleGetStatus(ctx, cmdData)
		default:
			log.Printf("❌ Unknown command: 0x%02x", cmd)
			response = fus.errorResponse(fmt.Sprintf("Unknown command: 0x%02x", cmd))
		}

		c.AsyncWrite(response, nil)

		// Remove processed message
		ctx.mu.Lock()
		ctx.buffer = ctx.buffer[totalSize:]
		ctx.mu.Unlock()
	}

	return gnet.None
}

// CMD_INIT_UPLOAD: filename_size(2) | filename | total_chunks(4) | chunk_size(4)
func (fus *FileUploadServer) handleInitUpload(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid INIT_UPLOAD: missing filename size")
	}

	fileNameSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+fileNameSize+4+4) {
		return fus.errorResponse("Invalid INIT_UPLOAD: incomplete data")
	}

	fileName := string(data[2 : 2+fileNameSize])
	totalChunks := binary.BigEndian.Uint32(data[2+fileNameSize : 2+fileNameSize+4])
	chunkSize := binary.BigEndian.Uint32(data[2+fileNameSize+4 : 2+fileNameSize+8])

	log.Printf("📥 INIT_UPLOAD: user=%s, file=%s, chunks=%d, chunk_size=%d MB",
		ctx.username, fileName, totalChunks, chunkSize/(1024*1024))

	// Create session
	session, err := fus.sessionMgr.CreateSession(ctx.userID, ctx.username, fileName, totalChunks, chunkSize)
	if err != nil {
		log.Printf("❌ Failed to create session: %v", err)
		return fus.errorResponse(err.Error())
	}

	ctx.session = session

	// Initialize S3 multipart upload
	result, err := fus.s3Client.client.CreateMultipartUpload(
		context.Background(),
		&s3.CreateMultipartUploadInput{
			Bucket:      aws.String(fus.s3Client.bucket),
			Key:         aws.String(session.S3Key),
			ContentType: aws.String(session.ContentType),
		},
	)
	if err != nil {
		log.Printf("❌ Failed to initialize S3 multipart upload: %v", err)
		return fus.errorResponse(err.Error())
	}

	session.UploadID = *result.UploadId
	log.Printf("✅ S3 multipart upload initialized: %s (path: %s)", session.UploadID, session.S3Key)

	// Response: RESP_READY | session_id_size(2) | session_id | s3_key_size(2) | s3_key
	sessionIDBytes := []byte(session.SessionID)
	s3KeyBytes := []byte(session.S3Key)

	response := make([]byte, 1+2+len(sessionIDBytes)+2+len(s3KeyBytes))
	response[0] = RESP_READY
	binary.BigEndian.PutUint16(response[1:3], uint16(len(sessionIDBytes)))
	copy(response[3:3+len(sessionIDBytes)], sessionIDBytes)
	binary.BigEndian.PutUint16(response[3+len(sessionIDBytes):5+len(sessionIDBytes)], uint16(len(s3KeyBytes)))
	copy(response[5+len(sessionIDBytes):], s3KeyBytes)

	return response
}

func (fus *FileUploadServer) handleUploadChunk(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid UPLOAD_CHUNK: missing session ID size")
	}

	sessionIDSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+sessionIDSize+4+4) {
		return fus.errorResponse("Invalid UPLOAD_CHUNK: incomplete header")
	}

	sessionID := string(data[2 : 2+sessionIDSize])
	chunkIndex := binary.BigEndian.Uint32(data[2+sessionIDSize : 2+sessionIDSize+4])
	chunkSize := binary.BigEndian.Uint32(data[2+sessionIDSize+4 : 2+sessionIDSize+8])

	// FIX: Cast to int to avoid type mismatch
	headerSize := int(2 + sessionIDSize + 8)
	totalSize := headerSize + int(chunkSize)

	if len(data) < totalSize {
		return fus.errorResponse("Invalid UPLOAD_CHUNK: incomplete chunk data")
	}

	chunkData := data[headerSize:totalSize]

	// Verify session
	session := fus.sessionMgr.GetSession(sessionID)
	if session == nil {
		return fus.errorResponse("Invalid session ID")
	}

	if session.UserID != ctx.userID {
		return fus.errorResponse("Session does not belong to user")
	}

	if session.State == STATE_PAUSED {
		return fus.errorResponse("Upload is paused. Resume first.")
	}

	if session.State == STATE_CANCELLED {
		return fus.errorResponse("Upload was cancelled")
	}

	// Calculate chunk hash
	hash := sha256.Sum256(chunkData)
	hashStr := hex.EncodeToString(hash[:])

	// Upload chunk to S3
	partNumber := int32(chunkIndex) + 1

	result, err := fus.s3Client.client.UploadPart(
		context.Background(),
		&s3.UploadPartInput{
			Bucket:     aws.String(fus.s3Client.bucket),
			Key:        aws.String(session.S3Key),
			UploadId:   aws.String(session.UploadID),
			PartNumber: aws.Int32(partNumber),
			Body:       bytes.NewReader(chunkData),
		},
	)
	if err != nil {
		log.Printf("❌ Failed to upload part %d: %v", partNumber, err)
		return fus.errorResponse(fmt.Sprintf("S3 upload failed: %v", err))
	}

	// Add chunk to session
	isDuplicate := session.AddChunk(chunkIndex, chunkSize, hashStr, partNumber, *result.ETag)

	received, total := session.GetProgress()
	log.Printf("📦 Chunk %d/%d uploaded (%.1f%%, hash: %s, etag: %s)",
		received, total, float64(received)/float64(total)*100, hashStr[:8], *result.ETag)

	// Check if upload is complete
	if session.IsComplete() {
		return fus.finalizeUpload(session)
	}

	// Response
	if isDuplicate {
		// RESP_DUPLICATE | chunk_index(4) | progress(4)
		response := make([]byte, 9)
		response[0] = RESP_DUPLICATE
		binary.BigEndian.PutUint32(response[1:5], chunkIndex)
		binary.BigEndian.PutUint32(response[5:9], received)
		return response
	}

	// RESP_CHUNK_ACK | chunk_index(4) | progress(4) | total(4)
	response := make([]byte, 13)
	response[0] = RESP_CHUNK_ACK
	binary.BigEndian.PutUint32(response[1:5], chunkIndex)
	binary.BigEndian.PutUint32(response[5:9], received)
	binary.BigEndian.PutUint32(response[9:13], total)

	return response
}

// CMD_PAUSE_UPLOAD: session_id_size(2) | session_id
func (fus *FileUploadServer) handlePauseUpload(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid PAUSE_UPLOAD: missing session ID size")
	}

	sessionIDSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+sessionIDSize) {
		return fus.errorResponse("Invalid PAUSE_UPLOAD: incomplete data")
	}

	sessionID := string(data[2 : 2+sessionIDSize])

	session := fus.sessionMgr.GetSession(sessionID)
	if session == nil {
		return fus.errorResponse("Invalid session ID")
	}

	if session.UserID != ctx.userID {
		return fus.errorResponse("Session does not belong to user")
	}

	session.Pause()
	received, total := session.GetProgress()

	log.Printf("⏸️  Upload paused: session=%s, progress=%d/%d", sessionID, received, total)

	// Response: RESP_PAUSED | received(4) | total(4)
	response := make([]byte, 9)
	response[0] = RESP_PAUSED
	binary.BigEndian.PutUint32(response[1:5], received)
	binary.BigEndian.PutUint32(response[5:9], total)

	return response
}

// CMD_RESUME_UPLOAD: session_id_size(2) | session_id
func (fus *FileUploadServer) handleResumeUpload(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid RESUME_UPLOAD: missing session ID size")
	}

	sessionIDSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+sessionIDSize) {
		return fus.errorResponse("Invalid RESUME_UPLOAD: incomplete data")
	}

	sessionID := string(data[2 : 2+sessionIDSize])

	session := fus.sessionMgr.GetSession(sessionID)
	if session == nil {
		return fus.errorResponse("Invalid session ID")
	}

	if session.UserID != ctx.userID {
		return fus.errorResponse("Session does not belong to user")
	}

	if session.State != STATE_PAUSED {
		return fus.errorResponse("Upload is not paused")
	}

	session.Resume()
	received, total := session.GetProgress()
	missing := session.GetMissingChunks()

	log.Printf("▶️  Upload resumed: session=%s, progress=%d/%d, missing=%d", sessionID, received, total, len(missing))

	// Response: RESP_RESUMED | received(4) | total(4) | missing_count(4) | missing_chunks...
	response := make([]byte, 13+len(missing)*4)
	response[0] = RESP_RESUMED
	binary.BigEndian.PutUint32(response[1:5], received)
	binary.BigEndian.PutUint32(response[5:9], total)
	binary.BigEndian.PutUint32(response[9:13], uint32(len(missing)))

	for i, chunkIdx := range missing {
		binary.BigEndian.PutUint32(response[13+i*4:13+(i+1)*4], chunkIdx)
	}

	return response
}

// CMD_CANCEL_UPLOAD: session_id_size(2) | session_id
func (fus *FileUploadServer) handleCancelUpload(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid CANCEL_UPLOAD: missing session ID size")
	}

	sessionIDSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+sessionIDSize) {
		return fus.errorResponse("Invalid CANCEL_UPLOAD: incomplete data")
	}

	sessionID := string(data[2 : 2+sessionIDSize])

	session := fus.sessionMgr.GetSession(sessionID)
	if session == nil {
		return fus.errorResponse("Invalid session ID")
	}

	if session.UserID != ctx.userID {
		return fus.errorResponse("Session does not belong to user")
	}

	session.Cancel()

	log.Printf("🛑 Upload cancelled: session=%s", sessionID)

	// Abort S3 multipart upload
	if session.UploadID != "" {
		_, err := fus.s3Client.client.AbortMultipartUpload(context.Background(), &s3.AbortMultipartUploadInput{
			Bucket:   aws.String(fus.s3Client.bucket),
			Key:      aws.String(session.S3Key),
			UploadId: aws.String(session.UploadID),
		})
		if err != nil {
			log.Printf("⚠️  Failed to abort S3 upload: %v", err)
		}
	}

	// Clean up session
	fus.sessionMgr.DeleteSession(sessionID)

	// Response: RESP_CANCELLED
	return []byte{RESP_CANCELLED}
}

// CMD_GET_STATUS: session_id_size(2) | session_id
func (fus *FileUploadServer) handleGetStatus(ctx *ClientContext, data []byte) []byte {
	if len(data) < 2 {
		return fus.errorResponse("Invalid GET_STATUS: missing session ID size")
	}

	sessionIDSize := binary.BigEndian.Uint16(data[0:2])
	if len(data) < int(2+sessionIDSize) {
		return fus.errorResponse("Invalid GET_STATUS: incomplete data")
	}

	sessionID := string(data[2 : 2+sessionIDSize])

	session := fus.sessionMgr.GetSession(sessionID)
	if session == nil {
		return fus.errorResponse("Invalid session ID")
	}

	if session.UserID != ctx.userID {
		return fus.errorResponse("Session does not belong to user")
	}

	received, total := session.GetProgress()
	stateBytes := []byte(session.State)

	// Response: RESP_STATUS | state_size(1) | state | received(4) | total(4)
	response := make([]byte, 1+1+len(stateBytes)+4+4)
	response[0] = RESP_STATUS
	response[1] = byte(len(stateBytes))
	copy(response[2:2+len(stateBytes)], stateBytes)
	binary.BigEndian.PutUint32(response[2+len(stateBytes):6+len(stateBytes)], received)
	binary.BigEndian.PutUint32(response[6+len(stateBytes):10+len(stateBytes)], total)

	return response
}

func (fus *FileUploadServer) finalizeUpload(session *UploadSession) []byte {
	log.Printf("🔄 Finalizing upload: session=%s, file=%s, parts=%d", session.SessionID, session.FileName, len(session.CompletedParts))

	// Complete S3 multipart upload
	_, err := fus.s3Client.client.CompleteMultipartUpload(
		context.Background(),
		&s3.CompleteMultipartUploadInput{
			Bucket:   aws.String(fus.s3Client.bucket),
			Key:      aws.String(session.S3Key),
			UploadId: aws.String(session.UploadID),
			MultipartUpload: &types.CompletedMultipartUpload{
				Parts: session.CompletedParts,
			},
		},
	)
	if err != nil {
		log.Printf("❌ Failed to complete S3 upload: %v", err)
		session.State = STATE_FAILED
		return fus.errorResponse(fmt.Sprintf("Failed to complete upload: %v", err))
	}

	session.mu.Lock()
	session.State = STATE_COMPLETED
	session.UpdatedAt = time.Now()
	session.mu.Unlock()

	log.Printf("✅ Upload completed: file=%s, size=%.2f MB, s3_key=%s",
		session.FileName, float64(session.TotalSize)/(1024*1024), session.S3Key)

	// Response: RESP_COMPLETE | s3_key_size(2) | s3_key | file_size(8)
	s3KeyBytes := []byte(session.S3Key)
	response := make([]byte, 1+2+len(s3KeyBytes)+8)
	response[0] = RESP_COMPLETE
	binary.BigEndian.PutUint16(response[1:3], uint16(len(s3KeyBytes)))
	copy(response[3:3+len(s3KeyBytes)], s3KeyBytes)
	binary.BigEndian.PutUint64(response[3+len(s3KeyBytes):], session.TotalSize)

	return response
}

func (fus *FileUploadServer) errorResponse(message string) []byte {
	msgBytes := []byte(message)
	if len(msgBytes) > 255 {
		msgBytes = msgBytes[:255]
	}

	response := make([]byte, 2+len(msgBytes))
	response[0] = RESP_ERROR
	response[1] = byte(len(msgBytes))
	copy(response[2:], msgBytes)

	return response
}

func (fus *FileUploadServer) authFailedResponse() []byte {
	return []byte{RESP_AUTH_FAILED}
}

func (fus *FileUploadServer) OnClose(c gnet.Conn, err error) (action gnet.Action) {
	if err != nil {
		log.Printf("❌ Client disconnected with error: %v", err)
	} else {
		log.Printf("👋 Client disconnected: %s", c.RemoteAddr())
	}
	return gnet.None
}

// ============================================
// Main
// ============================================

func main() {
	log.Printf("🚀 Starting advanced file upload server")
	log.Printf("📁 S3 path format: user_id/timestamp/filename")
	log.Printf("📄 Supported: MP4, PDF, Images (up to 10GB)")

	// Initialize S3 client
	s3Client, err := NewS3Client()
	if err != nil {
		log.Fatalf("❌ Failed to initialize S3: %v", err)
	}
	log.Printf("✅ S3 client initialized")

	// Initialize auth manager
	authMgr := NewAuthManager()

	// Create session manager
	sessionMgr := NewSessionManager(s3Client, authMgr)

	// Start gnet server
	fileServer := &FileUploadServer{
		sessionMgr: sessionMgr,
		s3Client:   s3Client,
		authMgr:    authMgr,
	}

	// FIX: Remove WithEdgeTriggeredIO as it might not be available in your gnet version
	log.Fatal(gnet.Run(fileServer, fmt.Sprintf("tcp://%s", GNET_PORT),
		gnet.WithMulticore(true),
		gnet.WithReusePort(true),
		gnet.WithReadBufferCap(64*1024*1024), // 64MB read buffer for large chunks
		gnet.WithWriteBufferCap(4*1024*1024), // 4MB write buffer
	))
}
