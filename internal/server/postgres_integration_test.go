package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/db"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/search"
	"github.com/CRACKRAMMER/Inkbranch/internal/server"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func openTestPGPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping PostgreSQL integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	pool, err := db.NewPool(ctx, dsn, 8)
	if err != nil {
		t.Fatalf("db.NewPool failed: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func resetPublicSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatalf("reset public schema failed: %v", err)
	}
}

func copyDirRecursive(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func doPGRequest(t *testing.T, srv *server.Server, method, target string, payload any, cookie *http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body *bytes.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		body = bytes.NewReader(raw)
	} else {
		body = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, body)
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
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestPostgresV1UpgradeMigration(t *testing.T) {
	ctx, pool := openTestPGPool(t)
	resetPublicSchema(t, ctx, pool)

	// Seed a representative Inkbranch v1 (Drizzle) schema + data.
	v1Pass := "V1-Legacy-Upgrade-Pass-2026!"
	v1Hash, err := auth.HashPassword(v1Pass)
	if err != nil {
		t.Fatalf("hash v1 password: %v", err)
	}
	userID := uuid.New()
	redirActiveID := uuid.New()
	redirDisabledID := uuid.New()
	assetID := uuid.New()

	_, err = pool.Exec(ctx, `
		CREATE TYPE content_type AS ENUM ('post', 'note', 'project');
		CREATE TABLE __drizzle_migrations (
			id serial PRIMARY KEY,
			hash text NOT NULL,
			created_at bigint
		);
		CREATE TABLE users (
			id uuid PRIMARY KEY,
			email text NOT NULL UNIQUE,
			name text NOT NULL,
			password_hash text NOT NULL,
			role text NOT NULL DEFAULT 'admin',
			session_version integer NOT NULL DEFAULT 1,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE TABLE sessions (
			id uuid PRIMARY KEY,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE TABLE redirects (
			id uuid PRIMARY KEY,
			from_path text NOT NULL,
			to_path text NOT NULL,
			status_code integer NOT NULL DEFAULT 301,
			hits integer NOT NULL DEFAULT 0,
			enabled boolean NOT NULL DEFAULT true,
			created_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE TABLE assets (
			id uuid PRIMARY KEY,
			path text NOT NULL,
			url text NOT NULL,
			filename text NOT NULL,
			mime text NOT NULL,
			size integer NOT NULL,
			width integer,
			height integer,
			alt text,
			uploaded_by uuid,
			created_at timestamptz NOT NULL DEFAULT now()
		);
	`)
	if err != nil {
		t.Fatalf("create representative v1 tables failed: %v", err)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
		userID, "CrackRammer@Example.COM", "CRACKRAMMER", v1Hash); err != nil {
		t.Fatalf("insert v1 user failed: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO redirects (id, from_path, to_path, status_code, hits, enabled) VALUES
		($1, '/legacy-post', '/posts/modern-post', 301, 42, true),
		($2, '/disabled-old', '/posts/nope', 302, 5, false)
	`, redirActiveID, redirDisabledID); err != nil {
		t.Fatalf("insert v1 redirects failed: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO assets (id, path, url, filename, mime, size, width, height, alt, uploaded_by)
		VALUES ($1, '2026/hero.webp', '/uploads/2026/hero.webp', 'hero.webp', 'image/webp', 12345, 1200, 630, 'Hero Banner', $2)
	`, assetID, userID); err != nil {
		t.Fatalf("insert v1 asset failed: %v", err)
	}

	if err := db.RunMigrations(ctx, pool); err != nil {
		t.Fatalf("db.RunMigrations v1->v2 failed: %v", err)
	}
	// Run a second time to verify idempotency.
	if err := db.RunMigrations(ctx, pool); err != nil {
		t.Fatalf("second db.RunMigrations idempotency failed: %v", err)
	}

	pgStore := state.NewPostgresStore(pool)
	migratedUser, err := pgStore.GetUserByEmail(ctx, "crackrammer@example.com")
	if err != nil || migratedUser == nil {
		t.Fatalf("expected migrated v1 user, got user=%v err=%v", migratedUser, err)
	}
	if migratedUser.ID != userID || migratedUser.Email != "crackrammer@example.com" {
		t.Fatalf("unexpected migrated user fields: %+v", migratedUser)
	}
	ok, err := auth.VerifyPassword(v1Pass, migratedUser.PasswordHash)
	if err != nil || !ok {
		t.Fatalf("expected v1 password hash verification to pass, ok=%v err=%v", ok, err)
	}

	redirects, err := pgStore.ListRedirects(ctx)
	if err != nil {
		t.Fatalf("ListRedirects failed: %v", err)
	}
	if len(redirects) != 1 || redirects[0].SourcePath != "/legacy-post" || redirects[0].TargetPath != "/posts/modern-post" || redirects[0].Hits != 42 {
		t.Fatalf("unexpected migrated redirects: %+v", redirects)
	}

	var driver, key, mime, alt string
	var byteSize int64
	if err := pool.QueryRow(ctx, `
		SELECT storage_driver, storage_key, mime_type, byte_size, alt_text
		FROM assets WHERE id = $1
	`, assetID).Scan(&driver, &key, &mime, &byteSize, &alt); err != nil {
		t.Fatalf("query migrated asset failed: %v", err)
	}
	if driver != "local" || key != "2026/hero.webp" || mime != "image/webp" || byteSize != 12345 || alt != "Hero Banner" {
		t.Fatalf("unexpected migrated asset: driver=%q key=%q mime=%q size=%d alt=%q", driver, key, mime, byteSize, alt)
	}
}

func TestPostgresFullServerWorkflow(t *testing.T) {
	ctx, pool := openTestPGPool(t)
	resetPublicSchema(t, ctx, pool)

	if err := db.RunMigrations(ctx, pool); err != nil {
		t.Fatalf("db.RunMigrations failed: %v", err)
	}

	tmp := t.TempDir()
	contentDir := filepath.Join(tmp, "content")
	uploadsDir := filepath.Join(tmp, "uploads")
	backupsDir := filepath.Join(tmp, "backups")
	passFile := filepath.Join(tmp, ".initial-admin-password")
	for _, d := range []string{contentDir, uploadsDir, backupsDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	repoContentDir := filepath.Join("..", "..", "content")
	if err := copyDirRecursive(repoContentDir, contentDir); err != nil {
		t.Fatalf("stage copy of content dir failed: %v", err)
	}

	cfg := &config.Config{
		Port:              3000,
		Host:              "127.0.0.1",
		SiteURL:           "https://blog.crackrammer.com",
		SiteName:          "Inkbranch",
		SiteDescription:   "Personal Knowledge System & Modern Publishing Platform",
		SessionSecret:     "pg-integration-session-secret-0123456789abcdef",
		ContentDir:        contentDir,
		UploadsDir:        uploadsDir,
		BackupsDir:        backupsDir,
		StorageDriver:     "local",
		AdminEmail:        "crackrammer@gmail.com",
		AdminName:         "CRACKRAMMER",
		AdminPasswordFile: passFile,
		SMTPFrom:          "Inkbranch <noreply@blog.crackrammer.com>",
	}

	pgStore := state.NewPostgresStore(pool)
	seeded, wrotePath, err := auth.EnsureInitialAdmin(ctx, pgStore, cfg)
	if err != nil {
		t.Fatalf("EnsureInitialAdmin failed: %v", err)
	}
	if !seeded || wrotePath != passFile {
		t.Fatalf("expected initial admin seeded to %q, got seeded=%v path=%q", passFile, seeded, wrotePath)
	}
	stInfo, err := os.Stat(passFile)
	if err != nil {
		t.Fatalf("stat passFile failed: %v", err)
	}
	if stInfo.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 permissions on %s, got %o", passFile, stInfo.Mode().Perm())
	}
	pwBytes, err := os.ReadFile(passFile)
	if err != nil {
		t.Fatalf("read passFile: %v", err)
	}
	initPassword := strings.TrimSpace(string(pwBytes))

	adminUser, err := pgStore.GetUserByEmail(ctx, "crackrammer@gmail.com")
	if err != nil || adminUser == nil {
		t.Fatalf("GetUserByEmail failed: user=%v err=%v", adminUser, err)
	}
	// Verify PostgreSQL passkey query casts work cleanly against real PG17.
	pkID := uuid.New()
	if err := pgStore.CreatePasskey(ctx, state.PasskeyRecord{
		ID:              pkID,
		UserID:          adminUser.ID,
		CredentialID:    []byte("pg-test-cred-id"),
		PublicKey:       []byte("pg-test-pub-key"),
		AttestationType: "none",
		SignCount:       1,
		CredentialJSON:  []byte(`{"id":"cred1"}`),
		Label:           "Test Key",
	}); err != nil {
		t.Fatalf("CreatePasskey failed: %v", err)
	}
	if err := pgStore.UpdatePasskeyUsage(ctx, pkID, 2, []byte(`{"signCount":2}`), time.Now().UTC()); err != nil {
		t.Fatalf("UpdatePasskeyUsage with json failed: %v", err)
	}
	if err := pgStore.UpdatePasskeyUsage(ctx, pkID, 3, nil, time.Now().UTC()); err != nil {
		t.Fatalf("UpdatePasskeyUsage with empty json failed: %v", err)
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
	repo := db.NewRepo(pool)
	syncReport, err := store.SyncToDatabase(ctx, repo, search.BuildSearchTokensString)
	if err != nil {
		t.Fatalf("SyncToDatabase failed: %v", err)
	}
	if syncReport.Scanned != 13 || syncReport.Published != 13 || len(syncReport.Errors) != 0 {
		t.Fatalf("unexpected sync report for repo content: %+v", syncReport)
	}

	ogRenderer, err := media.NewOGRenderer()
	if err != nil {
		t.Fatalf("NewOGRenderer failed: %v", err)
	}
	mailer := &distribution.MemoryMailer{}
	webhooks := distribution.NewWebhookDispatcher(cfg, pgStore)
	webhooks.AllowPrivateForTest = true
	poller := community.NewFeedPoller()
	poller.AllowPrivateForTest = true

	srv, err := server.New(server.Options{
		Config:   cfg,
		Pool:     pool,
		Repo:     repo,
		State:    pgStore,
		Auth:     auth.NewService(cfg, pgStore),
		Storage:  media.NewLocalStorage(uploadsDir),
		Mailer:   mailer,
		Webhooks: webhooks,
		Poller:   poller,
		Store:    store,
		MD:       mdRenderer,
		OG:       ogRenderer,
		Version:  "2.0.0-pgtest",
	})
	if err != nil {
		t.Fatalf("server.New failed: %v", err)
	}

	// 1. Health check reports live database + 13 scanned/published docs.
	healthRec := doPGRequest(t, srv, http.MethodGet, "/api/health", nil, nil, nil)
	if healthRec.Code != http.StatusOK {
		t.Fatalf("GET /api/health failed: %d %s", healthRec.Code, healthRec.Body.String())
	}
	var hb struct {
		Status   string `json:"status"`
		Database struct {
			Configured bool `json:"configured"`
			OK         bool `json:"ok"`
		} `json:"database"`
		Content struct {
			Scanned   int `json:"scanned"`
			Published int `json:"published"`
		} `json:"content"`
	}
	if err := json.Unmarshal(healthRec.Body.Bytes(), &hb); err != nil {
		t.Fatalf("unmarshal health body: %v", err)
	}
	if hb.Status != "ok" || !hb.Database.Configured || !hb.Database.OK || hb.Content.Scanned != 13 || hb.Content.Published != 13 {
		t.Fatalf("unexpected /api/health payload: %+v", hb)
	}

	// 2. Admin login -> cookie + CSRF token.
	loginRec := doPGRequest(t, srv, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"email":    "crackrammer@gmail.com",
		"password": initPassword,
	}, nil, nil)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("admin login failed: %d %s", loginRec.Code, loginRec.Body.String())
	}
	var loginOut struct {
		Authenticated bool   `json:"authenticated"`
		MFARequired   bool   `json:"mfaRequired"`
		CSRFToken     string `json:"csrfToken"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginOut)
	cookie := findSessionCookie(loginRec)
	if !loginOut.Authenticated || loginOut.MFARequired || loginOut.CSRFToken == "" || cookie == nil {
		t.Fatalf("unexpected login response: out=%+v cookie=%v", loginOut, cookie)
	}
	authH := map[string]string{"X-CSRF-Token": loginOut.CSRFToken}

	// 3. Create post -> rename slug -> 301 redirect -> edit -> ListRevisions -> RestoreRevision.
	postV1 := "---\ntitle: PG Test Post V1\nslug: pg-test-post\ndate: 2026-10-15T10:00:00Z\nstatus: published\ntags: [postgres]\ncomments: true\n---\n\nOriginal PG body.\n"
	save1 := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":        "post",
		"filename":    "pg-test-post.md",
		"rawMarkdown": postV1,
		"note":        "rev-one",
	}, cookie, authH)
	if save1.Code != http.StatusOK {
		t.Fatalf("create post failed: %d %s", save1.Code, save1.Body.String())
	}

	postV2 := "---\ntitle: PG Test Post V2\nslug: pg-test-post-renamed\ndate: 2026-10-15T10:00:00Z\nstatus: published\ntags: [postgres]\ncomments: true\n---\n\nRenamed PG body v2.\n"
	save2 := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":         "post",
		"filename":     "pg-test-post-renamed.md",
		"previousPath": "posts/pg-test-post.md",
		"rawMarkdown":  postV2,
		"note":         "rev-rename",
	}, cookie, authH)
	if save2.Code != http.StatusOK {
		t.Fatalf("rename post failed: %d %s", save2.Code, save2.Body.String())
	}
	var save2Out struct {
		AutoRedirectCreated string `json:"autoRedirectCreated"`
		Checksum            string `json:"checksum"`
	}
	_ = json.Unmarshal(save2.Body.Bytes(), &save2Out)
	if !strings.Contains(save2Out.AutoRedirectCreated, "/posts/pg-test-post -> /posts/pg-test-post-renamed") {
		t.Fatalf("expected autoRedirectCreated, got %q", save2Out.AutoRedirectCreated)
	}

	redirRec := doPGRequest(t, srv, http.MethodGet, "/posts/pg-test-post", nil, nil, nil)
	if redirRec.Code != http.StatusMovedPermanently || redirRec.Header().Get("Location") != "/posts/pg-test-post-renamed" {
		t.Fatalf("expected 301 redirect to /posts/pg-test-post-renamed, got %d location=%q", redirRec.Code, redirRec.Header().Get("Location"))
	}

	postV3 := "---\ntitle: PG Test Post V3\nslug: pg-test-post-renamed\ndate: 2026-10-15T10:00:00Z\nstatus: published\ntags: [postgres]\ncomments: true\n---\n\nOverwritten PG body v3.\n"
	save3 := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/content", map[string]any{
		"type":             "post",
		"filename":         "pg-test-post-renamed.md",
		"expectedChecksum": save2Out.Checksum,
		"rawMarkdown":      postV3,
		"note":             "rev-three",
	}, cookie, authH)
	if save3.Code != http.StatusOK {
		t.Fatalf("edit v3 failed: %d %s", save3.Code, save3.Body.String())
	}

	getRec := doPGRequest(t, srv, http.MethodGet, "/api/v1/admin/content/post/pg-test-post-renamed", nil, cookie, nil)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get admin content failed: %d %s", getRec.Code, getRec.Body.String())
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
	restRev := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/revisions/"+targetRevID+"/restore", nil, cookie, authH)
	if restRev.Code != http.StatusOK || !strings.Contains(restRev.Body.String(), "Renamed PG body v2.") {
		t.Fatalf("restore revision failed: %d %s", restRev.Code, restRev.Body.String())
	}

	// 4. Reactions + Comment approve + Admin reply.
	reactRec := doPGRequest(t, srv, http.MethodPost, "/api/v1/reactions", map[string]string{
		"type":  "post",
		"slug":  "pg-test-post-renamed",
		"emoji": "🔥",
	}, nil, nil)
	if reactRec.Code != http.StatusOK || !strings.Contains(reactRec.Body.String(), `"count":1`) {
		t.Fatalf("reaction toggle failed: %d %s", reactRec.Code, reactRec.Body.String())
	}

	cPost := doPGRequest(t, srv, http.MethodPost, "/api/v1/comments", map[string]any{
		"type":         "post",
		"slug":         "pg-test-post-renamed",
		"authorName":   "PG Reader",
		"authorEmail":  "reader@example.com",
		"bodyMarkdown": "Postgres comment check **bold**",
	}, nil, nil)
	if cPost.Code != http.StatusCreated {
		t.Fatalf("create comment failed: %d %s", cPost.Code, cPost.Body.String())
	}
	cQueue := doPGRequest(t, srv, http.MethodGet, "/api/v1/admin/comments?status=pending", nil, cookie, nil)
	var qOut struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(cQueue.Body.Bytes(), &qOut)
	if len(qOut.Items) != 1 {
		t.Fatalf("expected 1 pending comment, got %d (%s)", len(qOut.Items), cQueue.Body.String())
	}
	commentID := qOut.Items[0].ID
	if mod := doPGRequest(t, srv, http.MethodPatch, "/api/v1/admin/comments/"+commentID, map[string]string{"status": "approved"}, cookie, authH); mod.Code != http.StatusOK {
		t.Fatalf("approve comment failed: %d %s", mod.Code, mod.Body.String())
	}
	if rep := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/comments/"+commentID+"/reply", map[string]string{"bodyMarkdown": "Official PG Reply"}, cookie, authH); rep.Code != http.StatusCreated {
		t.Fatalf("reply comment failed: %d %s", rep.Code, rep.Body.String())
	}
	if cTree := doPGRequest(t, srv, http.MethodGet, "/api/v1/comments?type=post&slug=pg-test-post-renamed", nil, nil, nil); cTree.Code != http.StatusOK || !strings.Contains(cTree.Body.String(), "Official PG Reply") {
		t.Fatalf("expected comment tree with reply, got %d %s", cTree.Code, cTree.Body.String())
	}

	// 5. Newsletter double opt-in -> campaign -> unsubscribe.
	subRec := doPGRequest(t, srv, http.MethodPost, "/api/v1/newsletter/subscribe", map[string]string{"email": "pgsub@example.com"}, nil, nil)
	if subRec.Code != http.StatusOK || len(mailer.Messages) == 0 {
		t.Fatalf("subscribe failed: %d %s", subRec.Code, subRec.Body.String())
	}
	tokenRe := regexp.MustCompile(`token=([^"&\s<>]+)`)
	confirmMatch := tokenRe.FindStringSubmatch(mailer.Messages[0].TextBody)
	if len(confirmMatch) < 2 {
		t.Fatalf("failed to parse confirm token from %q", mailer.Messages[0].TextBody)
	}
	confRec := doPGRequest(t, srv, http.MethodGet, "/api/v1/newsletter/confirm?token="+confirmMatch[1], nil, nil, map[string]string{"Accept": "application/json"})
	if confRec.Code != http.StatusOK || !strings.Contains(confRec.Body.String(), `"status":"active"`) {
		t.Fatalf("confirm failed: %d %s", confRec.Code, confRec.Body.String())
	}
	sendRec := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/newsletter/send", map[string]string{
		"subject":      "PG Dispatch",
		"bodyMarkdown": "Hello **PG Subscribers**",
	}, cookie, authH)
	if sendRec.Code != http.StatusCreated || len(mailer.Messages) < 2 {
		t.Fatalf("send campaign failed: %d %s", sendRec.Code, sendRec.Body.String())
	}
	unsubMatch := tokenRe.FindStringSubmatch(mailer.Messages[1].ListUnsubscribe)
	if len(unsubMatch) < 2 {
		t.Fatalf("failed to parse unsubscribe token from %q", mailer.Messages[1].ListUnsubscribe)
	}
	unsubRec := doPGRequest(t, srv, http.MethodPost, "/api/v1/newsletter/unsubscribe?token="+unsubMatch[1], nil, nil, map[string]string{"Accept": "application/json"})
	if unsubRec.Code != http.StatusOK || !strings.Contains(unsubRec.Body.String(), `"status":"unsubscribed"`) {
		t.Fatalf("unsubscribe failed: %d %s", unsubRec.Code, unsubRec.Body.String())
	}

	// 6. Analytics collect -> daily rollup -> overview.
	if pv := doPGRequest(t, srv, http.MethodPost, "/api/v1/analytics/collect", map[string]any{
		"eventType":   "pageview",
		"path":        "/posts/pg-test-post-renamed",
		"contentType": "post",
		"slug":        "pg-test-post-renamed",
	}, nil, nil); pv.Code != http.StatusNoContent {
		t.Fatalf("pageview collect failed: %d", pv.Code)
	}
	if rd := doPGRequest(t, srv, http.MethodPost, "/api/v1/analytics/collect", map[string]any{
		"eventType":    "read_depth",
		"path":         "/posts/pg-test-post-renamed",
		"contentType":  "post",
		"slug":         "pg-test-post-renamed",
		"maxDepth":     85,
		"dwellSeconds": 40,
	}, nil, nil); rd.Code != http.StatusNoContent {
		t.Fatalf("read_depth collect failed: %d", rd.Code)
	}
	if err := pgStore.RollupAnalyticsDaily(ctx, time.Now().UTC()); err != nil {
		t.Fatalf("RollupAnalyticsDaily failed: %v", err)
	}
	ov := doPGRequest(t, srv, http.MethodGet, "/api/v1/admin/overview", nil, cookie, nil)
	if ov.Code != http.StatusOK || !strings.Contains(ov.Body.String(), `"/posts/pg-test-post-renamed"`) || !strings.Contains(ov.Body.String(), `"avgScrollPct":85`) {
		t.Fatalf("expected analytics in overview, got %d %s", ov.Code, ov.Body.String())
	}

	// 7. Backup create -> delete post -> restore backup -> post returns.
	bkCreate := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/backups", nil, cookie, authH)
	if bkCreate.Code != http.StatusCreated {
		t.Fatalf("create backup failed: %d %s", bkCreate.Code, bkCreate.Body.String())
	}
	var bkOut struct {
		Backup struct {
			ID string `json:"id"`
		} `json:"backup"`
	}
	_ = json.Unmarshal(bkCreate.Body.Bytes(), &bkOut)
	if bkOut.Backup.ID == "" {
		t.Fatalf("missing backup id: %s", bkCreate.Body.String())
	}
	if del := doPGRequest(t, srv, http.MethodDelete, "/api/v1/admin/content/post/pg-test-post-renamed", nil, cookie, authH); del.Code != http.StatusOK {
		t.Fatalf("delete post failed: %d %s", del.Code, del.Body.String())
	}
	if gone := doPGRequest(t, srv, http.MethodGet, "/api/v1/content/post/pg-test-post-renamed", nil, nil, nil); gone.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", gone.Code)
	}
	if rest := doPGRequest(t, srv, http.MethodPost, "/api/v1/admin/backups/restore", map[string]string{"backupId": bkOut.Backup.ID}, cookie, authH); rest.Code != http.StatusOK {
		t.Fatalf("restore backup failed: %d %s", rest.Code, rest.Body.String())
	}
	if back := doPGRequest(t, srv, http.MethodGet, "/api/v1/content/post/pg-test-post-renamed", nil, nil, nil); back.Code != http.StatusOK {
		t.Fatalf("expected 200 after backup restore, got %d %s", back.Code, back.Body.String())
	}
}
