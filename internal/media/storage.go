package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// StorageDriver unifies local filesystem and Cloudflare R2 object persistence.
type StorageDriver interface {
	DriverName() string
	Put(ctx context.Context, key string, data []byte, contentType string) (publicURL string, err error)
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
}

// NewStorageDriver constructs LocalStorage or R2Storage from runtime configuration.
func NewStorageDriver(ctx context.Context, cfg *config.Config) (StorageDriver, error) {
	if cfg == nil {
		return NewLocalStorage("./uploads"), nil
	}
	if strings.EqualFold(cfg.StorageDriver, "r2") {
		return NewR2Storage(ctx, cfg)
	}
	return NewLocalStorage(cfg.UploadsDir), nil
}

// LocalStorage writes uploaded objects safely inside a local uploads directory.
type LocalStorage struct {
	rootDir string
}

func NewLocalStorage(rootDir string) *LocalStorage {
	if strings.TrimSpace(rootDir) == "" {
		rootDir = "./uploads"
	}
	return &LocalStorage{rootDir: rootDir}
}

func (l *LocalStorage) DriverName() string {
	return "local"
}

func (l *LocalStorage) Put(_ context.Context, key string, data []byte, _ string) (string, error) {
	cleanRel, targetAbs, err := l.resolveSafePath(key)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(targetAbs), 0o755); err != nil {
		return "", fmt.Errorf("create upload dir: %w", err)
	}
	tmp := targetAbs + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("write upload temp: %w", err)
	}
	if err := os.Rename(tmp, targetAbs); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("commit upload: %w", err)
	}
	return "/uploads/" + cleanRel, nil
}

func (l *LocalStorage) Get(_ context.Context, key string) ([]byte, error) {
	_, targetAbs, err := l.resolveSafePath(key)
	if err != nil {
		return nil, err
	}
	st, err := os.Lstat(targetAbs)
	if err != nil {
		return nil, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symlinks are not permitted")
	}
	return os.ReadFile(targetAbs)
}

func (l *LocalStorage) Delete(_ context.Context, key string) error {
	_, targetAbs, err := l.resolveSafePath(key)
	if err != nil {
		return err
	}
	err = os.Remove(targetAbs)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (l *LocalStorage) resolveSafePath(rawKey string) (cleanRel string, targetAbs string, err error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(rawKey), "\\", "/")
	clean := path.Clean("/" + normalized)
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" || rel == "." || strings.Contains(rel, "..") {
		return "", "", fmt.Errorf("invalid storage key %q", rawKey)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return "", "", fmt.Errorf("invalid storage key segment in %q", rawKey)
		}
	}
	rootAbs, err := filepath.Abs(l.rootDir)
	if err != nil {
		return "", "", err
	}
	targetAbs = filepath.Join(rootAbs, filepath.FromSlash(rel))
	if !strings.HasPrefix(targetAbs, rootAbs+string(filepath.Separator)) {
		return "", "", fmt.Errorf("storage path escapes root")
	}
	return rel, targetAbs, nil
}

// R2Storage persists objects to Cloudflare R2 via S3-compatible API.
type R2Storage struct {
	client    *s3.Client
	bucket    string
	publicURL string
}

func NewR2Storage(ctx context.Context, cfg *config.Config) (*R2Storage, error) {
	if cfg.R2AccountID == "" || cfg.R2AccessKeyID == "" || cfg.R2SecretAccessKey == "" || cfg.R2Bucket == "" {
		return nil, fmt.Errorf("incomplete R2 credentials")
	}
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.R2AccountID)
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("load R2 aws config: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true
	})
	return &R2Storage{
		client:    client,
		bucket:    cfg.R2Bucket,
		publicURL: strings.TrimRight(cfg.R2PublicURL, "/"),
	}, nil
}

func (r *R2Storage) DriverName() string {
	return "r2"
}

func (r *R2Storage) Put(ctx context.Context, key string, data []byte, contentType string) (string, error) {
	cleanKey := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(key, "\\", "/")), "/")
	_, err := r.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(r.bucket),
		Key:         aws.String(cleanKey),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("r2 PutObject: %w", err)
	}
	if r.publicURL != "" {
		return r.publicURL + "/" + escapePathSegments(cleanKey), nil
	}
	return "/uploads/" + cleanKey, nil
}

func (r *R2Storage) Get(ctx context.Context, key string) ([]byte, error) {
	cleanKey := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(key, "\\", "/")), "/")
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(cleanKey),
	})
	if err != nil {
		return nil, fmt.Errorf("r2 GetObject: %w", err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

func (r *R2Storage) Delete(ctx context.Context, key string) error {
	cleanKey := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(key, "\\", "/")), "/")
	_, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(cleanKey),
	})
	return err
}

func escapePathSegments(p string) string {
	segs := strings.Split(p, "/")
	for i := range segs {
		segs[i] = url.PathEscape(segs[i])
	}
	return strings.Join(segs, "/")
}
