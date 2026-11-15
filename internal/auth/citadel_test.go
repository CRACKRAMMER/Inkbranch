package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/citadel"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

const (
	testCitadelHMACSecret     = "test-citadel-header-hmac-secret-32b"
	testCitadelInternalSecret = "test-citadel-internal-secret-32b"
)

func newTestCitadelConfig(mode string) *config.Config {
	return &config.Config{
		AuthMode:                mode,
		CitadelAppID:            "inkbranch",
		CitadelInternalURL:      "http://127.0.0.1:8082",
		CitadelPublicURL:        "https://admin.crackrammer.com",
		CitadelInternalSecret:   testCitadelInternalSecret,
		CitadelHeaderHMACSecret: testCitadelHMACSecret,
		SiteURL:                 "https://blog.crackrammer.com",
		SessionSecret:           "0123456789abcdef0123456789abcdef",
	}
}

func signTestCitadelHeaders(r *http.Request, secret, ts, appID, uid, email, globalRole, appRole, perms string) {
	payload := "v1\n" + ts + "\n" + appID + "\n" + uid + "\n" + email + "\n" + globalRole + "\n" + appRole + "\n" + perms
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := "v1=" + hex.EncodeToString(mac.Sum(nil))

	r.Header.Set(CitadelHeaderUserID, uid)
	r.Header.Set(CitadelHeaderEmail, email)
	r.Header.Set(CitadelHeaderName, "Alice")
	r.Header.Set(CitadelHeaderGlobalRole, globalRole)
	r.Header.Set(CitadelHeaderAppID, appID)
	r.Header.Set(CitadelHeaderAppRole, appRole)
	r.Header.Set(CitadelHeaderPermissions, perms)
	r.Header.Set(CitadelHeaderTimestamp, ts)
	r.Header.Set(CitadelHeaderSignature, sig)
}

func TestAuthenticateCitadelHeaders_SuccessAndUserSync(t *testing.T) {
	store := state.NewMemoryStore()
	svc := NewService(newTestCitadelConfig(config.AuthModeHybrid), store)

	uid := uuid.New()
	nowTS := strconv.FormatInt(time.Now().UTC().Unix(), 10)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	signTestCitadelHeaders(
		req,
		testCitadelHMACSecret,
		nowTS,
		"inkbranch",
		uid.String(),
		"alice@example.com",
		"user",
		"editor",
		"content:read, content:write, comments:moderate",
	)

	principal, err := svc.AuthenticateCitadelHeaders(req)
	if err != nil {
		t.Fatalf("expected valid forward_auth, got err=%v", err)
	}
	if principal.AuthKind != "forward_auth" || principal.AuthProvider != "citadel" {
		t.Fatalf("unexpected auth metadata: kind=%s provider=%s", principal.AuthKind, principal.AuthProvider)
	}
	if principal.User == nil || principal.User.ID != uid || principal.User.Role != "editor" {
		t.Fatalf("unexpected synced user: %+v", principal.User)
	}
	if principal.User.PasswordHash != "!citadel-managed!" {
		t.Fatalf("expected !citadel-managed! password hash, got %q", principal.User.PasswordHash)
	}
	if len(principal.Scopes) != 3 {
		t.Fatalf("expected 3 parsed scopes, got %v", principal.Scopes)
	}

	// Repeat call with upgraded role should preserve UUID idempotently and reflect Citadel role on Principal.
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	signTestCitadelHeaders(req2, testCitadelHMACSecret, nowTS, "inkbranch", uid.String(), "alice@example.com", "user", "admin", "admin:*")
	req2.Header.Set(CitadelHeaderName, "Alice Renamed")
	principal2, err := svc.AuthenticateCitadelHeaders(req2)
	if err != nil {
		t.Fatalf("second forward_auth failed: %v", err)
	}
	if principal2.User.ID != uid || principal2.User.Name != "Alice Renamed" || principal2.AppRole != "admin" || !principal2.HasScope("admin:*") {
		t.Fatalf("expected same UUID synced with new name and Citadel admin role, got user=%+v appRole=%s", principal2.User, principal2.AppRole)
	}

	// Email conflict reuse: a different local UUID sharing the email should be reused cleanly.
	legacyID := uuid.New()
	if _, err := store.EnsureCitadelUser(t.Context(), legacyID, "bob@example.com", "Bob Old", "", "viewer"); err != nil {
		t.Fatalf("seed legacy user: %v", err)
	}
	citadelBobID := uuid.New()
	req3 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	signTestCitadelHeaders(req3, testCitadelHMACSecret, nowTS, "inkbranch", citadelBobID.String(), "bob@example.com", "user", "editor", "content:read,content:write")
	principal3, err := svc.AuthenticateCitadelHeaders(req3)
	if err != nil {
		t.Fatalf("email conflict EnsureCitadelUser failed: %v", err)
	}
	if principal3.User.ID != legacyID {
		t.Fatalf("expected email conflict reuse to preserve legacy ID %s, got %s", legacyID, principal3.User.ID)
	}
	if principal3.AppRole != "editor" || principal3.User.Name != "Alice" {
		t.Fatalf("expected email conflict reuse to sync name and expose appRole=editor, got user=%+v appRole=%s", principal3.User, principal3.AppRole)
	}
}

func TestAuthenticateCitadelHeaders_SecurityChecks(t *testing.T) {
	store := state.NewMemoryStore()
	svc := NewService(newTestCitadelConfig(config.AuthModeCitadelOnly), store)
	uid := uuid.New().String()
	now := time.Now().UTC().Unix()

	t.Run("expired_past_timestamp", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now-65, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected ErrUnauthorized for expired timestamp, got %v", err)
		}
	})

	t.Run("expired_future_timestamp", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now+65, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected ErrUnauthorized for future timestamp, got %v", err)
		}
	})

	t.Run("tampered_permissions", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "viewer", "content:read")
		req.Header.Set(CitadelHeaderPermissions, "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected ErrUnauthorized for tampered permissions, got %v", err)
		}
	})

	t.Run("tampered_signature", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "viewer", "content:read")
		req.Header.Set(CitadelHeaderSignature, "v1=0000000000000000")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected ErrUnauthorized for tampered signature, got %v", err)
		}
	})

	t.Run("wrong_app_id", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkplay", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrForbiddenApp) {
			t.Fatalf("expected ErrForbiddenApp for wrong app_id, got %v", err)
		}
	})

	t.Run("mutation_missing_origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrCSRFMismatch) {
			t.Fatalf("expected ErrCSRFMismatch when Origin/Referer missing, got %v", err)
		}
	})

	t.Run("mutation_bad_origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
		req.Header.Set("Origin", "https://evil.example")
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrCSRFMismatch) {
			t.Fatalf("expected ErrCSRFMismatch for evil Origin, got %v", err)
		}
	})

	t.Run("mutation_null_origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
		req.Header.Set("Origin", "Null")
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); !errors.Is(err, ErrCSRFMismatch) {
			t.Fatalf("expected ErrCSRFMismatch for null Origin, got %v", err)
		}
	})

	t.Run("mutation_valid_origin_with_default_port", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
		req.Header.Set("Origin", "https://admin.crackrammer.com:443")
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); err != nil {
			t.Fatalf("expected valid Origin with default HTTPS port to pass, got %v", err)
		}
	})

	t.Run("mutation_valid_referer_fallback", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/posts/1", nil)
		req.Header.Set("Referer", "https://admin.crackrammer.com/blog/posts")
		signTestCitadelHeaders(req, testCitadelHMACSecret, strconv.FormatInt(now, 10), "inkbranch", uid, "a@example.com", "user", "admin", "admin")
		if _, err := svc.AuthenticateCitadelHeaders(req); err != nil {
			t.Fatalf("expected valid Referer fallback to pass, got %v", err)
		}
	})
}

func TestPrincipalHasScopeMatrix(t *testing.T) {
	viewer := &Principal{AuthKind: "forward_auth", GlobalRole: "user", AppRole: "viewer", Scopes: []string{"content:read"}}
	if !viewer.HasScope("content:read") || viewer.HasScope("content:write") || viewer.HasScope("comments:moderate") || viewer.HasScope("admin") {
		t.Fatalf("unexpected viewer scope evaluation")
	}

	editor := &Principal{AuthKind: "forward_auth", GlobalRole: "user", AppRole: "editor", Scopes: []string{"content:read", "content:write", "media:write", "comments:moderate"}}
	for _, s := range []string{"content:read", "content:write", "media:write", "comments:moderate"} {
		if !editor.HasScope(s) {
			t.Fatalf("expected editor to have scope %s", s)
		}
	}
	if editor.HasScope("admin:*") {
		t.Fatalf("editor must not have admin:* scope")
	}

	appAdmin := &Principal{AuthKind: "forward_auth", GlobalRole: "user", AppRole: "admin", Scopes: []string{"admin:*"}}
	if !appAdmin.HasScope("content:write") || !appAdmin.HasScope("admin:*") {
		t.Fatalf("admin:* scope should grant all scopes")
	}

	superForward := &Principal{AuthKind: "forward_auth", GlobalRole: "super_admin", AppRole: "viewer", Scopes: []string{"content:read"}}
	if !superForward.HasScope("admin:*") || !superForward.HasScope("content:write") {
		t.Fatalf("super_admin ForwardAuth must bypass scope restrictions")
	}

	superScopedPAT := &Principal{AuthKind: "citadel_pat", GlobalRole: "super_admin", AppRole: "admin", Scopes: []string{"content:read"}}
	if !superScopedPAT.HasScope("content:read") || superScopedPAT.HasScope("content:write") || superScopedPAT.HasScope("admin:*") {
		t.Fatalf("citadel_pat with explicit scopes must enforce those scopes even for super_admin")
	}

	superEmptyPAT := &Principal{AuthKind: "citadel_pat", GlobalRole: "super_admin", AppRole: "admin"}
	if !superEmptyPAT.HasScope("admin:*") {
		t.Fatalf("citadel_pat for super_admin with empty scopes should default to allow")
	}

	localSession := &Principal{AuthKind: "session"}
	if !localSession.HasScope("admin") || !localSession.HasScope("content:write") {
		t.Fatalf("local session should have full scope access")
	}
}

func TestCitadelOnlyBlocksLocalAuthButAllowsLocalPAT(t *testing.T) {
	store := state.NewMemoryStore()
	hybridCfg := newTestCitadelConfig(config.AuthModeHybrid)
	hybridCfg.AdminEmail = "owner@example.com"
	hybridCfg.AdminInitPassword = "StrongPassword123!"
	hybridCfg.AdminPasswordFile = filepath.Join(t.TempDir(), ".pw")
	if _, _, err := EnsureInitialAdmin(t.Context(), store, hybridCfg); err != nil {
		t.Fatalf("EnsureInitialAdmin: %v", err)
	}
	hybridSvc := NewService(hybridCfg, store)
	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	outcome, err := hybridSvc.LoginWithPassword(t.Context(), "owner@example.com", "StrongPassword123!", loginReq)
	if err != nil || outcome == nil || outcome.CookieToken == "" {
		t.Fatalf("hybrid LoginWithPassword failed: %v %+v", err, outcome)
	}
	user := outcome.User

	// Confirm the session works in hybrid mode first.
	sessionReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/posts", nil)
	sessionReq.AddCookie(&http.Cookie{Name: SessionCookieName, Value: outcome.CookieToken})
	if _, err := hybridSvc.AuthenticateRequest(sessionReq); err != nil {
		t.Fatalf("expected ibr_session to succeed in hybrid mode, got %v", err)
	}

	svc := NewService(newTestCitadelConfig(config.AuthModeCitadelOnly), store)

	// Local login methods must all return ErrLocalAuthDisabled in citadel_only.
	if _, err := svc.LoginWithPassword(t.Context(), "owner@example.com", "StrongPassword123!", loginReq); !errors.Is(err, ErrLocalAuthDisabled) {
		t.Fatalf("LoginWithPassword expected ErrLocalAuthDisabled, got %v", err)
	}
	if _, err := svc.VerifyMFACode(t.Context(), "pending", "123456", loginReq); !errors.Is(err, ErrLocalAuthDisabled) {
		t.Fatalf("VerifyMFACode expected ErrLocalAuthDisabled, got %v", err)
	}
	if _, _, err := svc.BeginPasskeyLogin(t.Context(), "owner@example.com", loginReq); !errors.Is(err, ErrLocalAuthDisabled) {
		t.Fatalf("BeginPasskeyLogin expected ErrLocalAuthDisabled, got %v", err)
	}
	if _, err := svc.FinishPasskeyLogin(t.Context(), "ceremony-id", loginReq); !errors.Is(err, ErrLocalAuthDisabled) {
		t.Fatalf("FinishPasskeyLogin expected ErrLocalAuthDisabled, got %v", err)
	}

	// Legacy ibr_session cookie must be rejected in citadel_only.
	if _, err := svc.AuthenticateRequest(sessionReq); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for ibr_session in citadel_only, got %v", err)
	}

	// Legacy local PATs (ibr_pat_* and pat_*) must still succeed via passthrough.
	var patPrincipal *Principal
	for _, rawPAT := range []string{"ibr_pat_legacy_test_token_12345", "pat_legacy_test_token_67890"} {
		pat := state.APITokenRecord{
			ID:          uuid.New(),
			UserID:      user.ID,
			Name:        "Legacy CI " + rawPAT[:8],
			TokenPrefix: rawPAT[:12],
			TokenHash:   HashToken(rawPAT),
			Scopes:      []string{"content:read", "content:write"},
			CreatedAt:   time.Now().UTC(),
		}
		if err := store.CreateAPIToken(t.Context(), pat); err != nil {
			t.Fatalf("create local PAT %s: %v", rawPAT, err)
		}

		patReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/posts", nil)
		patReq.Header.Set("Authorization", "Bearer "+rawPAT)
		p, err := svc.AuthenticateRequest(patReq)
		if err != nil {
			t.Fatalf("expected legacy local PAT %s to work in citadel_only, got %v", rawPAT, err)
		}
		if p.AuthKind != "pat" || p.AuthProvider != "local" {
			t.Fatalf("unexpected local PAT principal for %s: kind=%s provider=%s", rawPAT, p.AuthKind, p.AuthProvider)
		}
		patPrincipal = p
	}

	// VerifyCSRF checks Origin for forward_auth and bypasses for Bearer PATs.
	badOriginReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
	badOriginReq.Header.Set("Origin", "https://evil.example")
	if svc.VerifyCSRF(badOriginReq, &Principal{AuthKind: "forward_auth"}) {
		t.Fatalf("VerifyCSRF must reject mismatched Origin for forward_auth")
	}
	goodOriginReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/posts", nil)
	goodOriginReq.Header.Set("Origin", "https://admin.crackrammer.com")
	if !svc.VerifyCSRF(goodOriginReq, &Principal{AuthKind: "forward_auth"}) {
		t.Fatalf("VerifyCSRF must accept Citadel public Origin for forward_auth")
	}
	if !svc.VerifyCSRF(badOriginReq, patPrincipal) {
		t.Fatalf("VerifyCSRF should allow local PAT requests without browser Origin check")
	}
}

func TestCitadelClientIntrospectCacheAndExpiry(t *testing.T) {
	var calls atomic.Int32
	expAt := time.Now().UTC().Truncate(time.Second).Add(2 * time.Second).Format(time.RFC3339)

	mockCitadel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/auth/introspect" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+testCitadelInternalSecret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(citadel.IntrospectResult{
			Active:     true,
			TokenKind:  "pat",
			AppID:      "inkbranch",
			AllowLogin: true,
			AllowAdmin: true,
			AppRole:    "editor",
			Scopes:     []string{"content:read", "content:write"},
			ExpiresAt:  expAt,
			User: citadel.UserInfo{
				ID:         uuid.NewString(),
				Email:      "pat@example.com",
				Name:       "PAT User",
				GlobalRole: "user",
			},
		})
	}))
	defer mockCitadel.Close()

	client := citadel.NewClient(citadel.Config{
		AppID:          "inkbranch",
		InternalURL:    mockCitadel.URL,
		PublicURL:      "https://admin.crackrammer.com",
		InternalSecret: testCitadelInternalSecret,
		SiteURL:        "https://blog.crackrammer.com",
	}, nil)

	res1, err := client.IntrospectToken(t.Context(), "cit_pat_abc123")
	if err != nil {
		t.Fatalf("first IntrospectToken failed: %v", err)
	}
	if !res1.Active || res1.AppRole != "editor" {
		t.Fatalf("unexpected introspect result: %+v", res1)
	}
	// Mutate caller slice to verify defensive cloning in cache.
	res1.Scopes[0] = "tampered"

	res2, err := client.IntrospectToken(t.Context(), "cit_pat_abc123")
	if err != nil {
		t.Fatalf("second IntrospectToken failed: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected cached IntrospectToken (calls=1), got calls=%d", calls.Load())
	}
	if res2.Scopes[0] != "content:read" {
		t.Fatalf("cache was mutated by caller: %v", res2.Scopes)
	}

	// Explicitly invalidating cache forces a fresh HTTP lookup immediately.
	client.InvalidateTokenCache("cit_pat_abc123")
	if _, err := client.IntrospectToken(t.Context(), "cit_pat_abc123"); err != nil {
		t.Fatalf("post-invalidation IntrospectToken failed: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("expected calls=2 after InvalidateTokenCache, got %d", calls.Load())
	}

	// Sleeping past capped ExpiresAt expires the 15s cache entry automatically.
	time.Sleep(2100 * time.Millisecond)
	if _, err := client.IntrospectToken(t.Context(), "cit_pat_abc123"); err != nil {
		t.Fatalf("post-expiry IntrospectToken failed: %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("expected calls=3 after cache TTL expiry, got %d", calls.Load())
	}
}

func TestPKCEAndReaderSessionSealUnsealAndRefresh(t *testing.T) {
	var refreshCalls atomic.Int32
	mockCitadel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/oauth/token" {
			http.NotFound(w, r)
			return
		}
		refreshCalls.Add(1)
		_ = json.NewEncoder(w).Encode(citadel.OAuthTokenResponse{
			AccessToken:  "cit_at_refreshed_new",
			TokenType:    "Bearer",
			ExpiresIn:    3600,
			RefreshToken: "cit_rt_rotated_new",
			Scope:        "profile email",
			User: citadel.UserInfo{
				ID:         uuid.NewString(),
				Email:      "reader@example.com",
				Name:       "Reader Updated",
				GlobalRole: "user",
			},
			AppGrant: &citadel.OAuthAppGrant{
				AllowLogin:  true,
				AllowAdmin:  false,
				AppRole:     "viewer",
				Permissions: []string{"content:read"},
			},
		})
	}))
	defer mockCitadel.Close()

	cfg := newTestCitadelConfig(config.AuthModeCitadelOnly)
	cfg.CitadelInternalURL = mockCitadel.URL
	store := state.NewMemoryStore()
	svc := NewService(cfg, store)
	svc.SetCitadel(citadel.NewClient(citadel.Config{
		AppID:          cfg.CitadelAppID,
		InternalURL:    cfg.CitadelInternalURL,
		PublicURL:      cfg.CitadelPublicURL,
		InternalSecret: cfg.CitadelInternalSecret,
		SiteURL:        cfg.SiteURL,
	}, nil))

	// SanitizeReturnURL rejects open redirects.
	for _, bad := range []string{"", "https://evil.com", "//evil.com/path", `/\evil.com`, "javascript:alert(1)"} {
		if got := SanitizeReturnURL(bad); got != "/" {
			t.Fatalf("SanitizeReturnURL(%q) = %q, want /", bad, got)
		}
	}
	if got := SanitizeReturnURL("/posts/hello-world?page=2#comments"); got != "/posts/hello-world?page=2#comments" {
		t.Fatalf("unexpected sanitized local return URL: %q", got)
	}

	// PKCE cookie round-trip.
	wPKCE := httptest.NewRecorder()
	rPKCE := httptest.NewRequest(http.MethodGet, "/api/v1/public/auth/login", nil)
	if err := svc.SetPKCECookie(wPKCE, rPKCE, PKCEState{
		State:    "state-123",
		Verifier: "verifier-abc",
		ReturnTo: "/posts/test",
	}); err != nil {
		t.Fatalf("SetPKCECookie failed: %v", err)
	}
	readPKCEReq := httptest.NewRequest(http.MethodGet, "/api/v1/public/auth/callback", nil)
	for _, c := range wPKCE.Result().Cookies() {
		readPKCEReq.AddCookie(c)
	}
	unsealedPKCE, err := svc.ReadPKCECookie(readPKCEReq)
	if err != nil {
		t.Fatalf("ReadPKCECookie failed: %v", err)
	}
	if unsealedPKCE.State != "state-123" || unsealedPKCE.Verifier != "verifier-abc" || unsealedPKCE.ReturnTo != "/posts/test" {
		t.Fatalf("unexpected unsealed PKCE state: %+v", unsealedPKCE)
	}

	// Reader session seal, unseal, and transparent near-expiry refresh.
	wNear := httptest.NewRecorder()
	rBase := httptest.NewRequest(http.MethodGet, "/api/v1/public/auth/me", nil)
	err = svc.SetReaderSessionCookie(wNear, rBase, ReaderSession{
		UserID:       uuid.NewString(),
		Email:        "reader@example.com",
		Name:         "Reader Old",
		AccessToken:  "cit_at_old",
		RefreshToken: "cit_rt_old",
		ExpiresAt:    time.Now().UTC().Add(20 * time.Second), // within 60s refresh window
	})
	if err != nil {
		t.Fatalf("SetReaderSessionCookie failed: %v", err)
	}

	authReq := httptest.NewRequest(http.MethodGet, "/api/v1/public/auth/me", nil)
	for _, c := range wNear.Result().Cookies() {
		authReq.AddCookie(c)
	}
	// First verify AuthenticateReader (without refresh) still reads valid non-expired token.
	nonRefreshed, err := svc.AuthenticateReader(authReq)
	if err != nil || nonRefreshed.AccessToken != "cit_at_old" {
		t.Fatalf("AuthenticateReader failed: %v %+v", err, nonRefreshed)
	}

	wRefresh := httptest.NewRecorder()
	refreshed, err := svc.AuthenticateOrRefreshReader(wRefresh, authReq)
	if err != nil {
		t.Fatalf("AuthenticateOrRefreshReader failed: %v", err)
	}
	if refreshCalls.Load() != 1 {
		t.Fatalf("expected 1 refresh call, got %d", refreshCalls.Load())
	}
	if refreshed.AccessToken != "cit_at_refreshed_new" || refreshed.RefreshToken != "cit_rt_rotated_new" || refreshed.Name != "Reader Updated" {
		t.Fatalf("unexpected refreshed reader session: %+v", refreshed)
	}

	// Ensure rotated cookie written back onto response can be read without hitting Citadel again.
	followReq := httptest.NewRequest(http.MethodGet, "/api/v1/public/auth/me", nil)
	for _, c := range wRefresh.Result().Cookies() {
		followReq.AddCookie(c)
	}
	followSess, err := svc.AuthenticateOrRefreshReader(httptest.NewRecorder(), followReq)
	if err != nil || followSess.AccessToken != "cit_at_refreshed_new" {
		t.Fatalf("expected rotated cookie to stay valid without second refresh: %v %+v", err, followSess)
	}
	if refreshCalls.Load() != 1 {
		t.Fatalf("expected still 1 refresh call, got %d", refreshCalls.Load())
	}
}
