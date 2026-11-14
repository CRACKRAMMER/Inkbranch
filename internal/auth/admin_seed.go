package auth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

// EnsureInitialAdmin idempotently seeds the primary administrator account on an empty user table.
// When ADMIN_INITIAL_PASSWORD is omitted, it generates a high-entropy temporary password and writes it
// exclusively to a chmod 0600 file readable only by the deploy user / root (never printed or logged).
func EnsureInitialAdmin(ctx context.Context, st state.Store, cfg *config.Config) (seeded bool, passwordFile string, err error) {
	if st == nil || cfg == nil {
		return false, "", nil
	}
	count, err := st.CountUsers(ctx)
	if err != nil {
		return false, "", fmt.Errorf("count users: %w", err)
	}
	if count > 0 {
		return false, "", nil
	}

	email := strings.TrimSpace(cfg.AdminEmail)
	if email == "" {
		email = "crackrammer@gmail.com"
	}
	name := strings.TrimSpace(cfg.AdminName)
	if name == "" {
		name = "CRACKRAMMER"
	}

	plainPass := strings.TrimSpace(cfg.AdminInitPassword)
	wroteFile := ""
	if plainPass == "" {
		plainPass, err = GenerateHighEntropyPassword()
		if err != nil {
			return false, "", fmt.Errorf("generate initial admin password: %w", err)
		}
		wroteFile = cfg.AdminPasswordFile
		if wroteFile == "" {
			wroteFile = "./.inkbranch-initial-admin-password"
		}
	}

	hash, err := HashPassword(plainPass)
	if err != nil {
		return false, "", fmt.Errorf("hash initial admin password: %w", err)
	}

	if _, err := st.CreateUser(ctx, state.User{
		ID:           uuid.New(),
		Email:        strings.ToLower(email),
		Name:         name,
		PasswordHash: hash,
		Role:         "admin",
	}); err != nil {
		return false, "", fmt.Errorf("create initial admin user: %w", err)
	}

	if wroteFile != "" {
		absPath, err := writeSecretPasswordFile(wroteFile, plainPass)
		if err != nil {
			return true, "", fmt.Errorf("write initial password file: %w", err)
		}
		wroteFile = absPath
	}

	return true, wroteFile, nil
}

// ResetAdminPassword updates an admin user's password and revokes all active sessions.
// If explicitPassword is empty, a high-entropy password is written strictly to a chmod 0600 file.
func ResetAdminPassword(ctx context.Context, st state.Store, cfg *config.Config, email, explicitPassword, passwordFile string) (string, error) {
	if st == nil {
		return "", fmt.Errorf("state store is required")
	}
	targetEmail := strings.TrimSpace(email)
	if targetEmail == "" && cfg != nil {
		targetEmail = cfg.AdminEmail
	}
	if targetEmail == "" {
		targetEmail = "crackrammer@gmail.com"
	}

	user, err := st.GetUserByEmail(ctx, targetEmail)
	if err != nil {
		return "", err
	}
	if user == nil {
		return "", fmt.Errorf("admin user %q not found", targetEmail)
	}

	plainPass := strings.TrimSpace(explicitPassword)
	wroteFile := ""
	if plainPass == "" {
		plainPass, err = GenerateHighEntropyPassword()
		if err != nil {
			return "", fmt.Errorf("generate password: %w", err)
		}
		wroteFile = strings.TrimSpace(passwordFile)
		if wroteFile == "" && cfg != nil {
			wroteFile = cfg.AdminPasswordFile
		}
		if wroteFile == "" {
			wroteFile = "./.inkbranch-initial-admin-password"
		}
	}

	hash, err := HashPassword(plainPass)
	if err != nil {
		return "", err
	}
	if err := st.UpdateUserPassword(ctx, user.ID, hash); err != nil {
		return "", err
	}
	_ = st.DeleteSessionsByUser(ctx, user.ID)

	if wroteFile != "" {
		absPath, err := writeSecretPasswordFile(wroteFile, plainPass)
		if err != nil {
			return "", err
		}
		return absPath, nil
	}
	return "", nil
}

func writeSecretPasswordFile(path string, secret string) (string, error) {
	clean := filepath.Clean(path)
	if abs, err := filepath.Abs(clean); err == nil {
		clean = abs
	}
	parent := filepath.Dir(clean)
	if parent != "" && parent != "." {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return "", err
		}
	}
	f, err := os.OpenFile(clean, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := f.WriteString(secret + "\n"); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return clean, nil
}
