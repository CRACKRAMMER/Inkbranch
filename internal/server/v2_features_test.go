package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/server"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/pquerna/otp/totp"
)

type v2TestHarness struct {
	t          *testing.T
	srv        *server.Server
	cfg        *config.Config
	state      *state.MemoryStore
	mailer     *distribution.MemoryMailer
	webhooks   *distribution.WebhookDispatcher
	poller     *community.FeedPoller
	contentDir string
	passFile   string
}

func newV2Harness(t *testing.T) *v2TestHarness {
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
tags: [go, architecture]
category: Engineering
comments: true
---

Intro paragraph here.

FULL_BODY_SENTINEL_MARKER_XYZ for full feed verification.
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

Draft only content not visible publicly.
`
	if err := os.WriteFile(filepath.Join(contentDir, "posts", "secret-draft.md"), []byte(draftPost), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Port:              3000,
		Host:              "127.0.0.1",
		SiteURL:           "https://blog.crackrammer.com",
		SiteName:          "Inkbranch",
		SiteDescription:   "Personal Knowledge System & Modern Publishing Platform",
		SessionSecret:     "v2-test-session-secret-0123456789abcdef",
		ContentDir:        contentDir,
		UploadsDir:        uploadsDir,
		BackupsDir:        backupsDir,
		StorageDriver:     "local",
		AdminEmail:        "crackrammer@gmail.com",
		AdminName:         "CRACKRAMMER",
		AdminPasswordFile: passFile,
		SMTPFrom:          "Inkbranch <noreply@blog.crackrammer.com>",
	}

	st := state.NewMemoryStore()
	ctx := context.Background()
	seeded, wrotePath, err := auth.EnsureInitialAdmin(ctx, st, cfg)
	if err != nil {
		t.Fatalf("EnsureInitialAdmin failed: %v", err)
	}
	if !seeded || wrotePath != passFile {
		t.Fatalf("expected initial admin seeded with file %q, got seeded=%v path=%q", passFile, seeded, wrotePath)
	}
	seededAgain, _, err := auth.EnsureInitialAdmin(ctx, st, cfg)
	if err != nil || seededAgain {
		t.Fatalf("expected idempotent second seed false, got seeded=%v err=%v", seededAgain, err)
	}

	mdRenderer := markdown.NewRenderer()
	store := content.NewStore(contentDir, func(doc *content.Document, resolver content.LinkResolver) (string, []content.OutgoingLink, error) {
		res, err := mdRenderer.Render(doc.Checksum, doc.Body, resolver)
		if err != nil {
			return "", nil, err
		}
		if len(res.Headings) > 0 {
			doc.Headings = res.Headings
		}
		return res.HTML, res.Links, nil
	})
	if _, valErrs, err := store.LoadAll(); err != nil || len(valErrs) > 0 {
		t.Fatalf("LoadAll failed: err=%v valErrs=%v", err, valErrs)
	}

	ogRenderer, err := media.NewOGRenderer()
	if err != nil {
		t.Fatal(err)
	}
	mailer := &distribution.MemoryMailer{}
	webhooks := distribution.NewWebhookDispatcher(cfg, st)
	webhooks.AllowPrivateForTest = true
	poller := community.NewFeedPoller()
	poller.AllowPrivateForTest = true

	srv, err := server.New(server.Options{
		Config:   cfg,
		State:    st,
		Auth:     auth.NewService(cfg, st),
		Storage:  media.NewLocalStorage(uploadsDir),
		Mailer:   mailer,
		Webhooks: webhooks,
		Poller:   poller,
		Store:    store,
		MD:       mdRenderer,
		OG:       ogRenderer,
		Version:  "2.0.0-v2test",
	})
	if err != nil {
		t.Fatalf("server.New failed: %v", err)
	}
	return &v2TestHarness{
		t:          t,
		srv:        srv,
		cfg:        cfg,
		state:      st,
		mailer:     mailer,
		webhooks:   webhooks,
		poller:     poller,
		contentDir: contentDir,
		passFile:   passFile,
	}
}

func (h *v2TestHarness) doJSON(method, target string, payload any, cookie *http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
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
	if cookie != nil {
		req.AddCookie(cookie)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func findSessionCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			return c
		}
	}
	return nil
}

func (h *v2TestHarness) loginAdmin(email, password string) (*http.Cookie, string) {
	h.t.Helper()
	rec := h.doJSON(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"email":    email,
		"password": password,
	}, nil, nil)
	if rec.Code != http.StatusOK {
		h.t.Fatalf("login failed: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Authenticated bool   `json:"authenticated"`
		MFARequired   bool   `json:"mfaRequired"`
		CSRFToken     string `json:"csrfToken"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if !out.Authenticated || out.MFARequired || out.CSRFToken == "" {
		h.t.Fatalf("unexpected login response: %+v", out)
	}
	c := findSessionCookie(rec)
	if c == nil {
		h.t.Fatalf("expected session cookie")
	}
	return c, out.CSRFToken
}

func TestV2AdminAuthCSRF_TOTP_PATScopes(t *testing.T) {
	h := newV2Harness(t)

	info, err := os.Stat(h.passFile)
	if err != nil {
		t.Fatalf("stat initial password file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("expected password file mode 0600, got %o", perm)
	}
	pwBytes, err := os.ReadFile(h.passFile)
	if err != nil {
		t.Fatalf("read initial password file: %v", err)
	}
	initPassword := strings.TrimSpace(string(pwBytes))
	if len(initPassword) < 24 {
		t.Fatalf("expected high-entropy initial password, got length %d", len(initPassword))
	}

	cookie, csrf := h.loginAdmin("crackrammer@gmail.com", initPassword)

	// CSRF missing on mutating admin route must return 403.
	noCSRF := h.doJSON(http.MethodPut, "/api/v1/admin/settings", map[string]any{"feed_mode": "full"}, cookie, nil)
	if noCSRF.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without CSRF token, got %d", noCSRF.Code)
	}

	// Valid CSRF succeeds.
	withCSRF := h.doJSON(http.MethodPut, "/api/v1/admin/settings", map[string]any{"feed_mode": "full"}, cookie, map[string]string{
		"X-CSRF-Token": csrf,
	})
	if withCSRF.Code != http.StatusOK {
		t.Fatalf("expected 200 with CSRF token, got %d: %s", withCSRF.Code, withCSRF.Body.String())
	}

	// Setup and verify TOTP + single-use recovery code.
	setupRec := h.doJSON(http.MethodPost, "/api/v1/admin/security/totp/setup", nil, cookie, map[string]string{
		"X-CSRF-Token": csrf,
	})
	if setupRec.Code != http.StatusOK {
		t.Fatalf("totp setup failed: %d %s", setupRec.Code, setupRec.Body.String())
	}
	var setupResp struct {
		Secret        string   `json:"secret"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	_ = json.Unmarshal(setupRec.Body.Bytes(), &setupResp)
	if setupResp.Secret == "" || len(setupResp.RecoveryCodes) != 10 {
		t.Fatalf("unexpected totp setup output: secret=%q codes=%d", setupResp.Secret, len(setupResp.RecoveryCodes))
	}
	totpCode, err := totp.GenerateCode(setupResp.Secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("generate totp code: %v", err)
	}
	verRec := h.doJSON(http.MethodPost, "/api/v1/admin/security/totp/verify", map[string]string{"code": totpCode}, cookie, map[string]string{
		"X-CSRF-Token": csrf,
	})
	if verRec.Code != http.StatusOK {
		t.Fatalf("totp verify failed: %d %s", verRec.Code, verRec.Body.String())
	}

	// Logout, re-login -> requires MFA -> consume recovery code once.
	logoutRec := h.doJSON(http.MethodPost, "/api/v1/auth/logout", nil, cookie, map[string]string{"X-CSRF-Token": csrf})
	if logoutRec.Code != http.StatusOK {
		t.Fatalf("logout failed: %d", logoutRec.Code)
	}

	mfaStep := h.doJSON(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"email":    "crackrammer@gmail.com",
		"password": initPassword,
	}, nil, nil)
	var mfaPrompt struct {
		MFARequired bool   `json:"mfaRequired"`
		MFAToken    string `json:"mfaToken"`
	}
	_ = json.Unmarshal(mfaStep.Body.Bytes(), &mfaPrompt)
	if !mfaPrompt.MFARequired || mfaPrompt.MFAToken == "" {
		t.Fatalf("expected MFA challenge, got %s", mfaStep.Body.String())
	}

	recVerify := h.doJSON(http.MethodPost, "/api/v1/auth/mfa/verify", map[string]string{
		"mfaToken": mfaPrompt.MFAToken,
		"code":     setupResp.RecoveryCodes[0],
	}, nil, nil)
	if recVerify.Code != http.StatusOK {
		t.Fatalf("recovery code login failed: %d %s", recVerify.Code, recVerify.Body.String())
	}
	cookie2 := findSessionCookie(recVerify)
	var mfaLoginOut struct {
		CSRFToken string `json:"csrfToken"`
	}
	_ = json.Unmarshal(recVerify.Body.Bytes(), &mfaLoginOut)

	// Reusing the consumed recovery code must fail, whereas valid TOTP code succeeds.
	mfaStep2 := h.doJSON(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"email":    "crackrammer@gmail.com",
		"password": initPassword,
	}, nil, nil)
	var mfaPrompt2 struct {
		MFAToken string `json:"mfaToken"`
	}
	_ = json.Unmarshal(mfaStep2.Body.Bytes(), &mfaPrompt2)
	reused := h.doJSON(http.MethodPost, "/api/v1/auth/mfa/verify", map[string]string{
		"mfaToken": mfaPrompt2.MFAToken,
		"code":     setupResp.RecoveryCodes[0],
	}, nil, nil)
	if reused.Code != http.StatusUnauthorized {
		t.Fatalf("expected reused recovery code rejection (401), got %d", reused.Code)
	}
	totpCode2, _ := totp.GenerateCode(setupResp.Secret, time.Now().UTC())
	mfaOK := h.doJSON(http.MethodPost, "/api/v1/auth/mfa/verify", map[string]string{
		"mfaToken": mfaPrompt2.MFAToken,
		"code":     totpCode2,
	}, nil, nil)
	if mfaOK.Code != http.StatusOK {
		t.Fatalf("expected TOTP MFA verification to pass, got %d: %s", mfaOK.Code, mfaOK.Body.String())
	}

	// Create narrow PAT (content:read) and broad PAT (admin:*).
	narrowRec := h.doJSON(http.MethodPost, "/api/v1/admin/tokens", map[string]any{
		"name":   "readonly-ci",
		"scopes": []string{"content:read"},
	}, cookie2, map[string]string{"X-CSRF-Token": mfaLoginOut.CSRFToken})
	if narrowRec.Code != http.StatusCreated {
		t.Fatalf("create narrow PAT failed: %d %s", narrowRec.Code, narrowRec.Body.String())
	}
	var narrowOut struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(narrowRec.Body.Bytes(), &narrowOut)

	broadRec := h.doJSON(http.MethodPost, "/api/v1/admin/tokens", map[string]any{
		"name":   "full-admin-cli",
		"scopes": []string{"admin:*"},
	}, cookie2, map[string]string{"X-CSRF-Token": mfaLoginOut.CSRFToken})
	if broadRec.Code != http.StatusCreated {
		t.Fatalf("create broad PAT failed: %d %s", broadRec.Code, broadRec.Body.String())
	}
	var broadOut struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(broadRec.Body.Bytes(), &broadOut)

	// Narrow PAT reads content cleanly, gets 403 on write and admin:* endpoints.
	if res := h.doJSON(http.MethodGet, "/api/v1/admin/content", nil, nil, map[string]string{"Authorization": "Bearer " + narrowOut.Token}); res.Code != http.StatusOK {
		t.Fatalf("narrow PAT content read failed: %d", res.Code)
	}
	if res := h.doJSON(http.MethodPost, "/api/v1/admin/content", map[string]any{"type": "note", "rawMarkdown": "---\ntitle: x\n---\nhi"}, nil, map[string]string{"Authorization": "Bearer " + narrowOut.Token}); res.Code != http.StatusForbidden {
		t.Fatalf("expected narrow PAT 403 on content:write, got %d", res.Code)
	}
	if res := h.doJSON(http.MethodGet, "/api/v1/admin/backups", nil, nil, map[string]string{"Authorization": "Bearer " + narrowOut.Token}); res.Code != http.StatusForbidden {
		t.Fatalf("expected narrow PAT 403 on backups, got %d", res.Code)
	}

	// Broad PAT reaches admin:* endpoints, yet session-only security route remains 403.
	if res := h.doJSON(http.MethodGet, "/api/v1/admin/backups", nil, nil, map[string]string{"Authorization": "Bearer " + broadOut.Token}); res.Code != http.StatusOK {
		t.Fatalf("broad PAT failed on admin:* endpoint: %d", res.Code)
	}
	if res := h.doJSON(http.MethodPost, "/api/v1/admin/security/totp/setup", nil, nil, map[string]string{"Authorization": "Bearer " + broadOut.Token}); res.Code != http.StatusForbidden {
		t.Fatalf("expected PAT 403 on session-only security endpoint, got %d", res.Code)
	}
}

func TestV2ContentRenameRedirectRevisionPreviewBackup(t *testing.T) {
	h := newV2Harness(t)
	pwBytes, _ := os.ReadFile(h.passFile)
	cookie, csrf := h.loginAdmin("crackrammer@gmail.com", strings.TrimSpace(string(pwBytes)))
	authH := map[string]string{"X-CSRF-Token": csrf}

	// 1. Save a new note.
	noteV1 := "---\ntitle: Note V1\nslug: hello-v2\ndate: 2026-10-10T09:00:00Z\nstatus: published\ntags: [notes]\n---\n\nInitial version 1 body.\n"
	save1 := h.doJSON(http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":        "note",
		"filename":    "hello-v2.md",
		"rawMarkdown": noteV1,
		"note":        "rev-one",
	}, cookie, authH)
	if save1.Code != http.StatusOK {
		t.Fatalf("save note v1 failed: %d %s", save1.Code, save1.Body.String())
	}

	// 2. Rename slug -> triggers old file deletion + auto 301 redirect.
	noteV2 := "---\ntitle: Note V2\nslug: hello-v2-renamed\ndate: 2026-10-10T09:00:00Z\nstatus: published\ntags: [notes]\n---\n\nRenamed version 2 body.\n"
	save2 := h.doJSON(http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":         "note",
		"filename":     "hello-v2-renamed.md",
		"previousPath": "notes/hello-v2.md",
		"rawMarkdown":  noteV2,
		"note":         "rev-rename",
	}, cookie, authH)
	if save2.Code != http.StatusOK {
		t.Fatalf("rename save failed: %d %s", save2.Code, save2.Body.String())
	}
	var save2Out struct {
		AutoRedirectCreated string `json:"autoRedirectCreated"`
		Checksum            string `json:"checksum"`
	}
	_ = json.Unmarshal(save2.Body.Bytes(), &save2Out)
	if !strings.Contains(save2Out.AutoRedirectCreated, "/notes/hello-v2 -> /notes/hello-v2-renamed") {
		t.Fatalf("expected autoRedirectCreated, got %q", save2Out.AutoRedirectCreated)
	}
	if _, err := os.Stat(filepath.Join(h.contentDir, "notes", "hello-v2.md")); !os.IsNotExist(err) {
		t.Fatalf("expected old file deleted after rename, stat err=%v", err)
	}

	redirRec := h.doJSON(http.MethodGet, "/notes/hello-v2", nil, nil, nil)
	if redirRec.Code != http.StatusMovedPermanently || redirRec.Header().Get("Location") != "/notes/hello-v2-renamed" {
		t.Fatalf("expected 301 redirect to /notes/hello-v2-renamed, got %d location=%q", redirRec.Code, redirRec.Header().Get("Location"))
	}

	// Redirect cycle detection rejects reverse rule.
	loopRec := h.doJSON(http.MethodPost, "/api/v1/admin/redirects", map[string]any{
		"sourcePath": "/notes/hello-v2-renamed",
		"targetPath": "/notes/hello-v2",
		"statusCode": 301,
	}, cookie, authH)
	if loopRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on circular redirect, got %d: %s", loopRec.Code, loopRec.Body.String())
	}

	// 3. Edit note to create a newer revision, then restore the previous revision (zstd).
	noteV3 := "---\ntitle: Note V3 Modified\nslug: hello-v2-renamed\ndate: 2026-10-10T09:00:00Z\nstatus: published\ntags: [notes]\n---\n\nVersion 3 override body.\n"
	save3 := h.doJSON(http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":             "note",
		"filename":         "hello-v2-renamed.md",
		"expectedChecksum": save2Out.Checksum,
		"rawMarkdown":      noteV3,
		"note":             "rev-three",
	}, cookie, authH)
	if save3.Code != http.StatusOK {
		t.Fatalf("save v3 failed: %d %s", save3.Code, save3.Body.String())
	}

	getRec := h.doJSON(http.MethodGet, "/api/v1/admin/content/note/hello-v2-renamed", nil, cookie, nil)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get admin content failed: %d", getRec.Code)
	}
	var detail struct {
		Revisions []struct {
			ID   string `json:"id"`
			Note string `json:"note"`
		} `json:"revisions"`
	}
	_ = json.Unmarshal(getRec.Body.Bytes(), &detail)
	var targetRevID string
	for _, r := range detail.Revisions {
		if r.Note == "rev-rename" {
			targetRevID = r.ID
			break
		}
	}
	if targetRevID == "" {
		t.Fatalf("expected rev-rename revision in %+v", detail.Revisions)
	}
	restoreRev := h.doJSON(http.MethodPost, "/api/v1/admin/revisions/"+targetRevID+"/restore", nil, cookie, authH)
	if restoreRev.Code != http.StatusOK {
		t.Fatalf("restore revision failed: %d %s", restoreRev.Code, restoreRev.Body.String())
	}
	var revOut struct {
		RawMarkdown string `json:"rawMarkdown"`
	}
	_ = json.Unmarshal(restoreRev.Body.Bytes(), &revOut)
	if !strings.Contains(revOut.RawMarkdown, "Renamed version 2 body.") {
		t.Fatalf("expected restored body from rev-rename, got %q", revOut.RawMarkdown)
	}

	// 4. Signed draft preview create / view / revoke.
	if pubCheck := h.doJSON(http.MethodGet, "/api/v1/content/post/secret-draft", nil, nil, nil); pubCheck.Code != http.StatusNotFound {
		t.Fatalf("expected draft hidden publicly (404), got %d", pubCheck.Code)
	}
	prevCreate := h.doJSON(http.MethodPost, "/api/v1/admin/previews", map[string]any{
		"type":     "post",
		"slug":     "secret-draft",
		"label":    "reviewer-share",
		"ttlHours": 24,
	}, cookie, authH)
	if prevCreate.Code != http.StatusCreated {
		t.Fatalf("create preview failed: %d %s", prevCreate.Code, prevCreate.Body.String())
	}
	var prevOut struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	_ = json.Unmarshal(prevCreate.Body.Bytes(), &prevOut)

	prevView := h.doJSON(http.MethodGet, "/api/v1/preview/"+prevOut.Token, nil, nil, nil)
	if prevView.Code != http.StatusOK || prevView.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Fatalf("expected preview 200 with noindex header, got %d robots=%q", prevView.Code, prevView.Header().Get("X-Robots-Tag"))
	}
	if !strings.Contains(prevView.Body.String(), "Unreleased Secret Draft") {
		t.Fatalf("expected draft document in preview response, got %s", prevView.Body.String())
	}
	if revk := h.doJSON(http.MethodDelete, "/api/v1/admin/previews/"+prevOut.ID, nil, cookie, authH); revk.Code != http.StatusOK {
		t.Fatalf("revoke preview failed: %d", revk.Code)
	}
	if prevGone := h.doJSON(http.MethodGet, "/api/v1/preview/"+prevOut.Token, nil, nil, nil); prevGone.Code != http.StatusNotFound {
		t.Fatalf("expected revoked preview 404, got %d", prevGone.Code)
	}

	// 5. .tar.zst backup create -> download -> delete note -> restore backup -> note returns.
	bkCreate := h.doJSON(http.MethodPost, "/api/v1/admin/backups", nil, cookie, authH)
	if bkCreate.Code != http.StatusCreated {
		t.Fatalf("create backup failed: %d %s", bkCreate.Code, bkCreate.Body.String())
	}
	var bkOut struct {
		Backup struct {
			ID       string `json:"id"`
			ByteSize int64  `json:"byteSize"`
		} `json:"backup"`
	}
	_ = json.Unmarshal(bkCreate.Body.Bytes(), &bkOut)
	if bkOut.Backup.ID == "" || bkOut.Backup.ByteSize == 0 {
		t.Fatalf("unexpected backup metadata: %s", bkCreate.Body.String())
	}
	dlRec := h.doJSON(http.MethodGet, "/api/v1/admin/backups/"+bkOut.Backup.ID+"/download", nil, cookie, nil)
	if dlRec.Code != http.StatusOK || dlRec.Body.Len() == 0 {
		t.Fatalf("download backup failed: status=%d len=%d", dlRec.Code, dlRec.Body.Len())
	}

	delNote := h.doJSON(http.MethodDelete, "/api/v1/admin/content/note/hello-v2-renamed", nil, cookie, authH)
	if delNote.Code != http.StatusOK {
		t.Fatalf("delete note failed: %d %s", delNote.Code, delNote.Body.String())
	}
	if gone := h.doJSON(http.MethodGet, "/api/v1/content/note/hello-v2-renamed", nil, nil, nil); gone.Code != http.StatusNotFound {
		t.Fatalf("expected deleted note 404 before restore, got %d", gone.Code)
	}

	restRec := h.doJSON(http.MethodPost, "/api/v1/admin/backups/restore", map[string]string{
		"backupId": bkOut.Backup.ID,
	}, cookie, authH)
	if restRec.Code != http.StatusOK {
		t.Fatalf("restore backup failed: %d %s", restRec.Code, restRec.Body.String())
	}
	if restored := h.doJSON(http.MethodGet, "/api/v1/content/note/hello-v2-renamed", nil, nil, nil); restored.Code != http.StatusOK {
		t.Fatalf("expected restored note 200 after backup restore, got %d: %s", restored.Code, restored.Body.String())
	}
}

func TestV2CommunityNewsletterFeedModeWebhookAnalytics(t *testing.T) {
	h := newV2Harness(t)
	pwBytes, _ := os.ReadFile(h.passFile)
	cookie, csrf := h.loginAdmin("crackrammer@gmail.com", strings.TrimSpace(string(pwBytes)))
	authH := map[string]string{"X-CSRF-Token": csrf}

	// 1. Public Reactions toggle.
	r1 := h.doJSON(http.MethodPost, "/api/v1/reactions", map[string]string{
		"type":  "post",
		"slug":  "published-sentinel",
		"emoji": "🔥",
	}, nil, nil)
	if r1.Code != http.StatusOK || !strings.Contains(r1.Body.String(), `"count":1`) {
		t.Fatalf("expected reaction toggle on, got %d %s", r1.Code, r1.Body.String())
	}
	r2 := h.doJSON(http.MethodPost, "/api/v1/reactions", map[string]string{
		"type":  "post",
		"slug":  "published-sentinel",
		"emoji": "🔥",
	}, nil, nil)
	if r2.Code != http.StatusOK || strings.Contains(r2.Body.String(), `"count":1`) {
		t.Fatalf("expected reaction toggle off, got %d %s", r2.Code, r2.Body.String())
	}

	// 2. Public Comment XSS strip -> Admin approve & official reply -> Public tree view.
	cPost := h.doJSON(http.MethodPost, "/api/v1/comments", map[string]any{
		"type":         "post",
		"slug":         "published-sentinel",
		"authorName":   "Alice",
		"authorEmail":  "alice@example.com",
		"authorUrl":    "https://example.org",
		"bodyMarkdown": "Great post! **Bold claim**\n\n<script>alert('xss')</script>",
	}, nil, nil)
	if cPost.Code != http.StatusCreated {
		t.Fatalf("create comment failed: %d %s", cPost.Code, cPost.Body.String())
	}
	adminComments := h.doJSON(http.MethodGet, "/api/v1/admin/comments?status=pending", nil, cookie, nil)
	if adminComments.Code != http.StatusOK {
		t.Fatalf("list pending comments failed: %d %s", adminComments.Code, adminComments.Body.String())
	}
	var commentQueue struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	_ = json.Unmarshal(adminComments.Body.Bytes(), &commentQueue)
	if len(commentQueue.Items) != 1 {
		t.Fatalf("expected 1 pending comment, got %s", adminComments.Body.String())
	}
	commentID := commentQueue.Items[0].ID

	modRec := h.doJSON(http.MethodPatch, "/api/v1/admin/comments/"+commentID, map[string]string{
		"status": "approved",
	}, cookie, authH)
	if modRec.Code != http.StatusOK {
		t.Fatalf("approve comment failed: %d %s", modRec.Code, modRec.Body.String())
	}
	repRec := h.doJSON(http.MethodPost, "/api/v1/admin/comments/"+commentID+"/reply", map[string]string{
		"bodyMarkdown": "Thanks for reading!",
	}, cookie, authH)
	if repRec.Code != http.StatusCreated {
		t.Fatalf("admin reply failed: %d %s", repRec.Code, repRec.Body.String())
	}

	cList := h.doJSON(http.MethodGet, "/api/v1/comments?type=post&slug=published-sentinel", nil, nil, nil)
	if cList.Code != http.StatusOK {
		t.Fatalf("list comments failed: %d", cList.Code)
	}
	cBody := cList.Body.String()
	if strings.Contains(cBody, "<script>") || !strings.Contains(cBody, "Bold claim") || !strings.Contains(cBody, "Thanks for reading!") {
		t.Fatalf("unexpected comment tree body: %s", cBody)
	}

	// 3. Friends RSS poll with local httptest feed server.
	rssSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Friend Feed</title><link>https://friend.example.org</link>
<item><title>Friend Article One</title><link>https://friend.example.org/p1</link><guid>p1</guid><description>Summary from friend blog</description><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`))
	}))
	defer rssSrv.Close()

	applyRec := h.doJSON(http.MethodPost, "/api/v1/friends/apply", map[string]string{
		"name":        "Friend Blog",
		"url":         rssSrv.URL,
		"feedUrl":     rssSrv.URL + "/feed.xml",
		"description": "A test blog friend",
	}, nil, nil)
	if applyRec.Code != http.StatusCreated {
		t.Fatalf("apply friend failed: %d %s", applyRec.Code, applyRec.Body.String())
	}
	adminFriends := h.doJSON(http.MethodGet, "/api/v1/admin/friends", nil, cookie, nil)
	var flist struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	_ = json.Unmarshal(adminFriends.Body.Bytes(), &flist)
	if len(flist.Items) != 1 || flist.Items[0].Status != "pending" {
		t.Fatalf("expected 1 pending friend link, got %+v", flist.Items)
	}
	approveFriend := h.doJSON(http.MethodPatch, "/api/v1/admin/friends/"+flist.Items[0].ID, map[string]string{"status": "active"}, cookie, authH)
	if approveFriend.Code != http.StatusOK {
		t.Fatalf("approve friend failed: %d %s", approveFriend.Code, approveFriend.Body.String())
	}
	pollRec := h.doJSON(http.MethodPost, "/api/v1/admin/friends/poll", nil, cookie, authH)
	if pollRec.Code != http.StatusOK || !strings.Contains(pollRec.Body.String(), `"itemsUpdated":1`) {
		t.Fatalf("expected 1 friend feed item polled, got %d %s", pollRec.Code, pollRec.Body.String())
	}
	pubFriends := h.doJSON(http.MethodGet, "/api/v1/friends", nil, nil, nil)
	if pubFriends.Code != http.StatusOK || !strings.Contains(pubFriends.Body.String(), "Friend Article One") {
		t.Fatalf("expected friend article in public friends payload, got %d %s", pubFriends.Code, pubFriends.Body.String())
	}

	// 4. Double Opt-In Newsletter + Campaign + RFC 8058 One-Click Unsubscribe.
	subRec := h.doJSON(http.MethodPost, "/api/v1/newsletter/subscribe", map[string]string{
		"email": "reader@example.com",
	}, nil, nil)
	if subRec.Code != http.StatusOK {
		t.Fatalf("subscribe failed: %d %s", subRec.Code, subRec.Body.String())
	}
	if len(h.mailer.Messages) == 0 {
		t.Fatalf("expected confirmation email in MemoryMailer")
	}
	confirmRe := regexp.MustCompile(`token=([^"&\s<>]+)`)
	confirmMatch := confirmRe.FindStringSubmatch(h.mailer.Messages[0].TextBody)
	if len(confirmMatch) < 2 {
		t.Fatalf("could not extract confirm token from %q", h.mailer.Messages[0].TextBody)
	}
	confRec := h.doJSON(http.MethodGet, "/api/v1/newsletter/confirm?token="+confirmMatch[1], nil, nil, map[string]string{"Accept": "application/json"})
	if confRec.Code != http.StatusOK || !strings.Contains(confRec.Body.String(), `"status":"active"`) {
		t.Fatalf("confirm subscription failed: %d %s", confRec.Code, confRec.Body.String())
	}

	sendCampaign := h.doJSON(http.MethodPost, "/api/v1/admin/newsletter/send", map[string]string{
		"subject":      "Weekly Notes #1",
		"bodyMarkdown": "Hello **Subscribers**!",
	}, cookie, authH)
	if sendCampaign.Code != http.StatusCreated {
		t.Fatalf("send newsletter campaign failed: %d %s", sendCampaign.Code, sendCampaign.Body.String())
	}
	if len(h.mailer.Messages) < 2 || h.mailer.Messages[1].ListUnsubscribe == "" {
		t.Fatalf("expected campaign email with List-Unsubscribe URL, got %+v", h.mailer.Messages)
	}
	unsubMatch := confirmRe.FindStringSubmatch(h.mailer.Messages[1].ListUnsubscribe)
	if len(unsubMatch) < 2 {
		t.Fatalf("failed to parse unsubscribe token from %q", h.mailer.Messages[1].ListUnsubscribe)
	}
	unsubRec := h.doJSON(http.MethodPost, "/api/v1/newsletter/unsubscribe?token="+unsubMatch[1], nil, nil, map[string]string{"Accept": "application/json"})
	if unsubRec.Code != http.StatusOK || !strings.Contains(unsubRec.Body.String(), `"status":"unsubscribed"`) {
		t.Fatalf("unsubscribe failed: %d %s", unsubRec.Code, unsubRec.Body.String())
	}

	// 5. Dynamic feed_mode (full -> summary).
	feedFull := h.doJSON(http.MethodGet, "/feed.xml", nil, nil, nil)
	if feedFull.Code != http.StatusOK || !strings.Contains(feedFull.Body.String(), "FULL_BODY_SENTINEL_MARKER_XYZ") {
		t.Fatalf("expected full body in default feed.xml")
	}
	_ = h.doJSON(http.MethodPut, "/api/v1/admin/settings", map[string]any{"feed_mode": "summary"}, cookie, authH)
	feedSummary := h.doJSON(http.MethodGet, "/feed.xml", nil, nil, nil)
	if feedSummary.Code != http.StatusOK || strings.Contains(feedSummary.Body.String(), "FULL_BODY_SENTINEL_MARKER_XYZ") || !strings.Contains(feedSummary.Body.String(), "阅读全文") {
		t.Fatalf("expected summary-only feed.xml without sentinel, got: %s", feedSummary.Body.String())
	}

	// 6. HMAC-SHA256 signed Webhook test delivery.
	var mu sync.Mutex
	var gotSig string
	var gotBody []byte
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotSig = r.Header.Get("X-Inkbranch-Signature-256")
		gotBody = b
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("received"))
	}))
	defer whSrv.Close()

	whSecret := "super-webhook-signing-secret"
	whCreate := h.doJSON(http.MethodPost, "/api/v1/admin/webhooks", map[string]any{
		"name":      "local-hook",
		"targetUrl": whSrv.URL + "/hook",
		"secret":    whSecret,
		"events":    []string{"*"},
	}, cookie, authH)
	if whCreate.Code != http.StatusCreated {
		t.Fatalf("create webhook failed: %d %s", whCreate.Code, whCreate.Body.String())
	}
	var whOut struct {
		Webhook struct {
			ID string `json:"id"`
		} `json:"webhook"`
	}
	_ = json.Unmarshal(whCreate.Body.Bytes(), &whOut)
	whTest := h.doJSON(http.MethodPost, "/api/v1/admin/webhooks/"+whOut.Webhook.ID+"/test", nil, cookie, authH)
	if whTest.Code != http.StatusOK {
		t.Fatalf("webhook test failed: %d %s", whTest.Code, whTest.Body.String())
	}
	mu.Lock()
	expectedSig := distribution.ComputeSignature(whSecret, gotBody)
	sigMatch := gotSig == expectedSig
	mu.Unlock()
	if !sigMatch {
		t.Fatalf("webhook HMAC signature mismatch: got=%q expected=%q", gotSig, expectedSig)
	}

	// 7. Cookie-free Analytics beacons (pageview + read_depth) -> Overview totals reflect view & read depth.
	pvBeacon := h.doJSON(http.MethodPost, "/api/v1/analytics/collect", map[string]any{
		"eventType":   "pageview",
		"path":        "/posts/published-sentinel",
		"contentType": "post",
		"slug":        "published-sentinel",
	}, nil, nil)
	if pvBeacon.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for pageview beacon, got %d: %s", pvBeacon.Code, pvBeacon.Body.String())
	}
	beacon := h.doJSON(http.MethodPost, "/api/v1/analytics/collect", map[string]any{
		"eventType":    "read_depth",
		"path":         "/posts/published-sentinel",
		"contentType":  "post",
		"slug":         "published-sentinel",
		"maxDepth":     85,
		"dwellSeconds": 42,
	}, nil, nil)
	if beacon.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for read_depth beacon, got %d: %s", beacon.Code, beacon.Body.String())
	}
	ov := h.doJSON(http.MethodGet, "/api/v1/admin/overview", nil, cookie, nil)
	if ov.Code != http.StatusOK || !strings.Contains(ov.Body.String(), `"/posts/published-sentinel"`) || !strings.Contains(ov.Body.String(), `"avgScrollPct":85`) {
		t.Fatalf("expected analytics top page & scroll depth in overview, got %d %s", ov.Code, ov.Body.String())
	}
}
