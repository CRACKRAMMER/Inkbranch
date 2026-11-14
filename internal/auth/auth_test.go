package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
)

func TestArgon2idAndAESGCM(t *testing.T) {
	hash, err := HashPassword("CorrectHorseBatteryStaple!")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("unexpected hash format: %s", hash)
	}
	if ok, err := VerifyPassword("CorrectHorseBatteryStaple!", hash); err != nil || !ok {
		t.Fatalf("expected password verification to pass, got ok=%v err=%v", ok, err)
	}
	if ok, _ := VerifyPassword("WrongPassword123", hash); ok {
		t.Fatalf("expected wrong password verification to fail")
	}

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	ct, err := EncryptBytes(key, []byte("secret-payload"))
	if err != nil {
		t.Fatalf("EncryptBytes: %v", err)
	}
	pt, err := DecryptBytes(key, ct)
	if err != nil || string(pt) != "secret-payload" {
		t.Fatalf("DecryptBytes mismatch: got=%q err=%v", pt, err)
	}
	ct[len(ct)-1] ^= 0xff
	if _, err := DecryptBytes(key, ct); err == nil {
		t.Fatalf("expected tampered ciphertext to fail authentication")
	}
}

func TestEnsureInitialAdminAndPasswordFile(t *testing.T) {
	tmp := t.TempDir()
	pwFile := filepath.Join(tmp, "initial-pw.txt")
	cfg := &config.Config{
		SiteURL:           "http://localhost:3000",
		SiteName:          "Inkbranch",
		AdminEmail:        "crackrammer@gmail.com",
		AdminName:         "CRACKRAMMER",
		AdminPasswordFile: pwFile,
	}
	st := state.NewMemoryStore()

	seeded, writtenPath, err := EnsureInitialAdmin(context.Background(), st, cfg)
	if err != nil {
		t.Fatalf("EnsureInitialAdmin: %v", err)
	}
	if !seeded || writtenPath != pwFile {
		t.Fatalf("expected seeded=true path=%s, got seeded=%v path=%s", pwFile, seeded, writtenPath)
	}

	fi, err := os.Stat(pwFile)
	if err != nil {
		t.Fatalf("stat password file: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("expected mode 0600, got %o", fi.Mode().Perm())
	}
	rawPW, err := os.ReadFile(pwFile)
	if err != nil {
		t.Fatalf("read password file: %v", err)
	}
	pw := strings.TrimSpace(string(rawPW))
	if len(pw) != 36 {
		t.Fatalf("expected 36-char generated password, got len=%d", len(pw))
	}

	// Idempotent on second call
	seededAgain, _, err := EnsureInitialAdmin(context.Background(), st, cfg)
	if err != nil || seededAgain {
		t.Fatalf("expected second EnsureInitialAdmin to be no-op, got seeded=%v err=%v", seededAgain, err)
	}

	// Login with generated password succeeds
	svc := NewService(cfg, st)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	out, err := svc.LoginWithPassword(context.Background(), "crackrammer@gmail.com", pw, req)
	if err != nil || out.CookieToken == "" {
		t.Fatalf("login with seeded admin failed: %v", err)
	}
}

func TestTOTPRecoveryCodesAndPATScopes(t *testing.T) {
	cfg := &config.Config{
		SiteURL:       "http://localhost:3000",
		SiteName:      "Inkbranch",
		SessionSecret: "unit-test-secret-32-bytes-minimum",
	}
	st := state.NewMemoryStore()
	hash, _ := HashPassword("SuperSecureAdminPass!99")
	user, _ := st.CreateUser(context.Background(), state.User{
		ID:           uuid.New(),
		Email:        "crackrammer@gmail.com",
		Name:         "CRACKRAMMER",
		PasswordHash: hash,
		Role:         "admin",
	})
	svc := NewService(cfg, st)

	secret, _, recoveryCodes, err := svc.SetupTOTP(context.Background(), &user)
	if err != nil || len(recoveryCodes) != 10 {
		t.Fatalf("SetupTOTP failed: err=%v codes=%d", err, len(recoveryCodes))
	}
	liveCode, err := totp.GenerateCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("totp.GenerateCode: %v", err)
	}
	if err := svc.EnableTOTP(context.Background(), user.ID, liveCode); err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	out, err := svc.LoginWithPassword(context.Background(), user.Email, "SuperSecureAdminPass!99", req)
	if err != nil || !out.MFARequired {
		t.Fatalf("expected MFA challenge, got out=%+v err=%v", out, err)
	}

	// Single-use recovery code works once and is consumed afterwards
	res, err := svc.VerifyMFACode(context.Background(), out.MFAToken, recoveryCodes[0], req)
	if err != nil || res.CookieToken == "" {
		t.Fatalf("VerifyMFACode with recovery code failed: %v", err)
	}

	out2, _ := svc.LoginWithPassword(context.Background(), user.Email, "SuperSecureAdminPass!99", req)
	if _, err := svc.VerifyMFACode(context.Background(), out2.MFAToken, recoveryCodes[0], req); err == nil {
		t.Fatalf("expected reused recovery code to fail")
	}

	// Scoped PAT verification
	plainPAT, patHash, patPrefix, _ := GenerateRandomToken("ibr_pat_", 24)
	_ = st.CreateAPIToken(context.Background(), state.APITokenRecord{
		UserID:      user.ID,
		Name:        "CI Publisher",
		TokenPrefix: patPrefix,
		TokenHash:   patHash,
		Scopes:      []string{"content:write"},
	})
	patReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/content", nil)
	patReq.Header.Set("Authorization", "Bearer "+plainPAT)
	p, err := svc.AuthenticateRequest(patReq)
	if err != nil {
		t.Fatalf("AuthenticateRequest PAT failed: %v", err)
	}
	if !p.HasScope("content:write") || p.HasScope("webhooks:manage") {
		t.Fatalf("unexpected PAT scopes: %v", p.Scopes)
	}

	// Rate limiter check
	for i := 0; i < 3; i++ {
		if !svc.AllowRate("test", "user1", 3, time.Minute) {
			t.Fatalf("unexpected rate limit at hit %d", i+1)
		}
	}
	if svc.AllowRate("test", "user1", 3, time.Minute) {
		t.Fatalf("expected 4th hit to be rate limited")
	}
}
