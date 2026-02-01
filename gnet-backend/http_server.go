// simple_upload_server.go - Simplified file upload server with JWT token reading
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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

	S3_ENDPOINT   = "http://minio:9000"
	S3_REGION     = "us-east-1"
	S3_ACCESS_KEY = "admin"
	S3_SECRET_KEY = "strongpassword"
	S3_BUCKET     = "uploads"

	// File constraints
	MAX_FILE_SIZE  = 10 * 1024 * 1024 * 1024 // 10 GB
	MIN_CHUNK_SIZE = 5 * 1024 * 1024         // 5 MB
	MAX_CHUNK_SIZE = 100 * 1024 * 1024       // 100 MB

	// Timeouts
	SESSION_TIMEOUT = 2 * time.Hour
	TOKEN_LIFETIME  = 5 * time.Minute
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
// JWT Token (No Signature Verification)
// ============================================

type JWTClaims struct {
	Sub      string `json:"sub"`       // email_id
	PublicID string `json:"public_id"` // user's public_id (we'll use this as user_id)
	Role     string `json:"role"`      // user role
	Exp      int64  `json:"exp"`       // expiration
}

func decodeJWTWithoutVerification(tokenString string) (*JWTClaims, error) {
	// JWT format: header.payload.signature
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid token format")
	}

	// Decode payload (second part)
	payload := parts[1]

	// Add padding if needed
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	// Base64 decode
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to decode payload: %w", err)
	}

	// Parse JSON
	var claims JWTClaims
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return nil, fmt.Errorf("failed to parse claims: %w", err)
	}

	return &claims, nil
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
	UserID    string
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

func (tm *TokenManager) CreateStreamingToken(userID, s3Key string) string {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	tokenData := fmt.Sprintf("%s:%s:%d", userID, s3Key, time.Now().UnixNano())
	hash := sha256.Sum256([]byte(tokenData))
	token := hex.EncodeToString(hash[:])

	tm.tokens[token] = &StreamingToken{
		Token:     token,
		UserID:    userID,
		S3Key:     s3Key,
		ExpiresAt: time.Now().Add(TOKEN_LIFETIME),
	}

	log.Printf("🎫 Created streaming token for user %s (expires in %v)", userID, TOKEN_LIFETIME)
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
	UserID         string
	Email          string
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

func (sm *SessionManager) CreateSession(userID, email, fileName string, totalChunks, chunkSize uint32, totalSize uint64) (*UploadSession, error) {
	ext := strings.ToLower(filepath.Ext(fileName))
	contentType, supported := SUPPORTED_EXTENSIONS[ext]
	if !supported {
		return nil, fmt.Errorf("unsupported file type: %s", ext)
	}

	if totalSize > MAX_FILE_SIZE {
		return nil, fmt.Errorf("file size exceeds maximum: %d bytes", totalSize)
	}

	timestamp := time.Now().Format("20060102_150405")
	s3Key := fmt.Sprintf("%s/%s/%s", userID, timestamp, fileName)
	sessionID := fmt.Sprintf("%s_%d", userID, time.Now().UnixNano())

	sm.mu.Lock()
	defer sm.mu.Unlock()

	session := &UploadSession{
		SessionID:      sessionID,
		UserID:         userID,
		Email:          email,
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
	log.Printf("📦 Created session: %s (user: %s, file: %s, size: %.2f MB)",
		sessionID, userID, fileName, float64(totalSize)/(1024*1024))

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

// Middleware to extract JWT and get user info (no verification)
func (s *Server) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Missing authorization header", http.StatusUnauthorized)
			return
		}

		token := strings.TrimPrefix(authHeader, "Bearer ")

		// Decode JWT without verification
		claims, err := decodeJWTWithoutVerification(token)
		if err != nil {
			log.Printf("❌ Failed to decode token: %v", err)
			http.Error(w, "Invalid token format", http.StatusUnauthorized)
			return
		}

		// Check expiration
		if claims.Exp > 0 && time.Now().Unix() > claims.Exp {
			http.Error(w, "Token expired", http.StatusUnauthorized)
			return
		}

		// Use public_id as user_id (or sub as fallback)
		userID := claims.PublicID
		if userID == "" {
			userID = claims.Sub
		}

		log.Printf("🔓 Token decoded - User: %s, Email: %s, Role: %s", userID, claims.Sub, claims.Role)

		// Add user info to context
		ctx := context.WithValue(r.Context(), "userID", userID)
		ctx = context.WithValue(ctx, "email", claims.Sub)
		ctx = context.WithValue(ctx, "role", claims.Role)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

func (s *Server) handleInitUpload(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("userID").(string)
	email := r.Context().Value("email").(string)

	var req struct {
		Filename    string `json:"filename"`
		FileSize    uint64 `json:"file_size"`
		TotalChunks uint32 `json:"total_chunks"`
		ChunkSize   uint32 `json:"chunk_size"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	session, err := s.sessionMgr.CreateSession(userID, email, req.Filename, req.TotalChunks, req.ChunkSize, req.FileSize)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Initialize S3 multipart upload
	result, err := s.s3Client.client.CreateMultipartUpload(context.Background(), &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(s.s3Client.bucket),
		Key:         aws.String(session.S3Key),
		ContentType: aws.String(session.ContentType),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to initialize S3 upload: %v", err), http.StatusInternalServerError)
		return
	}

	session.UploadID = *result.UploadId
	log.Printf("✅ S3 multipart upload initialized: %s", session.UploadID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"session_id": session.SessionID,
		"s3_key":     session.S3Key,
		"upload_id":  session.UploadID,
	})
}

func (s *Server) handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("userID").(string)

	sessionID := r.FormValue("session_id")
	chunkIndexStr := r.FormValue("chunk_index")

	chunkIndex, _ := strconv.ParseUint(chunkIndexStr, 10, 32)

	session := s.sessionMgr.GetSession(sessionID)
	if session == nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	// Read chunk data
	file, _, err := r.FormFile("chunk")
	if err != nil {
		http.Error(w, "Failed to read chunk", http.StatusBadRequest)
		return
	}
	defer file.Close()

	chunkData, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read chunk data", http.StatusInternalServerError)
		return
	}

	// Calculate hash
	hash := sha256.Sum256(chunkData)
	hashStr := hex.EncodeToString(hash[:])

	// Upload to S3
	partNumber := int32(chunkIndex) + 1
	result, err := s.s3Client.client.UploadPart(context.Background(), &s3.UploadPartInput{
		Bucket:     aws.String(s.s3Client.bucket),
		Key:        aws.String(session.S3Key),
		UploadId:   aws.String(session.UploadID),
		PartNumber: aws.Int32(partNumber),
		Body:       bytes.NewReader(chunkData),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("S3 upload failed: %v", err), http.StatusInternalServerError)
		return
	}

	isDuplicate := session.AddChunk(uint32(chunkIndex), uint32(len(chunkData)), hashStr, partNumber, *result.ETag)
	received, total := session.GetProgress()

	log.Printf("📦 Chunk %d/%d uploaded (%.1f%%)", received, total, float64(received)/float64(total)*100)

	// Check if upload is complete
	if session.IsComplete() {
		s.finalizeUpload(w, session)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"duplicate":   isDuplicate,
		"chunk_index": chunkIndex,
		"received":    received,
		"total":       total,
		"progress":    float64(received) / float64(total) * 100,
	})
}

func (s *Server) finalizeUpload(w http.ResponseWriter, session *UploadSession) {
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
		http.Error(w, fmt.Sprintf("Failed to complete upload: %v", err), http.StatusInternalServerError)
		return
	}

	session.mu.Lock()
	session.State = "completed"
	session.UpdatedAt = time.Now()
	session.mu.Unlock()

	log.Printf("✅ Upload completed: %s (%.2f MB)", session.FileName, float64(session.TotalSize)/(1024*1024))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"completed": true,
		"s3_key":    session.S3Key,
		"file_size": session.TotalSize,
	})
}

func (s *Server) handleCompleteUpload(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("userID").(string)

	var req struct {
		SessionID string `json:"session_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	session := s.sessionMgr.GetSession(req.SessionID)
	if session == nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if !session.IsComplete() {
		http.Error(w, "Upload not complete", http.StatusBadRequest)
		return
	}

	s.finalizeUpload(w, session)
}

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("userID").(string)

	prefix := userID + "/"
	result, err := s.s3Client.client.ListObjectsV2(context.Background(), &s3.ListObjectsV2Input{
		Bucket: aws.String(s.s3Client.bucket),
		Prefix: aws.String(prefix),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list files: %v", err), http.StatusInternalServerError)
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"files": files,
		"count": len(files),
	})
}

func (s *Server) handleRequestStreamingToken(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("userID").(string)

	var req struct {
		S3Key string `json:"s3_key"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if !strings.HasPrefix(req.S3Key, userID+"/") {
		http.Error(w, "Unauthorized: file does not belong to user", http.StatusForbidden)
		return
	}

	token := s.tokenMgr.CreateStreamingToken(userID, req.S3Key)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":      token,
		"expires_in": int(TOKEN_LIFETIME.Seconds()),
		"s3_key":     req.S3Key,
	})
}

func (s *Server) handleStreamFile(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Missing streaming token", http.StatusUnauthorized)
		return
	}

	streamingToken, valid := s.tokenMgr.ValidateStreamingToken(token)
	if !valid {
		http.Error(w, "Invalid or expired streaming token", http.StatusForbidden)
		return
	}

	s3Key := streamingToken.S3Key

	headResult, err := s.s3Client.client.HeadObject(context.Background(), &s3.HeadObjectInput{
		Bucket: aws.String(s.s3Client.bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	fileSize := *headResult.ContentLength
	contentType := ""
	if headResult.ContentType != nil {
		contentType = *headResult.ContentType
	}

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
			http.Error(w, "Failed to stream file", http.StatusInternalServerError)
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
		http.Error(w, "Failed to stream file", http.StatusInternalServerError)
		return
	}
	defer result.Body.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(fileSize, 10))

	io.Copy(w, result.Body)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "healthy",
		"time":   time.Now().Format(time.RFC3339),
	})
}

// ============================================
// Main
// ============================================

func main() {
	log.Printf("🚀 Starting Simple File Upload Server (JWT without verification)")

	s3Client, err := NewS3Client()
	if err != nil {
		log.Fatalf("❌ Failed to initialize S3: %v", err)
	}

	tokenMgr := NewTokenManager()
	sessionMgr := NewSessionManager(s3Client)

	server := &Server{
		sessionMgr: sessionMgr,
		s3Client:   s3Client,
		tokenMgr:   tokenMgr,
	}

	router := mux.NewRouter()

	router.HandleFunc("/health", server.handleHealth).Methods("GET")

	// Upload endpoints (require JWT)
	router.HandleFunc("/upload/init", server.authMiddleware(server.handleInitUpload)).Methods("POST")
	router.HandleFunc("/upload/chunk", server.authMiddleware(server.handleUploadChunk)).Methods("POST")
	router.HandleFunc("/upload/complete", server.authMiddleware(server.handleCompleteUpload)).Methods("POST")

	// File management (require JWT)
	router.HandleFunc("/files", server.authMiddleware(server.handleListFiles)).Methods("GET")
	router.HandleFunc("/files/streaming-token", server.authMiddleware(server.handleRequestStreamingToken)).Methods("POST")

	// Streaming endpoint (uses query param token)
	router.HandleFunc("/stream", server.handleStreamFile).Methods("GET")

	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	})

	handler := c.Handler(router)

	log.Printf("✅ Server listening on %s", HTTP_PORT)
	log.Printf("🔓 JWT tokens decoded without signature verification")
	log.Printf("📁 Files stored as: user_id/timestamp/filename")

	if err := http.ListenAndServe(HTTP_PORT, handler); err != nil {
		log.Fatalf("❌ Server failed: %v", err)
	}
}
