package server_test

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/server"
)

func newTestServer(t *testing.T) (*server.Server, string) {
	t.Helper()

	contentDir, err := filepath.Abs(filepath.Join("..", "..", "content"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(contentDir); err != nil {
		t.Skipf("content dir unavailable: %v", err)
	}

	uploadsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(uploadsDir, "sample.png"), []byte("pngdata"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploadsDir, "vector.svg"), []byte(`<svg><script>alert(1)</script></svg>`), 0o644); err != nil {
		t.Fatal(err)
	}
	secretTarget := filepath.Join(t.TempDir(), "secret.txt")
	_ = os.WriteFile(secretTarget, []byte("secret"), 0o600)
	_ = os.Symlink(secretTarget, filepath.Join(uploadsDir, "escape.txt"))

	cfg := &config.Config{
		Port:            3000,
		Host:            "127.0.0.1",
		SiteURL:         "https://blog.crackrammer.com",
		SiteName:        "Inkbranch",
		SiteDescription: "Personal Knowledge System & Modern Publishing Platform",
		ContentDir:      contentDir,
		UploadsDir:      uploadsDir,
		StorageDriver:   "local",
		AdminName:       "CRACKRAMMER",
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

	srv, err := server.New(server.Options{
		Config:  cfg,
		Store:   store,
		MD:      mdRenderer,
		OG:      ogRenderer,
		Version: "2.0.0-test",
	})
	if err != nil {
		t.Fatalf("server.New failed: %v", err)
	}
	return srv, uploadsDir
}

func doReq(h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAPIHealthOpenAPIAndPublicEndpoints(t *testing.T) {
	srv, _ := newTestServer(t)
	h := srv.Handler()

	// Health & v1 Health
	for _, ep := range []string{"/api/health", "/api/v1/health"} {
		rec := doReq(h, http.MethodGet, ep, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, body=%s", ep, rec.Code, rec.Body.String())
		}
		var payload struct {
			Status  string `json:"status"`
			Content struct {
				Scanned   int `json:"scanned"`
				Published int `json:"published"`
			} `json:"content"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s: %v", ep, err)
		}
		if payload.Status != "ok" || payload.Content.Scanned != 13 || payload.Content.Published != 13 {
			t.Fatalf("unexpected health payload: %+v", payload)
		}
	}

	// OpenAPI 3.1
	oaRec := doReq(h, http.MethodGet, "/api/openapi.json", nil)
	if oaRec.Code != http.StatusOK || !strings.Contains(oaRec.Body.String(), "/api/v1/content") {
		t.Fatalf("OpenAPI spec check failed: status=%d", oaRec.Code)
	}

	// Core public JSON endpoints
	for _, ep := range []string{
		"/api/v1/home",
		"/api/v1/content",
		"/api/v1/content/post/atomic-writes",
		"/api/v1/content/posts/atomic-writes",
		"/api/v1/tags",
		"/api/v1/series",
		"/api/v1/archive",
		"/api/v1/search?q=atomic",
		"/api/v1/graph",
	} {
		rec := doReq(h, http.MethodGet, ep, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, body=%s", ep, rec.Code, rec.Body.String())
		}
	}

	// Unknown content slug returns 404
	notFound := doReq(h, http.MethodGet, "/api/v1/content/post/no-such-slug", nil)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing API doc, got %d", notFound.Code)
	}
}

func TestHybridSEOShellMarkdownNegotiationAndFeeds(t *testing.T) {
	srv, _ := newTestServer(t)
	h := srv.Handler()

	// Document HTML shell with SEO, JSON-LD, <noscript>, and preloaded window.__INKBRANCH_DATA__.
	docHTML := doReq(h, http.MethodGet, "/posts/atomic-writes", nil)
	if docHTML.Code != http.StatusOK {
		t.Fatalf("GET /posts/atomic-writes = %d", docHTML.Code)
	}
	body := docHTML.Body.String()
	for _, want := range []string{
		`<title>Atomic File Writes`,
		`<link rel="canonical" href="https://blog.crackrammer.com/posts/atomic-writes" />`,
		`<meta property="og:image" content="https://blog.crackrammer.com/api/og?type=post&amp;slug=atomic-writes" />`,
		`<script type="application/ld+json">`,
		`"BlogPosting"`,
		`"BreadcrumbList"`,
		`<article class="inkbranch-noscript-article">`,
		`window.__INKBRANCH_DATA__`,
		`<link rel="stylesheet" href="/api/chroma.css" />`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("document HTML missing %q", want)
		}
	}
	if !strings.Contains(docHTML.Header().Get("Vary"), "Accept") {
		t.Errorf("expected Vary: Accept header on document HTML response")
	}

	// Raw Markdown via .md suffix
	mdSuffix := doReq(h, http.MethodGet, "/posts/atomic-writes.md", nil)
	if mdSuffix.Code != http.StatusOK || !strings.HasPrefix(mdSuffix.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf(".md endpoint failed: code=%d ct=%q", mdSuffix.Code, mdSuffix.Header().Get("Content-Type"))
	}
	if !strings.Contains(mdSuffix.Body.String(), "title: Atomic File Writes") {
		t.Fatalf("expected raw frontmatter in .md output")
	}

	// Raw Markdown via Accept content negotiation
	mdAccept := doReq(h, http.MethodGet, "/posts/atomic-writes", map[string]string{"Accept": "text/markdown"})
	if mdAccept.Code != http.StatusOK || !strings.HasPrefix(mdAccept.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("Accept text/markdown failed: code=%d ct=%q", mdAccept.Code, mdAccept.Header().Get("Content-Type"))
	}

	// Missing slug returns HTTP 404 (not 200 soft-404)
	missingHTML := doReq(h, http.MethodGet, "/posts/definitely-does-not-exist", nil)
	if missingHTML.Code != http.StatusNotFound {
		t.Fatalf("expected HTTP 404 for unknown slug, got %d", missingHTML.Code)
	}
	if !strings.Contains(missingHTML.Body.String(), `noindex`) {
		t.Fatalf("expected noindex meta on 404 page")
	}

	// Open Web AI & Feed endpoints
	llms := doReq(h, http.MethodGet, "/llms.txt", nil)
	if llms.Code != http.StatusOK || !strings.Contains(llms.Body.String(), "atomic-writes.md") {
		t.Fatalf("/llms.txt check failed: code=%d", llms.Code)
	}

	llmsFull := doReq(h, http.MethodGet, "/llms-full.txt", nil)
	if llmsFull.Code != http.StatusOK || !strings.Contains(llmsFull.Body.String(), "TITLE: Atomic File Writes") {
		t.Fatalf("/llms-full.txt check failed: code=%d", llmsFull.Code)
	}

	rss := doReq(h, http.MethodGet, "/feed.xml", nil)
	if rss.Code != http.StatusOK || !strings.Contains(rss.Body.String(), `<rss version="2.0"`) {
		t.Fatalf("/feed.xml check failed: code=%d", rss.Code)
	}

	atom := doReq(h, http.MethodGet, "/atom.xml", nil)
	if atom.Code != http.StatusOK || !strings.Contains(atom.Body.String(), `<feed xmlns="http://www.w3.org/2005/Atom"`) {
		t.Fatalf("/atom.xml check failed: code=%d", atom.Code)
	}

	jf := doReq(h, http.MethodGet, "/feed.json", nil)
	if jf.Code != http.StatusOK || !strings.Contains(jf.Body.String(), "https://jsonfeed.org/version/1.1") {
		t.Fatalf("/feed.json check failed: code=%d", jf.Code)
	}

	sitemap := doReq(h, http.MethodGet, "/sitemap.xml", nil)
	if sitemap.Code != http.StatusOK || !strings.Contains(sitemap.Body.String(), "https://blog.crackrammer.com/posts/atomic-writes") {
		t.Fatalf("/sitemap.xml check failed: code=%d", sitemap.Code)
	}

	robots := doReq(h, http.MethodGet, "/robots.txt", nil)
	if robots.Code != http.StatusOK || !strings.Contains(robots.Body.String(), "Disallow: /preview/") {
		t.Fatalf("/robots.txt check failed: code=%d", robots.Code)
	}

	// OpenGraph PNG endpoint renders valid 1200x630 PNG
	ogRec := doReq(h, http.MethodGet, "/api/og?type=post&slug=atomic-writes", nil)
	if ogRec.Code != http.StatusOK || ogRec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("/api/og check failed: code=%d ct=%q", ogRec.Code, ogRec.Header().Get("Content-Type"))
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(ogRec.Body.Bytes()))
	if err != nil || cfg.Width != 1200 || cfg.Height != 630 {
		t.Fatalf("unexpected OG PNG dimensions %dx%d (err=%v)", cfg.Width, cfg.Height, err)
	}
}

func TestUploadsSecurityHeadersAndTraversalProtection(t *testing.T) {
	srv, _ := newTestServer(t)
	h := srv.Handler()

	// Safe inline PNG
	okPNG := doReq(h, http.MethodGet, "/uploads/sample.png", nil)
	if okPNG.Code != http.StatusOK || okPNG.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("safe PNG upload failed: code=%d", okPNG.Code)
	}

	// SVG forces attachment + sandbox CSP
	svgRec := doReq(h, http.MethodGet, "/uploads/vector.svg", nil)
	if svgRec.Code != http.StatusOK ||
		!strings.Contains(svgRec.Header().Get("Content-Disposition"), "attachment") ||
		svgRec.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("SVG must force attachment download + sandbox CSP: headers=%v", svgRec.Header())
	}

	// Symlink and traversal must return 404
	if symRec := doReq(h, http.MethodGet, "/uploads/escape.txt", nil); symRec.Code != http.StatusNotFound {
		t.Fatalf("symlink upload must return 404, got %d", symRec.Code)
	}
	if travRec := doReq(h, http.MethodGet, "/uploads/%2e%2e/etc/passwd", nil); travRec.Code != http.StatusNotFound {
		t.Fatalf("traversal upload must return 404, got %d", travRec.Code)
	}
}
