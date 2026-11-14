# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-builder
WORKDIR /src
ARG VERSION=2.0.0
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=web-builder /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildDate=${BUILD_DATE}" \
    -o /out/inkbranch ./cmd/inkbranch

FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates tzdata postgresql17-client zstd wget && \
    addgroup -g 1001 -S inkbranch && \
    adduser -u 1001 -S -G inkbranch -h /app -s /sbin/nologin inkbranch && \
    mkdir -p /app/content /app/uploads /app/backups && \
    chown -R 1001:1001 /app

COPY --from=go-builder /out/inkbranch /usr/local/bin/inkbranch

USER 1001:1001
WORKDIR /app
ENV PORT=3000 \
    HOST=0.0.0.0 \
    CONTENT_DIR=/app/content \
    UPLOADS_DIR=/app/uploads \
    BACKUPS_DIR=/app/backups

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["inkbranch"]
CMD ["serve"]
