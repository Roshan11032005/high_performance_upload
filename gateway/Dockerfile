# Dockerfile.gateway
# Multi-stage build for Go Gateway

# ============================================
# Stage 1: Build
# ============================================
FROM golang:1.23.8-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git gcc musl-dev

# Set working directory
WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o gateway \
    gateway.go

# ============================================
# Stage 2: Runtime
# ============================================
FROM alpine:latest

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN addgroup -g 1001 gateway && \
    adduser -D -u 1001 -G gateway gateway

# Set working directory
WORKDIR /app/backend

# Copy binary from builder
COPY --from=builder /build/gateway .

# Change ownership
RUN chown -R gateway:gateway /app

# Switch to non-root user
USER gateway

# Expose ports
EXPOSE 5000 9090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

# Run the gateway
CMD ["./gateway"]
