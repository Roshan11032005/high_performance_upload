# ---------- Builder ----------
FROM golang:1.23.8-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy module files first (cache friendly)
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source
COPY . .

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build -o gnet_server

# ---------- Runtime ----------
FROM alpine:latest

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY --from=builder /app/gnet_server .

EXPOSE 8081 8085

CMD ["./gnet_server"]
