package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/citadel"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

const (
	PKCECookieName          = "ibr_pkce"
	ReaderSessionCookieName = "ibr_reader"

	CitadelHeaderUserID      = "X-Citadel-User-ID"
	CitadelHeaderEmail       = "X-Citadel-Email"
	CitadelHeaderName        = "X-Citadel-Name"
	CitadelHeaderGlobalRole  = "X-Citadel-Global-Role"
	CitadelHeaderAppID       = "X-Citadel-App-ID"
	CitadelHeaderAppRole     = "X-Citadel-App-Role"
	CitadelHeaderPermissions = "X-Citadel-Permissions"
	CitadelHeaderTimestamp   = "X-Citadel-Timestamp"
	CitadelHeaderSignature   = "X-Citadel-Signature"

	citadelMaxSkewSeconds = 60
	pkceCookieTTL         = 10 * time.Minute
	readerCookieMaxAge    = 7 * 24 * 60 * 60
)

var (
	ErrForbiddenApp      = errors.New("access denied for this application")
	ErrLocalAuthDisabled = errors.New("local authentication is disabled in citadel_only mode")
	ErrCSRFMismatch      = errors.New("cross-origin request rejected")
)

// PKCEState stores transient OAuth2 PKCE handshake data inside an AES-GCM sealed cookie.
type PKCEState struct {
	State     string    `json:"s"`
	Verifier  string    `json:"v"`
	ReturnTo  string    `json:"r"`
	ExpiresAt time.Time `json:"exp"`
}

// ReaderSession stores the authenticated public blog reader's Citadel identity and OAuth tokens.
type ReaderSession struct {
	UserID       string    `json:"uid"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	AvatarURL    string    `json:"avatarUrl,omitempty"`
	GlobalRole   string    `json:"globalRole,omitempty"`
	AppRole      string    `json:"appRole,omitempty"`
	AllowAdmin   bool      `json:"allowAdmin,omitempty"`
	AccessToken  string    `json:"at"`
	RefreshToken string    `json:"rt,omitempty"`
	ExpiresAt    time.Time `json:"exp"`
}

// SetCitadel attaches the backend Citadel client used for app registration, token introspection, and OAuth2 exchange.
func (s *Service) SetCitadel(c *citadel.Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.citadel = c
}

// Citadel returns the attached Citadel client, or nil if running purely locally.
func (s *Service) Citadel() *citadel.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.citadel
}

func (s *Service) citadelAppID() string {
	appID := strings.TrimSpace(s.cfg.CitadelAppID)
	if appID == "" {
		return "inkbranch"
	}
	return appID
}

func (s *Service) hasCitadelHeaders(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get(CitadelHeaderUserID)) != "" ||
		strings.TrimSpace(r.Header.Get(CitadelHeaderSignature)) != "" ||
		strings.TrimSpace(r.Header.Get(CitadelHeaderTimestamp)) != "" ||
		strings.TrimSpace(r.Header.Get(CitadelHeaderAppID)) != ""
}

// AuthenticateCitadelHeaders validates Nginx ForwardAuth X-Citadel-* headers, enforces timestamp
// freshness, checks HMAC-SHA256 canonical signatures, verifies Origin/Referer on mutating requests,
// and idempotently syncs the user into Inkbranch's local users table.
func (s *Service) AuthenticateCitadelHeaders(r *http.Request) (*Principal, error) {
	if !s.cfg.UsesCitadel() || strings.TrimSpace(s.cfg.CitadelHeaderHMACSecret) == "" {
		return nil, ErrUnauthorized
	}

	userID := strings.TrimSpace(r.Header.Get(CitadelHeaderUserID))
	email := strings.TrimSpace(r.Header.Get(CitadelHeaderEmail))
	name := strings.TrimSpace(r.Header.Get(CitadelHeaderName))
	globalRole := strings.TrimSpace(r.Header.Get(CitadelHeaderGlobalRole))
	appID := strings.TrimSpace(r.Header.Get(CitadelHeaderAppID))
	appRole := strings.TrimSpace(r.Header.Get(CitadelHeaderAppRole))
	permsRaw := strings.TrimSpace(r.Header.Get(CitadelHeaderPermissions))
	tsRaw := strings.TrimSpace(r.Header.Get(CitadelHeaderTimestamp))
	sig := strings.TrimSpace(r.Header.Get(CitadelHeaderSignature))

	if userID == "" || tsRaw == "" || sig == "" {
		return nil, ErrUnauthorized
	}
	if appID != s.citadelAppID() {
		return nil, ErrForbiddenApp
	}

	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return nil, ErrUnauthorized
	}
	diff := time.Now().UTC().Unix() - ts
	if diff < -citadelMaxSkewSeconds || diff > citadelMaxSkewSeconds {
		return nil, ErrUnauthorized
	}

	payload := "v1\n" +
		tsRaw + "\n" +
		appID + "\n" +
		userID + "\n" +
		email + "\n" +
		globalRole + "\n" +
		appRole + "\n" +
		permsRaw

	mac := hmac.New(sha256.New, []byte(s.cfg.CitadelHeaderHMACSecret))
	mac.Write([]byte(payload))
	expected := "v1=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return nil, ErrUnauthorized
	}

	if isMutatingMethod(r.Method) && !s.VerifyCitadelOrigin(r) {
		return nil, ErrCSRFMismatch
	}

	uid, err := uuid.Parse(userID)
	if err != nil || email == "" {
		return nil, ErrUnauthorized
	}

	user, err := s.state.EnsureCitadelUser(
		r.Context(),
		uid,
		email,
		name,
		"",
		mapLocalUserRole(globalRole, appRole),
	)
	if err != nil {
		return nil, fmt.Errorf("sync citadel user: %w", err)
	}

	return &Principal{
		User:         &user,
		AuthKind:     "forward_auth",
		AuthProvider: "citadel",
		GlobalRole:   globalRole,
		AppRole:      appRole,
		Scopes:       parsePermissionsHeader(permsRaw),
	}, nil
}

func (s *Service) authenticateCitadelBearer(ctx context.Context, rawTok string) (*Principal, error) {
	cit := s.Citadel()
	if !s.cfg.UsesCitadel() || cit == nil {
		return nil, ErrUnauthorized
	}
	res, err := cit.IntrospectToken(ctx, rawTok)
	if err != nil || res == nil || !res.Active {
		return nil, ErrUnauthorized
	}
	if res.AppID != "" && res.AppID != s.citadelAppID() {
		return nil, ErrForbiddenApp
	}
	if !strings.EqualFold(res.User.GlobalRole, "super_admin") && !res.AllowAdmin {
		return nil, ErrForbiddenApp
	}
	uid, err := uuid.Parse(strings.TrimSpace(res.User.ID))
	if err != nil || strings.TrimSpace(res.User.Email) == "" {
		return nil, ErrUnauthorized
	}
	user, err := s.state.EnsureCitadelUser(
		ctx,
		uid,
		res.User.Email,
		res.User.Name,
		res.User.AvatarURL,
		mapLocalUserRole(res.User.GlobalRole, res.AppRole),
	)
	if err != nil {
		return nil, fmt.Errorf("sync citadel bearer user: %w", err)
	}

	authKind := "citadel_pat"
	if res.TokenKind == "oauth" || strings.HasPrefix(rawTok, "cit_at_") {
		authKind = "citadel_oauth"
	}
	scopes := make([]string, 0, len(res.Scopes))
	for _, sc := range res.Scopes {
		sc = strings.TrimSpace(sc)
		if sc != "" {
			scopes = append(scopes, sc)
		}
	}
	return &Principal{
		User:         &user,
		AuthKind:     authKind,
		AuthProvider: "citadel",
		GlobalRole:   res.User.GlobalRole,
		AppRole:      res.AppRole,
		Scopes:       scopes,
	}, nil
}

func (s *Service) authenticateLocalPAT(ctx context.Context, rawTok string) (*Principal, error) {
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
		User:         user,
		AuthKind:     "pat",
		AuthProvider: "local",
		GlobalRole:   user.Role,
		AppRole:      user.Role,
		APIToken:     tokRec,
		Scopes:       tokRec.Scopes,
	}, nil
}

// VerifyCitadelOrigin checks Origin (with Referer fallback) against Citadel's public origin for ForwardAuth mutations.
func (s *Service) VerifyCitadelOrigin(r *http.Request) bool {
	return verifyRequestOriginAgainst(r, s.cfg.CitadelPublicURL)
}

// VerifyPublicOrigin checks Origin (with Referer fallback) against Inkbranch's configured SiteURL.
func (s *Service) VerifyPublicOrigin(r *http.Request) bool {
	return verifyRequestOriginAgainst(r, s.cfg.SiteURL)
}

func verifyRequestOriginAgainst(r *http.Request, expectedBase string) bool {
	expectedBase = strings.TrimSpace(expectedBase)
	if expectedBase == "" {
		return false
	}
	expectedURL, err := url.Parse(expectedBase)
	if err != nil || expectedURL.Scheme == "" || expectedURL.Host == "" {
		return false
	}

	rawCandidate := strings.TrimSpace(r.Header.Get("Origin"))
	if rawCandidate == "" {
		rawCandidate = strings.TrimSpace(r.Header.Get("Referer"))
	}
	if rawCandidate == "" || strings.EqualFold(rawCandidate, "null") {
		return false
	}
	candidateURL, err := url.Parse(rawCandidate)
	if err != nil || candidateURL.Scheme == "" || candidateURL.Host == "" {
		return false
	}
	return strings.EqualFold(candidateURL.Scheme, expectedURL.Scheme) &&
		normalizedHost(candidateURL.Scheme, candidateURL.Host) == normalizedHost(expectedURL.Scheme, expectedURL.Host)
}

func normalizedHost(scheme, host string) string {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		return strings.ToLower(host)
	}
	if (strings.EqualFold(scheme, "https") && p == "443") || (strings.EqualFold(scheme, "http") && p == "80") {
		return strings.ToLower(h)
	}
	return strings.ToLower(net.JoinHostPort(h, p))
}

func parsePermissionsHeader(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func mapLocalUserRole(globalRole, appRole string) string {
	if strings.EqualFold(globalRole, "super_admin") || strings.EqualFold(appRole, "admin") {
		return "admin"
	}
	if strings.TrimSpace(appRole) != "" {
		return strings.ToLower(strings.TrimSpace(appRole))
	}
	return "viewer"
}

func isMutatingMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

// ComputePKCES256 derives the base64url(SHA-256(verifier)) PKCE code challenge.
func ComputePKCES256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// RandomURLToken returns a cryptographically random URL-safe string.
func RandomURLToken(nBytes int) (string, error) {
	if nBytes < 16 {
		nBytes = 32
	}
	buf := make([]byte, nBytes)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// SanitizeReturnURL restricts post-login redirect targets to safe local paths.
func SanitizeReturnURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.Contains(raw, "\\") {
		return "/"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" {
		return "/"
	}
	return raw
}

// IsRequestHTTPS returns true when the deployment SiteURL uses HTTPS or the request arrived over TLS/HTTPS proxy.
func (s *Service) IsRequestHTTPS(r *http.Request) bool {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.cfg.SiteURL)), "https://") {
		return true
	}
	if r == nil {
		return false
	}
	return r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// SetPKCECookie encrypts and writes transient PKCE state into an HttpOnly SameSite=Lax cookie.
func (s *Service) SetPKCECookie(w http.ResponseWriter, r *http.Request, st PKCEState) error {
	if st.ExpiresAt.IsZero() {
		st.ExpiresAt = time.Now().UTC().Add(pkceCookieTTL)
	}
	val, err := s.sealPayload(st)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     PKCECookieName,
		Value:    val,
		Path:     "/api/v1/public/auth",
		HttpOnly: true,
		Secure:   s.IsRequestHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(pkceCookieTTL.Seconds()),
		Expires:  st.ExpiresAt,
	})
	return nil
}

// ReadPKCECookie decrypts and validates the transient PKCE cookie.
func (s *Service) ReadPKCECookie(r *http.Request) (*PKCEState, error) {
	c, err := r.Cookie(PKCECookieName)
	if err != nil || strings.TrimSpace(c.Value) == "" {
		return nil, ErrUnauthorized
	}
	var st PKCEState
	if err := s.unsealPayload(c.Value, &st); err != nil {
		return nil, ErrUnauthorized
	}
	if st.State == "" || st.Verifier == "" || time.Now().UTC().After(st.ExpiresAt) {
		return nil, ErrUnauthorized
	}
	st.ReturnTo = SanitizeReturnURL(st.ReturnTo)
	return &st, nil
}

// ClearPKCECookie expires the transient PKCE cookie.
func (s *Service) ClearPKCECookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     PKCECookieName,
		Value:    "",
		Path:     "/api/v1/public/auth",
		HttpOnly: true,
		Secure:   s.IsRequestHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0).UTC(),
	})
}

// SetReaderSessionCookie seals the reader's Citadel OAuth session into an HttpOnly SameSite=Lax cookie.
func (s *Service) SetReaderSessionCookie(w http.ResponseWriter, r *http.Request, sess ReaderSession) error {
	val, err := s.sealPayload(sess)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     ReaderSessionCookieName,
		Value:    val,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.IsRequestHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   readerCookieMaxAge,
		Expires:  time.Now().UTC().Add(time.Duration(readerCookieMaxAge) * time.Second),
	})
	return nil
}

// ClearReaderSessionCookie expires the reader session cookie.
func (s *Service) ClearReaderSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     ReaderSessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.IsRequestHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0).UTC(),
	})
}

// AuthenticateReader decrypts the reader session cookie without performing token refresh.
func (s *Service) AuthenticateReader(r *http.Request) (*ReaderSession, error) {
	if !s.cfg.UsesCitadel() {
		return nil, ErrUnauthorized
	}
	c, err := r.Cookie(ReaderSessionCookieName)
	if err != nil || strings.TrimSpace(c.Value) == "" {
		return nil, ErrUnauthorized
	}
	var sess ReaderSession
	if err := s.unsealPayload(c.Value, &sess); err != nil {
		return nil, ErrUnauthorized
	}
	if sess.UserID == "" || sess.AccessToken == "" || time.Now().UTC().After(sess.ExpiresAt) {
		return nil, ErrUnauthorized
	}
	return &sess, nil
}

// AuthenticateOrRefreshReader decrypts the reader session cookie and transparently refreshes
// near-expiry tokens when a refresh_token and Citadel client are present.
func (s *Service) AuthenticateOrRefreshReader(w http.ResponseWriter, r *http.Request) (*ReaderSession, error) {
	if !s.cfg.UsesCitadel() {
		return nil, ErrUnauthorized
	}
	c, err := r.Cookie(ReaderSessionCookieName)
	if err != nil || strings.TrimSpace(c.Value) == "" {
		return nil, ErrUnauthorized
	}
	var sess ReaderSession
	if err := s.unsealPayload(c.Value, &sess); err != nil {
		return nil, ErrUnauthorized
	}
	if sess.UserID == "" || sess.AccessToken == "" {
		return nil, ErrUnauthorized
	}
	now := time.Now().UTC()
	needsRefresh := !sess.ExpiresAt.After(now.Add(60 * time.Second))
	if !needsRefresh {
		return &sess, nil
	}
	cit := s.Citadel()
	if cit == nil || sess.RefreshToken == "" {
		if now.After(sess.ExpiresAt) {
			if w != nil {
				s.ClearReaderSessionCookie(w, r)
			}
			return nil, ErrUnauthorized
		}
		return &sess, nil
	}

	tokResp, err := cit.RefreshOAuthToken(r.Context(), sess.RefreshToken)
	if err != nil {
		if now.After(sess.ExpiresAt) {
			if w != nil {
				s.ClearReaderSessionCookie(w, r)
			}
			return nil, ErrUnauthorized
		}
		return &sess, nil
	}

	updated := ReaderSessionFromOAuthToken(tokResp)
	if updated.RefreshToken == "" {
		updated.RefreshToken = sess.RefreshToken
	}
	if w != nil {
		_ = s.SetReaderSessionCookie(w, r, updated)
	}
	return &updated, nil
}

// ReaderSessionFromOAuthToken converts Citadel's OAuth2 token response into a sealed cookie payload.
func ReaderSessionFromOAuthToken(tok *citadel.OAuthTokenResponse) ReaderSession {
	expSec := tok.ExpiresIn
	if expSec <= 0 {
		expSec = 3600
	}
	sess := ReaderSession{
		UserID:       tok.User.ID,
		Email:        tok.User.Email,
		Name:         tok.User.Name,
		AvatarURL:    tok.User.AvatarURL,
		GlobalRole:   tok.User.GlobalRole,
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiresAt:    time.Now().UTC().Add(time.Duration(expSec) * time.Second),
	}
	if tok.AppGrant != nil {
		sess.AppRole = tok.AppGrant.AppRole
		sess.AllowAdmin = tok.AppGrant.AllowAdmin
	}
	return sess
}

func (s *Service) sealPayload(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	enc, err := EncryptBytes(s.SecretKey(), raw)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(enc), nil
}

func (s *Service) unsealPayload(encoded string, dst any) error {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	plain, err := DecryptBytes(s.SecretKey(), raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, dst)
}

// UserFromStateRecord converts state.User safely; unused unless needed for sync checks.
var _ = (*state.User)(nil)
