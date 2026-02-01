// simple_upload_server.go - Fixed Idempotency & Preview Headers
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/gorilla/mux"
	"github.com/rs/cors"
)

// ============================================
// Configuration
// ============================================

const (
	HTTP_PORT = ":8085"

	S3_REGION = "us-east-1"
	S3_BUCKET = "uploads"

	// File constraints
	MAX_FILE_SIZE  = 10 * 1024 * 1024 * 1024 // 10 GB
	MIN_CHUNK_SIZE = 5 * 1024 * 1024         // 5 MB
	MAX_CHUNK_SIZE = 100 * 1024 * 1024       // 100 MB

	// Timeouts
	SESSION_TIMEOUT = 2 * time.Hour
	TOKEN_LIFETIME  = 5 * time.Minute
)

// Get S3 configuration from environment variables with defaults
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

var (
	S3_ENDPOINT   = getEnv("S3_ENDPOINT", "http://localhost:9000")
	S3_ACCESS_KEY = getEnv("S3_ACCESS_KEY", "admin")
	S3_SECRET_KEY = getEnv("S3_SECRET_KEY", "strongpassword")
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
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".m4a":  "audio/mp4",
}

// ============================================
// Helper Functions
// ============================================

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	log.Printf("❌ Error: %s", message)
	respondJSON(w, status, map[string]string{"error": message})
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
// Streaming Token Manager
// ============================================

type StreamingToken struct {
	Token     string
	EmailID   string
	S3Key     string
	ExpiresAt time.Time
}

type TokenManager struct {
	tokens map[string]*StreamingToken
	mu     sync.RWMutex
}

func NewTokenManager() *TokenManager {
	tm := &TokenManager{
		tokens: make(map[string]*StreamingToken),
	}
	go tm.cleanupExpiredTokens()
	return tm
}

func (tm *TokenManager) CreateStreamingToken(emailID, s3Key string) string {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	tokenData := fmt.Sprintf("%s:%s:%d", emailID, s3Key, time.Now().UnixNano())
	hash := sha256.Sum256([]byte(tokenData))
	token := hex.EncodeToString(hash[:])

	tm.tokens[token] = &StreamingToken{
		Token:     token,
		EmailID:   emailID,
		S3Key:     s3Key,
		ExpiresAt: time.Now().Add(TOKEN_LIFETIME),
	}

	log.Printf("🎫 Created streaming token for user %s (expires in %v)", emailID, TOKEN_LIFETIME)
	return token
}

func (tm *TokenManager) ValidateStreamingToken(token string) (*StreamingToken, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	st, exists := tm.tokens[token]
	if !exists {
		return nil, false
	}

	if time.Now().After(st.ExpiresAt) {
		return nil, false
	}

	return st, true
}

func (tm *TokenManager) cleanupExpiredTokens() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		tm.mu.Lock()
		now := time.Now()

		for token, st := range tm.tokens {
			if now.After(st.ExpiresAt) {
				delete(tm.tokens, token)
			}
		}
		tm.mu.Unlock()
	}
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
	EmailID        string
	FileName       string
	S3Key          string
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
	mu             sync.Mutex
}

func (us *UploadSession) AddChunk(index uint32, size uint32, hash string, partNumber int32, etag string) bool {
	us.mu.Lock()
	defer us.mu.Unlock()

	if existing, exists := us.ReceivedChunks[index]; exists {
		if existing.Hash == hash {
			return true
		}
		log.Printf("❌ Hash mismatch for chunk %d", index)
		return false
	}

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

	us.UpdatedAt = time.Now()
	return false
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

// ============================================
// Session Manager
// ============================================

type SessionManager struct {
	sessions map[string]*UploadSession
	mu       sync.RWMutex
	s3Client *S3Client
}

func NewSessionManager(s3Client *S3Client) *SessionManager {
	sm := &SessionManager{
		sessions: make(map[string]*UploadSession),
		s3Client: s3Client,
	}
	go sm.cleanupLoop()
	return sm
}

func (sm *SessionManager) CreateSession(emailID, fileName string, totalChunks, chunkSize uint32, totalSize uint64) (*UploadSession, error) {
	ext := strings.ToLower(filepath.Ext(fileName))
	contentType, supported := SUPPORTED_EXTENSIONS[ext]
	if !supported {
		return nil, fmt.Errorf("unsupported file type: %s", ext)
	}

	if totalSize > MAX_FILE_SIZE {
		return nil, fmt.Errorf("file size exceeds maximum: %d bytes", totalSize)
	}

	timestamp := time.Now().Format("20060102_150405")
	s3Key := fmt.Sprintf("%s/%s/%s", emailID, timestamp, fileName)
	sessionID := fmt.Sprintf("%s_%d", emailID, time.Now().UnixNano())

	sm.mu.Lock()
	defer sm.mu.Unlock()

	session := &UploadSession{
		SessionID:      sessionID,
		EmailID:        emailID,
		FileName:       fileName,
		S3Key:          s3Key,
		FileExtension:  ext,
		ContentType:    contentType,
		TotalChunks:    totalChunks,
		ChunkSize:      chunkSize,
		TotalSize:      totalSize,
		State:          "initialized",
		ReceivedChunks: make(map[uint32]*ChunkInfo),
		CompletedParts: make([]types.CompletedPart, 0),
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	sm.sessions[sessionID] = session
	log.Printf("📦 Created session: %s (email: %s, file: %s, size: %.2f MB)",
		sessionID, emailID, fileName, float64(totalSize)/(1024*1024))

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
			if now.Sub(session.UpdatedAt) > SESSION_TIMEOUT {
				log.Printf("🧹 Cleaning up session: %s", id)
				if session.UploadID != "" && session.State != "completed" {
					sm.s3Client.client.AbortMultipartUpload(context.Background(), &s3.AbortMultipartUploadInput{
						Bucket:   aws.String(sm.s3Client.bucket),
						Key:      aws.String(session.S3Key),
						UploadId: aws.String(session.UploadID),
					})
				}
				delete(sm.sessions, id)
			}
		}
		sm.mu.Unlock()
	}
}

// ============================================
// HTTP Handlers
// ============================================

type Server struct {
	sessionMgr *SessionManager
	s3Client   *S3Client
	tokenMgr   *TokenManager
}

func (s *Server) handleInitUpload(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Received init upload request from %s", r.RemoteAddr)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}

	var req struct {
		EmailID     string `json:"email_id"`
		Filename    string `json:"filename"`
		FileSize    uint64 `json:"file_size"`
		TotalChunks uint32 `json:"total_chunks"`
		ChunkSize   uint32 `json:"chunk_size"`
	}

	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		respondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	if req.EmailID == "" {
		respondError(w, http.StatusBadRequest, "email_id is required")
		return
	}

	if req.Filename == "" {
		respondError(w, http.StatusBadRequest, "filename is required")
		return
	}

	session, err := s.sessionMgr.CreateSession(req.EmailID, req.Filename, req.TotalChunks, req.ChunkSize, req.FileSize)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := s.s3Client.client.CreateMultipartUpload(context.Background(), &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(s.s3Client.bucket),
		Key:         aws.String(session.S3Key),
		ContentType: aws.String(session.ContentType),
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to initialize S3 upload: %v", err))
		return
	}

	session.UploadID = *result.UploadId
	log.Printf("✅ S3 multipart upload initialized: %s", session.UploadID)

	respondJSON(w, http.StatusOK, map[string]string{
		"session_id": session.SessionID,
		"s3_key":     session.S3Key,
		"upload_id":  session.UploadID,
	})
}

func (s *Server) handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	emailID := r.FormValue("email_id")
	sessionID := r.FormValue("session_id")
	chunkIndexStr := r.FormValue("chunk_index")

	if emailID == "" {
		respondError(w, http.StatusBadRequest, "email_id is required")
		return
	}

	chunkIndex, _ := strconv.ParseUint(chunkIndexStr, 10, 32)
	session := s.sessionMgr.GetSession(sessionID)
	if session == nil {
		respondError(w, http.StatusBadRequest, "Invalid session ID")
		return
	}

	if session.EmailID != emailID {
		respondError(w, http.StatusForbidden, "Unauthorized: email_id mismatch")
		return
	}

	file, _, err := r.FormFile("chunk")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to read chunk")
		return
	}
	defer file.Close()

	chunkData, err := io.ReadAll(file)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read chunk data")
		return
	}

	hash := sha256.Sum256(chunkData)
	hashStr := hex.EncodeToString(hash[:])
	partNumber := int32(chunkIndex) + 1

	result, err := s.s3Client.client.UploadPart(context.Background(), &s3.UploadPartInput{
		Bucket:     aws.String(s.s3Client.bucket),
		Key:        aws.String(session.S3Key),
		UploadId:   aws.String(session.UploadID),
		PartNumber: aws.Int32(partNumber),
		Body:       bytes.NewReader(chunkData),
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, fmt.Sprintf("S3 upload failed: %v", err))
		return
	}

	isDuplicate := session.AddChunk(uint32(chunkIndex), uint32(len(chunkData)), hashStr, partNumber, *result.ETag)
	received, total := session.GetProgress()

	log.Printf("📦 Chunk %d/%d uploaded (%.1f%%)", received, total, float64(received)/float64(total)*100)

	// Auto-finalize if complete (handling this cleanly in finalizeUpload for idempotency)
	if session.IsComplete() {
		s.finalizeUpload(w, session)
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":     true,
		"duplicate":   isDuplicate,
		"chunk_index": chunkIndex,
		"received":    received,
		"total":       total,
		"progress":    float64(received) / float64(total) * 100,
	})
}

// FIX: Made this function idempotent to prevent "NoSuchUpload" on double calls
func (s *Server) finalizeUpload(w http.ResponseWriter, session *UploadSession) {
	session.mu.Lock()
	if session.State == "completed" {
		session.mu.Unlock()
		log.Printf("⚠️ Upload %s already completed, returning cached success", session.SessionID)
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"success":   true,
			"completed": true,
			"s3_key":    session.S3Key,
			"file_size": session.TotalSize,
		})
		return
	}

	if session.State == "finalizing" {
		session.mu.Unlock()
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"success":   true,
			"completed": true,
			"status":    "finalizing",
		})
		return
	}

	session.State = "finalizing"
	session.mu.Unlock()

	log.Printf("🔄 Finalizing upload: %s", session.SessionID)

	_, err := s.s3Client.client.CompleteMultipartUpload(context.Background(), &s3.CompleteMultipartUploadInput{
		Bucket:   aws.String(s.s3Client.bucket),
		Key:      aws.String(session.S3Key),
		UploadId: aws.String(session.UploadID),
		MultipartUpload: &types.CompletedMultipartUpload{
			Parts: session.CompletedParts,
		},
	})

	if err != nil {
		// If it failed, it might have been completed by another thread or process
		// But in most cases, this is a genuine error or the ID is invalid.
		// For robustness, if it's "NoSuchUpload", we could check if object exists,
		// but typically we should just error or reset.

		// Reset state to allow retry if it was a network glitch
		session.mu.Lock()
		session.State = "initialized"
		session.mu.Unlock()

		respondError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to complete upload: %v", err))
		return
	}

	session.mu.Lock()
	session.State = "completed"
	session.UpdatedAt = time.Now()
	session.mu.Unlock()

	log.Printf("✅ Upload completed: %s", session.FileName)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"completed": true,
		"s3_key":    session.S3Key,
		"file_size": session.TotalSize,
	})
}

func (s *Server) handleCompleteUpload(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}

	var req struct {
		EmailID   string `json:"email_id"`
		SessionID string `json:"session_id"`
	}

	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		respondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	session := s.sessionMgr.GetSession(req.SessionID)
	if session == nil {
		respondError(w, http.StatusBadRequest, "Invalid session ID")
		return
	}

	if session.EmailID != req.EmailID {
		respondError(w, http.StatusForbidden, "Unauthorized: email_id mismatch")
		return
	}

	if !session.IsComplete() {
		respondError(w, http.StatusBadRequest, "Upload not complete")
		return
	}

	s.finalizeUpload(w, session)
}

func (s *Server) handleCancelUpload(w http.ResponseWriter, r *http.Request) {
	log.Printf("🚫 Received cancel upload request")

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}

	var req struct {
		EmailID   string `json:"email_id"`
		SessionID string `json:"session_id"`
	}

	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		respondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	session := s.sessionMgr.GetSession(req.SessionID)
	if session == nil {
		respondJSON(w, http.StatusOK, map[string]string{"status": "session_not_found_or_already_deleted"})
		return
	}

	if session.EmailID != req.EmailID {
		respondError(w, http.StatusForbidden, "Unauthorized: email_id mismatch")
		return
	}

	if session.UploadID != "" {
		_, err := s.s3Client.client.AbortMultipartUpload(context.Background(), &s3.AbortMultipartUploadInput{
			Bucket:   aws.String(s.s3Client.bucket),
			Key:      aws.String(session.S3Key),
			UploadId: aws.String(session.UploadID),
		})
		if err != nil {
			log.Printf("⚠️ Failed to abort S3 upload: %v", err)
		} else {
			log.Printf("✅ S3 upload aborted for session: %s", req.SessionID)
		}
	}

	s.sessionMgr.DeleteSession(req.SessionID)
	respondJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	emailID := r.URL.Query().Get("email_id")
	if emailID == "" {
		respondError(w, http.StatusBadRequest, "email_id is required")
		return
	}

	prefix := emailID + "/"
	result, err := s.s3Client.client.ListObjectsV2(context.Background(), &s3.ListObjectsV2Input{
		Bucket: aws.String(s.s3Client.bucket),
		Prefix: aws.String(prefix),
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to list files: %v", err))
		return
	}

	files := make([]map[string]interface{}, 0)
	for _, obj := range result.Contents {
		files = append(files, map[string]interface{}{
			"key":           *obj.Key,
			"size":          *obj.Size,
			"last_modified": obj.LastModified,
		})
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"files": files,
		"count": len(files),
	})
}

func (s *Server) handleRequestStreamingToken(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to read request body")
		return
	}

	var req struct {
		EmailID string `json:"email_id"`
		S3Key   string `json:"s3_key"`
	}

	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		respondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	if req.EmailID == "" {
		respondError(w, http.StatusBadRequest, "email_id is required")
		return
	}

	if !strings.HasPrefix(req.S3Key, req.EmailID+"/") {
		respondError(w, http.StatusForbidden, "Unauthorized")
		return
	}

	token := s.tokenMgr.CreateStreamingToken(req.EmailID, req.S3Key)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"token":      token,
		"expires_in": int(TOKEN_LIFETIME.Seconds()),
		"s3_key":     req.S3Key,
	})
}

func (s *Server) handleStreamFile(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		respondError(w, http.StatusUnauthorized, "Missing streaming token")
		return
	}

	streamingToken, valid := s.tokenMgr.ValidateStreamingToken(token)
	if !valid {
		respondError(w, http.StatusForbidden, "Invalid or expired streaming token")
		return
	}

	s3Key := streamingToken.S3Key

	headResult, err := s.s3Client.client.HeadObject(context.Background(), &s3.HeadObjectInput{
		Bucket: aws.String(s.s3Client.bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		respondError(w, http.StatusNotFound, "File not found")
		return
	}

	fileSize := *headResult.ContentLength
	contentType := ""
	if headResult.ContentType != nil {
		contentType = *headResult.ContentType
	}
	if contentType == "" || contentType == "application/octet-stream" {
		ext := strings.ToLower(filepath.Ext(s3Key))
		if ct, ok := SUPPORTED_EXTENSIONS[ext]; ok {
			contentType = ct
		}
	}

	// FIX: Force inline content disposition for preview support
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=\"%s\"", filepath.Base(s3Key)))

	rangeHeader := r.Header.Get("Range")
	if rangeHeader != "" {
		var start, end int64
		fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end)
		if end == 0 || end >= fileSize {
			end = fileSize - 1
		}

		result, err := s.s3Client.client.GetObject(context.Background(), &s3.GetObjectInput{
			Bucket: aws.String(s.s3Client.bucket),
			Key:    aws.String(s3Key),
			Range:  aws.String(fmt.Sprintf("bytes=%d-%d", start, end)),
		})
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to stream file")
			return
		}
		defer result.Body.Close()

		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)

		io.Copy(w, result.Body)
		return
	}

	result, err := s.s3Client.client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String(s.s3Client.bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to stream file")
		return
	}
	defer result.Body.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(fileSize, 10))

	io.Copy(w, result.Body)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "healthy", "time": time.Now().Format(time.RFC3339)})
}

func main() {
	log.Printf("🚀 Starting Fixed Upload Server (Idempotent)")
	s3Client, err := NewS3Client()
	if err != nil {
		log.Fatalf("❌ Failed to initialize S3: %v", err)
	}

	tokenMgr := NewTokenManager()
	sessionMgr := NewSessionManager(s3Client)
	server := &Server{sessionMgr: sessionMgr, s3Client: s3Client, tokenMgr: tokenMgr}

	router := mux.NewRouter()
	router.HandleFunc("/health", server.handleHealth).Methods("GET", "OPTIONS")
	router.HandleFunc("/upload/init", server.handleInitUpload).Methods("POST", "OPTIONS")
	router.HandleFunc("/upload/chunk", server.handleUploadChunk).Methods("POST", "OPTIONS")
	router.HandleFunc("/upload/complete", server.handleCompleteUpload).Methods("POST", "OPTIONS")
	router.HandleFunc("/upload/cancel", server.handleCancelUpload).Methods("POST", "OPTIONS")
	router.HandleFunc("/files", server.handleListFiles).Methods("GET", "OPTIONS")
	router.HandleFunc("/files/streaming-token", server.handleRequestStreamingToken).Methods("POST", "OPTIONS")
	router.HandleFunc("/stream", server.handleStreamFile).Methods("GET", "OPTIONS")

	c := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders: []string{"*"},
		ExposedHeaders: []string{"Content-Length", "Content-Type", "Content-Range", "Accept-Ranges", "Content-Disposition"},
		AllowCredentials: false,
		MaxAge: 86400,
	})

	log.Printf("✅ Server listening on %s", HTTP_PORT)
	if err := http.ListenAndServe(HTTP_PORT, c.Handler(router)); err != nil {
		log.Fatalf("❌ Server failed: %v", err)
	}
}
