package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
)

const SessionCookieName = "ibr_session"

var (
	ErrUnauthorized   = errors.New("authentication required")
	ErrForbidden      = errors.New("insufficient permissions")
	ErrRateLimited    = errors.New("too many requests")
	ErrInvalidMFACode = errors.New("invalid verification or recovery code")
)

type Principal struct {
	User     *state.User
	AuthKind string // "session" or "pat"
	Session  *state.Session
	APIToken *state.APITokenRecord
	Scopes   []string
}

func (p *Principal) HasScope(scope string) bool {
	if p == nil {
		return false
	}
	if p.AuthKind == "session" {
		return true
	}
	for _, s := range p.Scopes {
		if s == "admin:*" || s == scope {
			return true
		}
	}
	return false
}

type mfaPending struct {
	UserID    uuid.UUID
	ExpiresAt time.Time
}

type passkeyCeremony struct {
	UserID    uuid.UUID
	Label     string
	Session   webauthn.SessionData
	ExpiresAt time.Time
}

type Service struct {
	cfg   *config.Config
	state state.Store

	mu          sync.Mutex
	mfaChallenges map[string]mfaPending
	regSessions   map[string]passkeyCeremony
	loginSessions map[string]passkeyCeremony
	rateLimit     *RateLimiter
}

func NewService(cfg *config.Config, st state.Store) *Service {
	return &Service{
		cfg:           cfg,
		state:         st,
		mfaChallenges: make(map[string]mfaPending),
		regSessions:   make(map[string]passkeyCeremony),
		loginSessions: make(map[string]passkeyCeremony),
		rateLimit:     NewRateLimiter(),
	}
}

func (s *Service) Store() state.Store {
	return s.state
}

func (s *Service) SecretKey() []byte {
	return s.cfg.EffectiveSecretKey()
}

func (s *Service) ClientIPHash(r *http.Request) string {
	ip := strings.TrimSpace(r.RemoteAddr)
	if idx := strings.LastIndex(ip, ":"); idx > 0 && !strings.Contains(ip[idx:], "]") {
		ip = ip[:idx]
	}
	return DailyRotatingHash(s.SecretKey(), "ip", ip, time.Now().UTC())
}

func (s *Service) AllowRate(bucket, subject string, limit int, window time.Duration) bool {
	return s.rateLimit.Allow(bucket+":"+subject, limit, window)
}

type LoginOutcome struct {
	MFARequired bool
	MFAToken    string
	User        state.User
	Session     state.Session
	CookieToken string
}

// LoginWithPassword verifies email/password and either completes login or issues an MFA challenge.
func (s *Service) LoginWithPassword(ctx context.Context, email, password string, r *http.Request) (*LoginOutcome, error) {
	u, err := s.state.GetUserByEmail(ctx, email)
	if err != nil || u == nil {
		return nil, ErrUnauthorized
	}
	ok, err := VerifyPassword(password, u.PasswordHash)
	if err != nil || !ok {
		return nil, ErrUnauthorized
	}

	totpRec, err := s.state.GetTOTP(ctx, u.ID)
	if err == nil && totpRec != nil && totpRec.Enabled {
		mfaTok, _, _, err := GenerateRandomToken("mfa_", 24)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.cleanupExpiredLocked()
		s.mfaChallenges[HashToken(mfaTok)] = mfaPending{
			UserID:    u.ID,
			ExpiresAt: time.Now().UTC().Add(5 * time.Minute),
		}
		s.mu.Unlock()
		return &LoginOutcome{
			MFARequired: true,
			MFAToken:    mfaTok,
			User:        *u,
		}, nil
	}

	return s.issueSessionOutcome(ctx, u, r)
}

// VerifyMFACode completes a pending TOTP/recovery login challenge and issues a full session.
func (s *Service) VerifyMFACode(ctx context.Context, mfaToken, code string, r *http.Request) (*LoginOutcome, error) {
	hashKey := HashToken(strings.TrimSpace(mfaToken))
	s.mu.Lock()
	s.cleanupExpiredLocked()
	pend, ok := s.mfaChallenges[hashKey]
	s.mu.Unlock()
	if !ok || time.Now().UTC().After(pend.ExpiresAt) {
		return nil, ErrUnauthorized
	}

	u, err := s.state.GetUserByID(ctx, pend.UserID)
	if err != nil || u == nil {
		return nil, ErrUnauthorized
	}

	rec, err := s.state.GetTOTP(ctx, u.ID)
	if err != nil || rec == nil || !rec.Enabled {
		return nil, ErrUnauthorized
	}

	secretBytes, err := DecryptBytes(s.SecretKey(), rec.EncryptedSecret)
	if err != nil {
		return nil, err
	}

	trimmedCode := strings.TrimSpace(code)
	valid := totp.Validate(trimmedCode, string(secretBytes))
	if !valid {
		norm := HashToken(strings.ToUpper(strings.ReplaceAll(trimmedCode, "-", "")))
		matchedIdx := -1
		for idx, h := range rec.RecoveryCodeHashes {
			if subtle.ConstantTimeCompare([]byte(h), []byte(norm)) == 1 {
				matchedIdx = idx
				break
			}
		}
		if matchedIdx < 0 {
			return nil, ErrInvalidMFACode
		}
		updated := make([]string, 0, len(rec.RecoveryCodeHashes)-1)
		updated = append(updated, rec.RecoveryCodeHashes[:matchedIdx]...)
		updated = append(updated, rec.RecoveryCodeHashes[matchedIdx+1:]...)
		rec.RecoveryCodeHashes = updated
		if err := s.state.UpsertTOTP(ctx, *rec); err != nil {
			return nil, err
		}
		valid = true
	}
	if !valid {
		return nil, ErrInvalidMFACode
	}

	s.mu.Lock()
	delete(s.mfaChallenges, hashKey)
	s.mu.Unlock()
	return s.issueSessionOutcome(ctx, u, r)
}

func (s *Service) issueSessionOutcome(ctx context.Context, u *state.User, r *http.Request) (*LoginOutcome, error) {
	plainTok, tokHash, _, err := GenerateRandomToken("ibr_sess_", 32)
	if err != nil {
		return nil, err
	}
	csrfTok, _, _, err := GenerateRandomToken("csrf_", 24)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	ipHash := ""
	ua := ""
	if r != nil {
		ipHash = s.ClientIPHash(r)
		ua = limitString(r.UserAgent(), 256)
	}

	sess := state.Session{
		ID:         uuid.New(),
		UserID:     u.ID,
		TokenHash:  tokHash,
		CSRFSecret: csrfTok,
		IPHash:     ipHash,
		UserAgent:  ua,
		LastSeenAt: now,
		ExpiresAt:  now.Add(14 * 24 * time.Hour),
		CreatedAt:  now,
	}
	if err := s.state.CreateSession(ctx, sess); err != nil {
		return nil, err
	}
	return &LoginOutcome{
		User:        *u,
		Session:     sess,
		CookieToken: plainTok,
	}, nil
}

func (s *Service) SetSessionCookie(w http.ResponseWriter, r *http.Request, plainToken string, expiresAt time.Time) {
	isSecure := strings.HasPrefix(strings.ToLower(s.cfg.SiteURL), "https://") ||
		(r != nil && (r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")))
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    plainToken,
		Path:     "/",
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) ClearSessionCookie(w http.ResponseWriter, r *http.Request) {
	isSecure := strings.HasPrefix(strings.ToLower(s.cfg.SiteURL), "https://") ||
		(r != nil && (r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")))
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// AuthenticateRequest resolves the active Principal via Bearer PAT or HttpOnly Session cookie.
func (s *Service) AuthenticateRequest(r *http.Request) (*Principal, error) {
	ctx := r.Context()
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		rawTok := strings.TrimSpace(authHeader[len("bearer "):])
		if rawTok == "" {
			return nil, ErrUnauthorized
		}
		tokRec, err := s.state.GetAPITokenByHash(ctx, HashToken(rawTok))
		if err != nil || tokRec == nil {
			return nil, ErrUnauthorized
		}
		if tokRec.RevokedAt != nil {
			return nil, ErrUnauthorized
		}
		if tokRec.ExpiresAt != nil && time.Now().UTC().After(*tokRec.ExpiresAt) {
			return nil, ErrUnauthorized
		}
		user, err := s.state.GetUserByID(ctx, tokRec.UserID)
		if err != nil || user == nil {
			return nil, ErrUnauthorized
		}
		_ = s.state.TouchAPIToken(ctx, tokRec.ID, time.Now().UTC())
		return &Principal{
			User:     user,
			AuthKind: "pat",
			APIToken: tokRec,
			Scopes:   tokRec.Scopes,
		}, nil
	}

	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return nil, ErrUnauthorized
	}
	sess, err := s.state.GetSessionByTokenHash(ctx, HashToken(cookie.Value))
	if err != nil || sess == nil {
		return nil, ErrUnauthorized
	}
	now := time.Now().UTC()
	if now.After(sess.ExpiresAt) {
		_ = s.state.DeleteSession(ctx, sess.ID)
		return nil, ErrUnauthorized
	}
	user, err := s.state.GetUserByID(ctx, sess.UserID)
	if err != nil || user == nil {
		return nil, ErrUnauthorized
	}
	if now.Sub(sess.LastSeenAt) > 2*time.Minute {
		_ = s.state.TouchSession(ctx, sess.ID, now)
	}
	return &Principal{
		User:     user,
		AuthKind: "session",
		Session:  sess,
		Scopes:   []string{"admin:*"},
	}, nil
}

// VerifyCSRF checks X-CSRF-Token against the session's CSRFSecret on cookie-authenticated mutations.
func (s *Service) VerifyCSRF(r *http.Request, p *Principal) bool {
	if p == nil {
		return false
	}
	if p.AuthKind != "session" {
		return true
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return true
	}
	if p.Session == nil || p.Session.CSRFSecret == "" {
		return false
	}
	got := strings.TrimSpace(r.Header.Get("X-CSRF-Token"))
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(p.Session.CSRFSecret)) == 1
}

// SetupTOTP generates a new TOTP secret (encrypted at rest until confirmed) and 10 one-time recovery codes.
func (s *Service) SetupTOTP(ctx context.Context, u *state.User) (secret, otpauthURL string, recoveryCodes []string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      s.cfg.SiteName,
		AccountName: u.Email,
	})
	if err != nil {
		return "", "", nil, err
	}
	enc, err := EncryptBytes(s.SecretKey(), []byte(key.Secret()))
	if err != nil {
		return "", "", nil, err
	}
	codes, hashes, err := GenerateRecoveryCodes(10)
	if err != nil {
		return "", "", nil, err
	}
	if err := s.state.UpsertTOTP(ctx, state.TOTPRecord{
		UserID:             u.ID,
		EncryptedSecret:    enc,
		RecoveryCodeHashes: hashes,
		Enabled:            false,
	}); err != nil {
		return "", "", nil, err
	}
	return key.Secret(), key.URL(), codes, nil
}

// EnableTOTP verifies a live 6-digit TOTP code against the pending secret and activates 2FA.
func (s *Service) EnableTOTP(ctx context.Context, userID uuid.UUID, code string) error {
	rec, err := s.state.GetTOTP(ctx, userID)
	if err != nil || rec == nil {
		return fmt.Errorf("totp setup not initialized")
	}
	raw, err := DecryptBytes(s.SecretKey(), rec.EncryptedSecret)
	if err != nil {
		return err
	}
	if !totp.Validate(strings.TrimSpace(code), string(raw)) {
		return ErrInvalidMFACode
	}
	now := time.Now().UTC()
	rec.Enabled = true
	rec.VerifiedAt = &now
	return s.state.UpsertTOTP(ctx, *rec)
}

func (s *Service) DisableTOTP(ctx context.Context, userID uuid.UUID) error {
	return s.state.DeleteTOTP(ctx, userID)
}

// WebAuthn Integration

type webauthnUser struct {
	user  state.User
	creds []webauthn.Credential
}

func (w *webauthnUser) WebAuthnID() []byte {
	return w.user.ID[:]
}

func (w *webauthnUser) WebAuthnName() string {
	return w.user.Email
}

func (w *webauthnUser) WebAuthnDisplayName() string {
	if w.user.Name != "" {
		return w.user.Name
	}
	return w.user.Email
}

func (w *webauthnUser) WebAuthnCredentials() []webauthn.Credential {
	return w.creds
}

func (s *Service) loadWebAuthnUser(ctx context.Context, u *state.User) (*webauthnUser, []state.PasskeyRecord, error) {
	records, err := s.state.ListPasskeys(ctx, u.ID)
	if err != nil {
		return nil, nil, err
	}
	creds := make([]webauthn.Credential, 0, len(records))
	for _, r := range records {
		if len(r.CredentialJSON) > 2 {
			var c webauthn.Credential
			if err := json.Unmarshal(r.CredentialJSON, &c); err == nil && len(c.ID) > 0 {
				creds = append(creds, c)
				continue
			}
		}
		transports := make([]protocol.AuthenticatorTransport, 0, len(r.Transports))
		for _, t := range r.Transports {
			transports = append(transports, protocol.AuthenticatorTransport(t))
		}
		creds = append(creds, webauthn.Credential{
			ID:              r.CredentialID,
			PublicKey:       r.PublicKey,
			AttestationType: r.AttestationType,
			Transport:       transports,
			Authenticator: webauthn.Authenticator{
				AAGUID:    r.AAGUID,
				SignCount: r.SignCount,
			},
		})
	}
	return &webauthnUser{user: *u, creds: creds}, records, nil
}

func (s *Service) newWebAuthn(r *http.Request) (*webauthn.WebAuthn, error) {
	rpID := "localhost"
	origins := []string{}
	if u, err := url.Parse(s.cfg.SiteURL); err == nil && u.Hostname() != "" {
		rpID = u.Hostname()
		origins = append(origins, u.Scheme+"://"+u.Host)
	}
	if r != nil {
		if orig := strings.TrimSpace(r.Header.Get("Origin")); orig != "" {
			if ou, err := url.Parse(orig); err == nil && ou.Hostname() != "" {
				origins = appendUnique(origins, ou.Scheme+"://"+ou.Host)
				if rpID == "localhost" {
					rpID = ou.Hostname()
				}
			}
		}
		if r.Host != "" {
			hostOnly := r.Host
			if idx := strings.LastIndex(hostOnly, ":"); idx > 0 {
				hostOnly = hostOnly[:idx]
			}
			if rpID == "localhost" && hostOnly != "" {
				rpID = hostOnly
			}
			scheme := "http"
			if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
				scheme = "https"
			}
			origins = appendUnique(origins, scheme+"://"+r.Host)
		}
	}
	if len(origins) == 0 {
		origins = []string{"http://localhost:3000"}
	}
	return webauthn.New(&webauthn.Config{
		RPDisplayName: s.cfg.SiteName,
		RPID:          rpID,
		RPOrigins:     origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationPreferred,
		},
	})
}

func (s *Service) BeginPasskeyRegistration(ctx context.Context, u *state.User, label string, r *http.Request) (ceremonyID string, creation *protocol.CredentialCreation, err error) {
	wa, err := s.newWebAuthn(r)
	if err != nil {
		return "", nil, err
	}
	wu, _, err := s.loadWebAuthnUser(ctx, u)
	if err != nil {
		return "", nil, err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(wu.creds))
	for _, c := range wu.creds {
		exclusions = append(exclusions, c.Descriptor())
	}
	creation, sess, err := wa.BeginRegistration(wu, webauthn.WithExclusions(exclusions))
	if err != nil {
		return "", nil, err
	}
	cid, _, _, err := GenerateRandomToken("pkreg_", 18)
	if err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(label) == "" {
		label = "Passkey"
	}
	s.mu.Lock()
	s.cleanupExpiredLocked()
	s.regSessions[cid] = passkeyCeremony{
		UserID:    u.ID,
		Label:     strings.TrimSpace(label),
		Session:   *sess,
		ExpiresAt: time.Now().UTC().Add(5 * time.Minute),
	}
	s.mu.Unlock()
	return cid, creation, nil
}

func (s *Service) FinishPasskeyRegistration(ctx context.Context, u *state.User, ceremonyID string, r *http.Request) (*state.PasskeyRecord, error) {
	s.mu.Lock()
	s.cleanupExpiredLocked()
	cer, ok := s.regSessions[ceremonyID]
	delete(s.regSessions, ceremonyID)
	s.mu.Unlock()
	if !ok || cer.UserID != u.ID || time.Now().UTC().After(cer.ExpiresAt) {
		return nil, fmt.Errorf("passkey registration ceremony expired")
	}

	wa, err := s.newWebAuthn(r)
	if err != nil {
		return nil, err
	}
	wu, _, err := s.loadWebAuthnUser(ctx, u)
	if err != nil {
		return nil, err
	}
	cred, err := wa.FinishRegistration(wu, cer.Session, r)
	if err != nil {
		return nil, err
	}
	credJSON, _ := json.Marshal(cred)
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	rec := state.PasskeyRecord{
		ID:              uuid.New(),
		UserID:          u.ID,
		CredentialID:    cred.ID,
		PublicKey:       cred.PublicKey,
		AttestationType: cred.AttestationType,
		AAGUID:          cred.Authenticator.AAGUID,
		SignCount:       cred.Authenticator.SignCount,
		Transports:      transports,
		CredentialJSON:  credJSON,
		Label:           cer.Label,
		CreatedAt:       time.Now().UTC(),
	}
	if err := s.state.CreatePasskey(ctx, rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *Service) BeginPasskeyLogin(ctx context.Context, email string, r *http.Request) (ceremonyID string, assertion *protocol.CredentialAssertion, err error) {
	wa, err := s.newWebAuthn(r)
	if err != nil {
		return "", nil, err
	}

	var sess *webauthn.SessionData
	var userID uuid.UUID
	if strings.TrimSpace(email) != "" {
		u, err := s.state.GetUserByEmail(ctx, email)
		if err != nil || u == nil {
			return "", nil, ErrUnauthorized
		}
		wu, _, err := s.loadWebAuthnUser(ctx, u)
		if err != nil {
			return "", nil, err
		}
		if len(wu.creds) > 0 {
			assertion, sess, err = wa.BeginLogin(wu)
			userID = u.ID
		} else {
			assertion, sess, err = wa.BeginDiscoverableLogin()
		}
	} else {
		assertion, sess, err = wa.BeginDiscoverableLogin()
	}
	if err != nil {
		return "", nil, err
	}

	cid, _, _, err := GenerateRandomToken("pklog_", 18)
	if err != nil {
		return "", nil, err
	}
	s.mu.Lock()
	s.cleanupExpiredLocked()
	s.loginSessions[cid] = passkeyCeremony{
		UserID:    userID,
		Session:   *sess,
		ExpiresAt: time.Now().UTC().Add(5 * time.Minute),
	}
	s.mu.Unlock()
	return cid, assertion, nil
}

func (s *Service) FinishPasskeyLogin(ctx context.Context, ceremonyID string, r *http.Request) (*LoginOutcome, error) {
	s.mu.Lock()
	s.cleanupExpiredLocked()
	cer, ok := s.loginSessions[ceremonyID]
	delete(s.loginSessions, ceremonyID)
	s.mu.Unlock()
	if !ok || time.Now().UTC().After(cer.ExpiresAt) {
		return nil, fmt.Errorf("passkey login ceremony expired")
	}

	wa, err := s.newWebAuthn(r)
	if err != nil {
		return nil, err
	}

	var matchedUser *state.User
	var cred *webauthn.Credential
	if len(cer.Session.UserID) > 0 && cer.UserID != uuid.Nil {
		u, err := s.state.GetUserByID(ctx, cer.UserID)
		if err != nil || u == nil {
			return nil, ErrUnauthorized
		}
		wu, _, err := s.loadWebAuthnUser(ctx, u)
		if err != nil {
			return nil, err
		}
		cred, err = wa.FinishLogin(wu, cer.Session, r)
		if err != nil {
			return nil, err
		}
		matchedUser = u
	} else {
		_, c, err := wa.FinishPasskeyLogin(func(rawID, _ []byte) (webauthn.User, error) {
			pk, err := s.state.GetPasskeyByCredentialID(ctx, rawID)
			if err != nil || pk == nil {
				return nil, fmt.Errorf("unknown passkey credential")
			}
			u, err := s.state.GetUserByID(ctx, pk.UserID)
			if err != nil || u == nil {
				return nil, fmt.Errorf("user not found")
			}
			matchedUser = u
			wu, _, err := s.loadWebAuthnUser(ctx, u)
			return wu, err
		}, cer.Session, r)
		if err != nil {
			return nil, err
		}
		cred = c
	}

	if matchedUser == nil || cred == nil {
		return nil, ErrUnauthorized
	}

	if pk, err := s.state.GetPasskeyByCredentialID(ctx, cred.ID); err == nil && pk != nil {
		credJSON, _ := json.Marshal(cred)
		_ = s.state.UpdatePasskeyUsage(ctx, pk.ID, cred.Authenticator.SignCount, credJSON, time.Now().UTC())
	}

	return s.issueSessionOutcome(ctx, matchedUser, r)
}

func (s *Service) cleanupExpiredLocked() {
	now := time.Now().UTC()
	for k, v := range s.mfaChallenges {
		if now.After(v.ExpiresAt) {
			delete(s.mfaChallenges, k)
		}
	}
	for k, v := range s.regSessions {
		if now.After(v.ExpiresAt) {
			delete(s.regSessions, k)
		}
	}
	for k, v := range s.loginSessions {
		if now.After(v.ExpiresAt) {
			delete(s.loginSessions, k)
		}
	}
}

func appendUnique(items []string, candidate string) []string {
	for _, it := range items {
		if it == candidate {
			return items
		}
	}
	return append(items, candidate)
}

func limitString(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// RateLimiter provides thread-safe sliding-window request limiting per key.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string][]time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{
		buckets: make(map[string][]time.Time),
	}
}

func (rl *RateLimiter) Allow(key string, limit int, window time.Duration) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-window)

	rl.mu.Lock()
	defer rl.mu.Unlock()

	hits := rl.buckets[key]
	kept := hits[:0]
	for _, ts := range hits {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= limit {
		rl.buckets[key] = kept
		return false
	}
	kept = append(kept, now)
	rl.buckets[key] = kept
	return true
}
