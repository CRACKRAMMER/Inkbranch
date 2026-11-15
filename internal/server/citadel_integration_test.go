package server_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/citadel"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/server"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

const (
	intTestInternalSecret = "citadel-int-test-internal-secret"
	intTestHMACSecret     = "citadel-int-test-hmac-secret"
)

type citadelIntegrationHarness struct {
	t            *testing.T
	srv          *server.Server
	cfg          *config.Config
	state        *state.MemoryStore
	authSvc      *auth.Service
	citClient    *citadel.Client
	mockCitadel  *httptest.Server
	uploadsDir   string
	regMu        sync.Mutex
	lastRegister *citadel.RegisterPayload
	editorUUID   string
	readerUUID   string
}

func newCitadelIntegrationHarness(t *testing.T, authMode string) *citadelIntegrationHarness {
	t.Helper()
	tmp := t.TempDir()
	contentDir := filepath.Join(tmp, "content")
	uploadsDir := filepath.Join(tmp, "uploads")
	backupsDir := filepath.Join(tmp, "backups")
	passFile := filepath.Join(tmp, ".inkbranch-initial-admin-password")

	for _, dir := range []string{
		filepath.Join(contentDir, "posts"),
		filepath.Join(contentDir, "notes"),
		filepath.Join(contentDir, "projects"),
		uploadsDir,
		backupsDir,
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	pubPost := `---
title: Published Sentinel Post
slug: published-sentinel
date: 2026-10-01T10:00:00Z
status: published
description: Summary sentinel excerpt
tags: [go, citadel]
category: Engineering
comments: true
---

Intro paragraph here.
`
	if err := os.WriteFile(filepath.Join(contentDir, "posts", "published-sentinel.md"), []byte(pubPost), 0o644); err != nil {
		t.Fatal(err)
	}
	draftPost := `---
title: Unreleased Secret Draft
slug: secret-draft
date: 2026-10-02T10:00:00Z
status: draft
description: Draft preview check
tags: [draft]
---

Draft body.
`
	if err := os.WriteFile(filepath.Join(contentDir, "posts", "secret-draft.md"), []byte(draftPost), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &citadelIntegrationHarness{
		t:          t,
		uploadsDir: uploadsDir,
		editorUUID: uuid.NewString(),
		readerUUID: uuid.NewString(),
	}

	h.mockCitadel = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+intTestInternalSecret {
			http.Error(w, "unauthorized internal request", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/internal/v1/apps/register":
			var p citadel.RegisterPayload
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			h.regMu.Lock()
			h.lastRegister = &p
			h.regMu.Unlock()
			_ = json.NewEncoder(w).Encode(citadel.RegisterResponse{
				AppID:         "inkbranch",
				OAuthClientID: "cit_app_inkbranch",
				LoginPolicy:   "open",
				RegisteredAt:  time.Now().UTC().Format(time.RFC3339),
			})
		case "/internal/v1/auth/introspect":
			var req struct {
				Token string `json:"token"`
				AppID string `json:"app_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			switch req.Token {
			case "cit_pat_editor":
				_ = json.NewEncoder(w).Encode(citadel.IntrospectResult{
					Active:     true,
					TokenKind:  "pat",
					AppID:      "inkbranch",
					AllowLogin: true,
					AllowAdmin: true,
					AppRole:    "editor",
					Scopes:     []string{"content:read", "content:write"},
					ExpiresAt:  time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
					User: citadel.UserInfo{
						ID:         h.editorUUID,
						Email:      "editor@example.com",
						Name:       "Editor Alice",
						GlobalRole: "user",
					},
				})
			case "cit_at_reader":
				_ = json.NewEncoder(w).Encode(citadel.IntrospectResult{
					Active:     true,
					TokenKind:  "oauth",
					AppID:      "inkbranch",
					AllowLogin: true,
					AllowAdmin: false,
					AppRole:    "viewer",
					Scopes:     []string{"content:read"},
					ExpiresAt:  time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
					User: citadel.UserInfo{
						ID:         h.readerUUID,
						Email:      "reader@example.com",
						Name:       "Reader Bob",
						GlobalRole: "user",
					},
				})
			case "cit_at_editor":
				_ = json.NewEncoder(w).Encode(citadel.IntrospectResult{
					Active:     true,
					TokenKind:  "oauth",
					AppID:      "inkbranch",
					AllowLogin: true,
					AllowAdmin: true,
					AppRole:    "editor",
					Scopes:     []string{"content:read", "content:write", "media:write", "comments:moderate"},
					ExpiresAt:  time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
					User: citadel.UserInfo{
						ID:         h.editorUUID,
						Email:      "editor@example.com",
						Name:       "Editor Alice",
						GlobalRole: "user",
					},
				})
			default:
				_ = json.NewEncoder(w).Encode(citadel.IntrospectResult{Active: false})
			}
		case "/internal/v1/oauth/token":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body["grant_type"] != "authorization_code" ||
				body["client_id"] != "cit_app_inkbranch" ||
				body["code"] != "auth_code_1" ||
				body["redirect_uri"] != "https://blog.crackrammer.com/api/v1/public/auth/callback" ||
				strings.TrimSpace(body["code_verifier"]) == "" {
				http.Error(w, "invalid oauth grant", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(citadel.OAuthTokenResponse{
				AccessToken:  "cit_at_editor",
				TokenType:    "Bearer",
				ExpiresIn:    3600,
				RefreshToken: "cit_rt_editor",
				Scope:        "profile email",
				User: citadel.UserInfo{
					ID:         h.editorUUID,
					Email:      "editor@example.com",
					Name:       "Editor Alice",
					GlobalRole: "user",
				},
				AppGrant: &citadel.OAuthAppGrant{
					AllowLogin:  true,
					AllowAdmin:  true,
					AppRole:     "editor",
					Permissions: []string{"content:read", "content:write", "media:write", "comments:moderate"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(h.mockCitadel.Close)

	cfg := &config.Config{
		Port:                    3000,
		Host:                    "127.0.0.1",
		SiteURL:                 "https://blog.crackrammer.com",
		SiteName:                "Inkbranch",
		SiteDescription:         "Personal Knowledge System & Modern Publishing Platform",
		SessionSecret:           "citadel-integration-secret-key-0123456789abcdef",
		ContentDir:              contentDir,
		UploadsDir:              uploadsDir,
		BackupsDir:              backupsDir,
		StorageDriver:           "local",
		AdminEmail:              "crackrammer@gmail.com",
		AdminName:               "CRACKRAMMER",
		AdminPasswordFile:       passFile,
		SMTPFrom:                "Inkbranch <noreply@blog.crackrammer.com>",
		AuthMode:                authMode,
		CitadelAppID:            "inkbranch",
		CitadelInternalURL:      h.mockCitadel.URL,
		CitadelPublicURL:        "https://admin.crackrammer.com",
		CitadelInternalSecret:   intTestInternalSecret,
		CitadelHeaderHMACSecret: intTestHMACSecret,
	}

	st := state.NewMemoryStore()
	mdRenderer := markdown.NewRenderer()
	contentStore := content.NewStore(contentDir, func(doc *content.Document, resolver content.LinkResolver) (string, []content.OutgoingLink, error) {
		res, err := mdRenderer.Render(doc.Checksum, doc.Body, resolver)
		if err != nil {
			return "", nil, err
		}
		if len(res.Headings) > 0 {
			doc.Headings = res.Headings
		}
		return res.HTML, res.Links, nil
	})
	if _, valErrs, err := contentStore.LoadAll(); err != nil || len(valErrs) > 0 {
		t.Fatalf("LoadAll failed: err=%v valErrs=%v", err, valErrs)
	}

	ogRenderer, err := media.NewOGRenderer()
	if err != nil {
		t.Fatal(err)
	}
	webhooks := distribution.NewWebhookDispatcher(cfg, st)
	webhooks.AllowPrivateForTest = true
	poller := community.NewFeedPoller()
	poller.AllowPrivateForTest = true

	authSvc := auth.NewService(cfg, st)
	citClient := citadel.NewClient(citadel.Config{
		AppID:          cfg.CitadelAppID,
		InternalURL:    cfg.CitadelInternalURL,
		PublicURL:      cfg.CitadelPublicURL,
		InternalSecret: cfg.CitadelInternalSecret,
		SiteURL:        cfg.SiteURL,
		UpstreamURL:    "http://127.0.0.1:3000",
	}, nil)
	authSvc.SetCitadel(citClient)

	srv, err := server.New(server.Options{
		Config:   cfg,
		State:    st,
		Auth:     authSvc,
		Storage:  media.NewLocalStorage(uploadsDir),
		Mailer:   &distribution.MemoryMailer{},
		Webhooks: webhooks,
		Poller:   poller,
		Store:    contentStore,
		MD:       mdRenderer,
		OG:       ogRenderer,
		Version:  "2.0.0-citadel-test",
	})
	if err != nil {
		t.Fatalf("server.New failed: %v", err)
	}

	h.srv = srv
	h.cfg = cfg
	h.state = st
	h.authSvc = authSvc
	h.citClient = citClient
	return h
}

func (h *citadelIntegrationHarness) doRequest(method, target string, payload any, cookies []*http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	h.t.Helper()
	var bodyReader io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			h.t.Fatalf("marshal payload: %v", err)
		}
		bodyReader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, target, bodyReader)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		if c != nil {
			req.AddCookie(c)
		}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func forwardAuthHeaders(uid, email, globalRole, appRole, perms string) map[string]string {
	ts := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	payload := "v1\n" + ts + "\n" + "inkbranch\n" + uid + "\n" + email + "\n" + globalRole + "\n" + appRole + "\n" + perms
	mac := hmac.New(sha256.New, []byte(intTestHMACSecret))
	mac.Write([]byte(payload))
	sig := "v1=" + hex.EncodeToString(mac.Sum(nil))
	return map[string]string{
		auth.CitadelHeaderUserID:      uid,
		auth.CitadelHeaderEmail:       email,
		auth.CitadelHeaderName:        "Citadel User",
		auth.CitadelHeaderGlobalRole:  globalRole,
		auth.CitadelHeaderAppID:       "inkbranch",
		auth.CitadelHeaderAppRole:     appRole,
		auth.CitadelHeaderPermissions: perms,
		auth.CitadelHeaderTimestamp:   ts,
		auth.CitadelHeaderSignature:   sig,
	}
}

func findCookieNamed(rec *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name && c.Value != "" {
			return c
		}
	}
	return nil
}

func TestCitadelStartupRegistrationManifest(t *testing.T) {
	h := newCitadelIntegrationHarness(t, config.AuthModeCitadelOnly)

	resp, err := h.citClient.RegisterApp(context.Background())
	if err != nil {
		t.Fatalf("RegisterApp failed: %v", err)
	}
	if resp.AppID != "inkbranch" || resp.OAuthClientID != "cit_app_inkbranch" {
		t.Fatalf("unexpected register response: %+v", resp)
	}

	h.regMu.Lock()
	reg := h.lastRegister
	h.regMu.Unlock()
	if reg == nil {
		t.Fatalf("expected mock Citadel to receive RegisterPayload")
	}
	if reg.AppID != "inkbranch" || reg.AdminPath != "/blog/" || !reg.LegacyTokenPassthrough {
		t.Fatalf("unexpected register metadata: %+v", reg)
	}
	if reg.PreservePolicy == nil || !*reg.PreservePolicy {
		t.Fatalf("expected preserve_policy=true, got %+v", reg.PreservePolicy)
	}
	if len(reg.OAuthRedirectURIs) != 1 || reg.OAuthRedirectURIs[0] != "https://blog.crackrammer.com/api/v1/public/auth/callback" {
		t.Fatalf("unexpected oauth_redirect_uris: %v", reg.OAuthRedirectURIs)
	}
	if len(reg.DefinedRoles) != 3 ||
		reg.DefinedRoles[0].Role != "viewer" ||
		reg.DefinedRoles[1].Role != "editor" ||
		reg.DefinedRoles[2].Role != "admin" {
		t.Fatalf("unexpected defined_roles: %+v", reg.DefinedRoles)
	}
}

func TestCitadelStudioSubpathForwardAuthRBACAndPAT(t *testing.T) {
	h := newCitadelIntegrationHarness(t, config.AuthModeCitadelOnly)

	// 1. Subpath /blog routing, embedded assets, chroma CSS, and uploads rewrite.
	recRedir := h.doRequest(http.MethodGet, "/blog", nil, nil, nil)
	if recRedir.Code != http.StatusFound || recRedir.Header().Get("Location") != "/blog/" {
		t.Fatalf("GET /blog expected 302 -> /blog/, got %d %q", recRedir.Code, recRedir.Header().Get("Location"))
	}

	recShell := h.doRequest(http.MethodGet, "/blog/", nil, nil, nil)
	if recShell.Code != http.StatusOK {
		t.Fatalf("GET /blog/ expected 200, got %d body=%s", recShell.Code, recShell.Body.String())
	}
	shellBody := recShell.Body.String()
	if !strings.Contains(shellBody, "/blog/assets/") {
		t.Fatalf("expected /blog/ shell to reference /blog/assets/, got: %s", shellBody)
	}
	if !strings.Contains(strings.ToLower(recShell.Header().Get("X-Robots-Tag")), "noindex") {
		t.Fatalf("expected noindex X-Robots-Tag on /blog/, got %q", recShell.Header().Get("X-Robots-Tag"))
	}

	assetMatch := regexp.MustCompile(`/blog/assets/[^"']+\.js`).FindString(shellBody)
	if assetMatch == "" {
		t.Fatalf("expected built admin JS asset URL inside /blog/ shell")
	}
	recAsset := h.doRequest(http.MethodGet, assetMatch, nil, nil, nil)
	if recAsset.Code != http.StatusOK {
		t.Fatalf("GET %s expected 200, got %d", assetMatch, recAsset.Code)
	}

	recCSS := h.doRequest(http.MethodGet, "/blog/api/chroma.css", nil, nil, nil)
	if recCSS.Code != http.StatusOK || !strings.Contains(strings.ToLower(recCSS.Header().Get("Content-Type")), "text/css") {
		t.Fatalf("GET /blog/api/chroma.css expected 200 text/css, got %d %q", recCSS.Code, recCSS.Header().Get("Content-Type"))
	}

	if err := os.WriteFile(filepath.Join(h.uploadsDir, "test.txt"), []byte("citadel-upload-smoke"), 0o644); err != nil {
		t.Fatal(err)
	}
	recUpload := h.doRequest(http.MethodGet, "/blog/uploads/test.txt", nil, nil, nil)
	if recUpload.Code != http.StatusOK || recUpload.Body.String() != "citadel-upload-smoke" {
		t.Fatalf("GET /blog/uploads/test.txt expected 200 smoke file, got %d %q", recUpload.Code, recUpload.Body.String())
	}

	// 2. Legacy /admin* redirect & local login disabled in citadel_only.
	for _, path := range []string{"/admin", "/admin/posts"} {
		rec := h.doRequest(http.MethodGet, path, nil, nil, nil)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "https://admin.crackrammer.com/blog/" {
			t.Fatalf("GET %s expected 302 -> https://admin.crackrammer.com/blog/, got %d %q", path, rec.Code, rec.Header().Get("Location"))
		}
	}
	recLogin := h.doRequest(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"email":    "crackrammer@gmail.com",
		"password": "any",
	}, nil, nil)
	if recLogin.Code != http.StatusForbidden {
		t.Fatalf("POST /api/v1/auth/login in citadel_only expected 403, got %d", recLogin.Code)
	}

	// 3. /blog/api/v1/auth/me unauthenticated vs authenticated ForwardAuth.
	recMeAnon := h.doRequest(http.MethodGet, "/blog/api/v1/auth/me", nil, nil, nil)
	if recMeAnon.Code != http.StatusOK {
		t.Fatalf("GET /blog/api/v1/auth/me anon expected 200, got %d", recMeAnon.Code)
	}
	var meAnon map[string]any
	_ = json.Unmarshal(recMeAnon.Body.Bytes(), &meAnon)
	if meAnon["authenticated"] != false || meAnon["authMode"] != "citadel_only" {
		t.Fatalf("unexpected anon /auth/me payload: %+v", meAnon)
	}

	editorHeaders := forwardAuthHeaders(uuid.NewString(), "editor@example.com", "user", "editor", "content:read,content:write")
	recMeEditor := h.doRequest(http.MethodGet, "/blog/api/v1/auth/me", nil, nil, editorHeaders)
	if recMeEditor.Code != http.StatusOK {
		t.Fatalf("GET /blog/api/v1/auth/me ForwardAuth expected 200, got %d", recMeEditor.Code)
	}
	var meEditor map[string]any
	_ = json.Unmarshal(recMeEditor.Body.Bytes(), &meEditor)
	if meEditor["authenticated"] != true || meEditor["authProvider"] != "citadel" || meEditor["appRole"] != "editor" {
		t.Fatalf("unexpected ForwardAuth /auth/me payload: %+v", meEditor)
	}

	// 4. ForwardAuth RBAC: viewer can read content but cannot create webhooks; admin enforces Origin CSRF.
	viewerHeaders := forwardAuthHeaders(uuid.NewString(), "viewer@example.com", "user", "viewer", "content:read")
	if rec := h.doRequest(http.MethodGet, "/blog/api/v1/admin/content", nil, nil, viewerHeaders); rec.Code != http.StatusOK {
		t.Fatalf("viewer GET /blog/api/v1/admin/content expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	viewerMutation := forwardAuthHeaders(uuid.NewString(), "viewer@example.com", "user", "viewer", "content:read")
	viewerMutation["Origin"] = "https://admin.crackrammer.com"
	if rec := h.doRequest(http.MethodPost, "/blog/api/v1/admin/webhooks", map[string]any{
		"name":      "Viewer Denied",
		"targetUrl": "http://127.0.0.1:9999/hook",
		"events":    []string{"content.published"},
	}, nil, viewerMutation); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer POST /blog/api/v1/admin/webhooks expected 403, got %d", rec.Code)
	}

	adminNoOrigin := forwardAuthHeaders(uuid.NewString(), "admin@example.com", "user", "admin", "admin:*")
	if rec := h.doRequest(http.MethodPost, "/blog/api/v1/admin/webhooks", map[string]any{
		"name":      "Missing Origin",
		"targetUrl": "http://127.0.0.1:9999/hook",
		"events":    []string{"content.published"},
	}, nil, adminNoOrigin); rec.Code != http.StatusForbidden {
		t.Fatalf("admin ForwardAuth mutation without Origin expected 403, got %d", rec.Code)
	}

	adminWithOrigin := forwardAuthHeaders(uuid.NewString(), "admin@example.com", "user", "admin", "admin:*")
	adminWithOrigin["Origin"] = "https://admin.crackrammer.com"
	if rec := h.doRequest(http.MethodPost, "/blog/api/v1/admin/webhooks", map[string]any{
		"name":      "Valid Hook",
		"targetUrl": "http://127.0.0.1:9999/hook",
		"events":    []string{"content.published"},
	}, nil, adminWithOrigin); rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("admin ForwardAuth mutation with valid Origin expected 200/201, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 5. Security overview + local security mutation lockout.
	recSec := h.doRequest(http.MethodGet, "/blog/api/v1/admin/security", nil, nil, adminWithOrigin)
	if recSec.Code != http.StatusOK {
		t.Fatalf("GET /blog/api/v1/admin/security expected 200, got %d body=%s", recSec.Code, recSec.Body.String())
	}
	var secBody map[string]any
	_ = json.Unmarshal(recSec.Body.Bytes(), &secBody)
	if secBody["managedByCitadel"] != true || secBody["citadelSecurityUrl"] != "https://admin.crackrammer.com/security" {
		t.Fatalf("unexpected security overview payload: %+v", secBody)
	}

	recPass := h.doRequest(http.MethodPost, "/blog/api/v1/admin/security/password", map[string]string{
		"currentPassword": "a",
		"newPassword":     "StrongPassword123!",
	}, nil, adminWithOrigin)
	if recPass.Code != http.StatusForbidden || !strings.Contains(recPass.Body.String(), "Managed by Citadel") {
		t.Fatalf("POST /blog/api/v1/admin/security/password expected 403 Managed by Citadel, got %d body=%s", recPass.Code, recPass.Body.String())
	}

	// 6. Citadel PAT & legacy local PAT passthrough (no browser Origin required).
	citPATHeaders := map[string]string{"Authorization": "Bearer cit_pat_editor"}
	if rec := h.doRequest(http.MethodGet, "/api/v1/admin/content", nil, nil, citPATHeaders); rec.Code != http.StatusOK {
		t.Fatalf("cit_pat_editor GET /api/v1/admin/content expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := h.doRequest(http.MethodGet, "/api/v1/admin/security", nil, nil, citPATHeaders); rec.Code != http.StatusForbidden {
		t.Fatalf("cit_pat_editor GET /api/v1/admin/security expected 403 without admin:*, got %d", rec.Code)
	}

	patOwner, err := h.state.EnsureCitadelUser(context.Background(), uuid.New(), "ci@example.com", "CI Bot", "", "admin")
	if err != nil {
		t.Fatalf("seed PAT user: %v", err)
	}
	rawLocalPAT := "pat_legacy_ci_token_test_123"
	if err := h.state.CreateAPIToken(context.Background(), state.APITokenRecord{
		ID:          uuid.New(),
		UserID:      patOwner.ID,
		Name:        "Legacy Script",
		TokenPrefix: rawLocalPAT[:12],
		TokenHash:   auth.HashToken(rawLocalPAT),
		Scopes:      []string{"content:read"},
		CreatedAt:   time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed local PAT: %v", err)
	}
	localPATHeaders := map[string]string{"Authorization": "Bearer " + rawLocalPAT}
	if rec := h.doRequest(http.MethodGet, "/api/v1/admin/content", nil, nil, localPATHeaders); rec.Code != http.StatusOK {
		t.Fatalf("legacy pat_ GET /api/v1/admin/content expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := h.doRequest(http.MethodGet, "/blog/api/v1/admin/content", nil, nil, localPATHeaders); rec.Code != http.StatusOK {
		t.Fatalf("legacy pat_ GET /blog/api/v1/admin/content expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCitadelPublicReaderPKCEAndAuthenticatedComments(t *testing.T) {
	h := newCitadelIntegrationHarness(t, config.AuthModeCitadelOnly)

	// 1. Start OAuth2 + PKCE login flow.
	recLogin := h.doRequest(http.MethodGet, "/api/v1/public/auth/login?rd=/posts/published-sentinel", nil, nil, nil)
	if recLogin.Code != http.StatusFound {
		t.Fatalf("GET /api/v1/public/auth/login expected 302, got %d body=%s", recLogin.Code, recLogin.Body.String())
	}
	loc, err := url.Parse(recLogin.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse authorize location: %v", err)
	}
	if loc.Scheme != "https" || loc.Host != "admin.crackrammer.com" || loc.Path != "/oauth/authorize" {
		t.Fatalf("unexpected authorize URL: %s", loc.String())
	}
	q := loc.Query()
	if q.Get("client_id") != "cit_app_inkbranch" || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" {
		t.Fatalf("unexpected authorize query: %v", q)
	}
	pkceCookie := findCookieNamed(recLogin, auth.PKCECookieName)
	if pkceCookie == nil {
		t.Fatalf("expected %s cookie to be set", auth.PKCECookieName)
	}

	// 2. Handle OAuth2 callback & seal ibr_reader cookie.
	cbURL := "/api/v1/public/auth/callback?code=auth_code_1&state=" + url.QueryEscape(q.Get("state"))
	recCB := h.doRequest(http.MethodGet, cbURL, nil, []*http.Cookie{pkceCookie}, nil)
	if recCB.Code != http.StatusFound || recCB.Header().Get("Location") != "/posts/published-sentinel" {
		t.Fatalf("GET callback expected 302 -> /posts/published-sentinel, got %d %q body=%s", recCB.Code, recCB.Header().Get("Location"), recCB.Body.String())
	}
	readerCookie := findCookieNamed(recCB, auth.ReaderSessionCookieName)
	if readerCookie == nil {
		t.Fatalf("expected %s cookie to be set", auth.ReaderSessionCookieName)
	}

	// 3. Check /api/v1/public/auth/me with sealed reader cookie.
	recMe := h.doRequest(http.MethodGet, "/api/v1/public/auth/me", nil, []*http.Cookie{readerCookie}, nil)
	if recMe.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/public/auth/me expected 200, got %d", recMe.Code)
	}
	var meBody map[string]any
	_ = json.Unmarshal(recMe.Body.Bytes(), &meBody)
	if meBody["authenticated"] != true || meBody["studioUrl"] != "https://admin.crackrammer.com/blog/" {
		t.Fatalf("unexpected /public/auth/me response: %+v", meBody)
	}

	commentPayload := map[string]any{
		"type":         "post",
		"slug":         "published-sentinel",
		"bodyMarkdown": "Hello Citadel!",
	}
	blogOrigin := map[string]string{"Origin": "https://blog.crackrammer.com"}

	// 4a. Anonymous comment rejected (401).
	if rec := h.doRequest(http.MethodPost, "/api/v1/comments", commentPayload, nil, blogOrigin); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous POST /api/v1/comments in citadel_only expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 4b. Authenticated reader with bad Origin rejected (403).
	if rec := h.doRequest(http.MethodPost, "/api/v1/comments", commentPayload, []*http.Cookie{readerCookie}, map[string]string{"Origin": "https://evil.example"}); rec.Code != http.StatusForbidden {
		t.Fatalf("bad Origin POST /api/v1/comments expected 403, got %d", rec.Code)
	}

	// 4c. Authenticated editor reader with valid Origin succeeds & auto-approves as admin/editor.
	recComment := h.doRequest(http.MethodPost, "/api/v1/comments", commentPayload, []*http.Cookie{readerCookie}, blogOrigin)
	if recComment.Code != http.StatusCreated {
		t.Fatalf("authenticated POST /api/v1/comments expected 201, got %d body=%s", recComment.Code, recComment.Body.String())
	}
	var createdComment struct {
		OK     bool   `json:"ok"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(recComment.Body.Bytes(), &createdComment)
	if !createdComment.OK || createdComment.Status != "approved" {
		t.Fatalf("expected editor comment to auto-approve, got %+v", createdComment)
	}
	storedComments, err := h.state.ListComments(context.Background(), "post", "published-sentinel", "approved")
	if err != nil || len(storedComments) != 1 || !storedComments[0].IsAdmin {
		t.Fatalf("expected 1 approved isAdmin comment, got err=%v comments=%+v", err, storedComments)
	}

	// 4d. Banned/inactive access token fails live IntrospectToken check with 401.
	wBanned := httptest.NewRecorder()
	if err := h.authSvc.SetReaderSessionCookie(wBanned, httptest.NewRequest(http.MethodGet, "/", nil), auth.ReaderSession{
		UserID:      uuid.NewString(),
		Email:       "banned@example.com",
		Name:        "Banned",
		AccessToken: "cit_at_banned",
		ExpiresAt:   time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	bannedCookie := findCookieNamed(wBanned, auth.ReaderSessionCookieName)
	if rec := h.doRequest(http.MethodPost, "/api/v1/comments", commentPayload, []*http.Cookie{bannedCookie}, blogOrigin); rec.Code != http.StatusUnauthorized {
		t.Fatalf("banned reader POST /api/v1/comments expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 5. Public reader logout clears cookie and emits Clear-Site-Data + citadelLogoutUrl.
	recLogout := h.doRequest(http.MethodPost, "/api/v1/public/auth/logout", nil, []*http.Cookie{readerCookie}, blogOrigin)
	if recLogout.Code != http.StatusOK {
		t.Fatalf("POST /api/v1/public/auth/logout expected 200, got %d", recLogout.Code)
	}
	if recLogout.Header().Get("Clear-Site-Data") != `"cookies", "storage"` {
		t.Fatalf("expected Clear-Site-Data header, got %q", recLogout.Header().Get("Clear-Site-Data"))
	}
	if !strings.Contains(recLogout.Body.String(), "citadelLogoutUrl") {
		t.Fatalf("expected citadelLogoutUrl in logout response, got %s", recLogout.Body.String())
	}
}

func TestConfigCitadelAuthModeAlias(t *testing.T) {
	t.Setenv("AUTH_MODE", "")
	t.Setenv("CITADEL_AUTH_MODE", "citadel_only")
	t.Setenv("CITADEL_INTERNAL_SECRET", intTestInternalSecret)
	t.Setenv("CITADEL_HEADER_HMAC_SECRET", intTestHMACSecret)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load with CITADEL_AUTH_MODE failed: %v", err)
	}
	if cfg.AuthMode != config.AuthModeCitadelOnly {
		t.Fatalf("expected AuthMode=%q via CITADEL_AUTH_MODE alias, got %q", config.AuthModeCitadelOnly, cfg.AuthMode)
	}

	t.Setenv("AUTH_MODE", "hybrid")
	cfg2, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load with AUTH_MODE override failed: %v", err)
	}
	if cfg2.AuthMode != config.AuthModeHybrid {
		t.Fatalf("expected AUTH_MODE to take precedence over CITADEL_AUTH_MODE, got %q", cfg2.AuthMode)
	}
}
