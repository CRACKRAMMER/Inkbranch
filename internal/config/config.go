package config

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
)

// Config holds validated runtime configuration loaded from environment variables.
type Config struct {
	Port               int
	Host               string
	SiteURL            string
	SiteName           string
	SiteDescription    string
	DatabaseURL        string
	DatabasePoolMax    int32
	SessionSecret      string
	TrustProxy         bool
	ContentDir         string
	UploadsDir         string
	BackupsDir         string
	StorageDriver      string // "local" or "r2"
	R2AccountID        string
	R2AccessKeyID      string
	R2SecretAccessKey  string
	R2Bucket           string
	R2PublicURL        string
	TurnstileSiteKey   string
	TurnstileSecretKey string
	SMTPHost           string
	SMTPPort           int
	SMTPUser           string
	SMTPPass           string
	SMTPFrom           string
	ResendAPIKey       string
	AdminEmail         string
	AdminName          string
	AdminInitPassword  string
	AdminPasswordFile  string

	secretOnce sync.Once
	secretKey  []byte
}

// Load reads environment variables into Config with safe defaults.
func Load() (*Config, error) {
	cfg := &Config{
		Port:               getEnvInt("PORT", 3000),
		Host:               getEnvOr("HOST", "0.0.0.0"),
		SiteURL:            strings.TrimRight(getEnvOr("SITE_URL", "http://localhost:3000"), "/"),
		SiteName:           getEnvOr("SITE_NAME", "Inkbranch"),
		SiteDescription:    getEnvOr("SITE_DESCRIPTION", "Personal Knowledge System & Modern Publishing Platform"),
		DatabaseURL:        strings.TrimSpace(os.Getenv("DATABASE_URL")),
		DatabasePoolMax:    int32(getEnvInt("DATABASE_POOL_MAX", 10)),
		SessionSecret:      strings.TrimSpace(os.Getenv("SESSION_SECRET")),
		TrustProxy:         getEnvBool("TRUST_PROXY", true),
		ContentDir:         getEnvOr("CONTENT_DIR", "./content"),
		UploadsDir:         getEnvOr("UPLOADS_DIR", "./uploads"),
		BackupsDir:         getEnvOr("BACKUPS_DIR", "./backups"),
		StorageDriver:      strings.ToLower(getEnvOr("STORAGE_DRIVER", "local")),
		R2AccountID:        strings.TrimSpace(os.Getenv("R2_ACCOUNT_ID")),
		R2AccessKeyID:      strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID")),
		R2SecretAccessKey:  strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY")),
		R2Bucket:           strings.TrimSpace(os.Getenv("R2_BUCKET")),
		R2PublicURL:        strings.TrimRight(strings.TrimSpace(os.Getenv("R2_PUBLIC_URL")), "/"),
		TurnstileSiteKey:   strings.TrimSpace(os.Getenv("TURNSTILE_SITE_KEY")),
		TurnstileSecretKey: strings.TrimSpace(os.Getenv("TURNSTILE_SECRET_KEY")),
		SMTPHost:           strings.TrimSpace(os.Getenv("SMTP_HOST")),
		SMTPPort:           getEnvInt("SMTP_PORT", 587),
		SMTPUser:           strings.TrimSpace(os.Getenv("SMTP_USER")),
		SMTPPass:           strings.TrimSpace(os.Getenv("SMTP_PASS")),
		SMTPFrom:           getEnvOr("SMTP_FROM", "Inkbranch <noreply@localhost>"),
		ResendAPIKey:       strings.TrimSpace(os.Getenv("RESEND_API_KEY")),
		AdminEmail:         getEnvOr("ADMIN_EMAIL", "crackrammer@gmail.com"),
		AdminName:          getEnvOr("ADMIN_NAME", "CRACKRAMMER"),
		AdminInitPassword:  firstNonEmptyEnv("ADMIN_INITIAL_PASSWORD", "ADMIN_PASSWORD"),
		AdminPasswordFile:  getEnvOr("ADMIN_INITIAL_PASSWORD_FILE", "./.inkbranch-initial-admin-password"),
	}

	if cfg.Port <= 0 || cfg.Port > 65535 {
		return nil, fmt.Errorf("invalid PORT %d", cfg.Port)
	}
	if cfg.StorageDriver != "local" && cfg.StorageDriver != "r2" {
		return nil, fmt.Errorf("invalid STORAGE_DRIVER %q (must be local or r2)", cfg.StorageDriver)
	}
	if cfg.StorageDriver == "r2" {
		if cfg.R2AccountID == "" || cfg.R2AccessKeyID == "" || cfg.R2SecretAccessKey == "" || cfg.R2Bucket == "" {
			return nil, fmt.Errorf("STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET")
		}
	}
	return cfg, nil
}

// HasConfiguredSecret reports whether SESSION_SECRET was explicitly configured.
func (c *Config) HasConfiguredSecret() bool {
	return strings.TrimSpace(c.SessionSecret) != ""
}

// EffectiveSecretKey returns a 32-byte key derived from SESSION_SECRET or a process-local CSPRNG key.
func (c *Config) EffectiveSecretKey() []byte {
	c.secretOnce.Do(func() {
		if s := strings.TrimSpace(c.SessionSecret); s != "" {
			sum := sha256.Sum256([]byte(s))
			c.secretKey = sum[:]
			return
		}
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			sum := sha256.Sum256([]byte("inkbranch-ephemeral-fallback"))
			c.secretKey = sum[:]
			return
		}
		c.secretKey = buf
	})
	out := make([]byte, len(c.secretKey))
	copy(out, c.secretKey)
	return out
}

func firstNonEmptyEnv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

func getEnvOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func getEnvBool(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
