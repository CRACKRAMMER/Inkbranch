package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
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
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	webassets "github.com/CRACKRAMMER/Inkbranch/web"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	headStartMarker = "<!--INKBRANCH_HEAD_START-->"
	headEndMarker   = "<!--INKBRANCH_HEAD_END-->"
	noscriptMarker  = "<!--INKBRANCH_NOSCRIPT-->"
	preloadMarker   = "<!--INKBRANCH_PRELOAD-->"
)

const fallbackShellHTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <!--INKBRANCH_HEAD_START-->
    <title>Inkbranch</title>
    <meta name="description" content="Personal Knowledge System &amp; Modern Publishing Platform" />
    <!--INKBRANCH_HEAD_END-->
  </head>
  <body>
    <div id="root">
      <noscript>
        <!--INKBRANCH_NOSCRIPT-->
      </noscript>
    </div>
    <!--INKBRANCH_PRELOAD-->
  </body>
</html>`

var safeInlineUploadExts = map[string]bool{
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".webp": true,
	".gif":  true,
	".avif": true,
	".mp4":  true,
	".webm": true,
	".mp3":  true,
	".wav":  true,
	".ogg":  true,
	".pdf":  true,
}

// Options configures construction of the Inkbranch HTTP server.
type Options struct {
	Config    *config.Config
	Logger    *slog.Logger
	Pool      *pgxpool.Pool
	Repo      *db.Repo
	State     state.Store
	Auth      *auth.Service
	Storage   media.StorageDriver
	Mailer    distribution.MailSender
	Webhooks  *distribution.WebhookDispatcher
	Poller    *community.FeedPoller
	Turnstile *community.TurnstileVerifier
	Store     *content.Store
	MD        *markdown.Renderer
	OG        *media.OGRenderer
	Version   string
}

type shellTemplate struct {
	beforeHead     string
	headToNoscript string
	noscriptToPre  string
	afterPreload   string
}

// Server serves the Inkbranch API, Open Web feeds, static assets, and hybrid SEO HTML shell.
type Server struct {
	cfg       *config.Config
	logger    *slog.Logger
	pool      *pgxpool.Pool
	repo      *db.Repo
	state     state.Store
	auth      *auth.Service
	storage   media.StorageDriver
	mailer    distribution.MailSender
	webhooks  *distribution.WebhookDispatcher
	poller    *community.FeedPoller
	turnstile *community.TurnstileVerifier
	store     *content.Store
	md        *markdown.Renderer
	og        *media.OGRenderer
	router    *chi.Mux
	humaAPI   huma.API
	distSubFS fs.FS
	shell     shellTemplate
	chromaCSS string
	version   string
}

// New initializes the Chi router, middlewares, Huma OpenAPI endpoints, feeds, and SPA/SEO shell.
func New(opts Options) (*Server, error) {
	if opts.Config == nil {
		return nil, fmt.Errorf("config is required")
	}
	if opts.Store == nil {
		return nil, fmt.Errorf("content store is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	mdRenderer := opts.MD
	if mdRenderer == nil {
		mdRenderer = markdown.NewRenderer()
	}
	ogRenderer := opts.OG
	if ogRenderer == nil {
		var err error
		ogRenderer, err = media.NewOGRenderer()
		if err != nil {
			return nil, fmt.Errorf("initialize OG renderer: %w", err)
		}
	}
	st := opts.State
	if st == nil {
		if opts.Pool != nil {
			st = state.NewPostgresStore(opts.Pool)
		} else {
			st = state.NewMemoryStore()
		}
	}
	authSvc := opts.Auth
	if authSvc == nil {
		authSvc = auth.NewService(opts.Config, st)
	}
	storageDriver := opts.Storage
	if storageDriver == nil {
		storageDriver = media.NewLocalStorage(opts.Config.UploadsDir)
	}
	mailer := opts.Mailer
	if mailer == nil {
		mailer = distribution.NewMailer(opts.Config)
	}
	webhooks := opts.Webhooks
	if webhooks == nil {
		webhooks = distribution.NewWebhookDispatcher(opts.Config, st)
	}
	poller := opts.Poller
	if poller == nil {
		poller = community.NewFeedPoller()
	}
	turnstile := opts.Turnstile
	if turnstile == nil {
		turnstile = community.NewTurnstileVerifier(opts.Config.TurnstileSecretKey)
	}
	version := strings.TrimSpace(opts.Version)
	if version == "" {
		version = "2.0.0-dev"
	}

	distSubFS, err := fs.Sub(webassets.DistFS, "dist")
	if err != nil {
		return nil, fmt.Errorf("mount embedded web/dist: %w", err)
	}
	shellRaw := fallbackShellHTML
	if bytes, err := fs.ReadFile(distSubFS, "index.html"); err == nil {
		if parsed, ok := splitShellTemplate(string(bytes)); ok {
			shellRaw = string(bytes)
			_ = parsed
		}
	}
	tmpl, ok := splitShellTemplate(shellRaw)
	if !ok {
		return nil, fmt.Errorf("invalid index shell template markers")
	}

	r := chi.NewRouter()
	s := &Server{
		cfg:       opts.Config,
		logger:    logger,
		pool:      opts.Pool,
		repo:      opts.Repo,
		state:     st,
		auth:      authSvc,
		storage:   storageDriver,
		mailer:    mailer,
		webhooks:  webhooks,
		poller:    poller,
		turnstile: turnstile,
		store:     opts.Store,
		md:        mdRenderer,
		og:        ogRenderer,
		router:    r,
		distSubFS: distSubFS,
		shell:     tmpl,
		chromaCSS: markdown.ChromaLightCSS() + "\n" + markdown.ChromaDarkCSS(),
		version:   version,
	}

	// Register all middlewares before any route registration (required by chi).
	r.Use(middleware.RequestID)
	r.Use(s.recoverMiddleware)
	if s.cfg.TrustProxy {
		r.Use(middleware.RealIP)
	}
	r.Use(middleware.StripSlashes)
	r.Use(s.securityHeadersMiddleware)
	r.Use(s.requestLogMiddleware)
	r.Use(s.redirectMiddleware)

	humaCfg := huma.DefaultConfig("Inkbranch API", s.version)
	humaCfg.OpenAPIPath = "/api/openapi"
	humaCfg.DocsPath = "/api/docs"
	humaCfg.SchemasPath = "/api/schemas"
	s.humaAPI = humachi.New(r, humaCfg)

	s.registerAPIRoutes()
	s.registerPublicV2Routes()
	s.registerAdminRoutes()
	s.registerFeedRoutes()
	s.registerAssetRoutes()
	s.registerPageRoutes()

	return s, nil
}

// reloadContentStore invalidates render cache and resynchronizes disk content into memory and PostgreSQL.
func (s *Server) reloadContentStore(ctx context.Context) error {
	s.md.InvalidateCache()
	_, err := s.store.SyncToDatabase(ctx, s.repo, search.BuildSearchTokensString)
	return err
}

// Handler returns the root HTTP handler ready for net/http or httptest.
func (s *Server) Handler() http.Handler {
	return s.router
}

func splitShellTemplate(raw string) (shellTemplate, bool) {
	hs := strings.Index(raw, headStartMarker)
	if hs < 0 {
		return shellTemplate{}, false
	}
	heRel := strings.Index(raw[hs+len(headStartMarker):], headEndMarker)
	if heRel < 0 {
		return shellTemplate{}, false
	}
	he := hs + len(headStartMarker) + heRel
	afterHead := he + len(headEndMarker)

	nsRel := strings.Index(raw[afterHead:], noscriptMarker)
	if nsRel < 0 {
		return shellTemplate{}, false
	}
	ns := afterHead + nsRel
	afterNoscript := ns + len(noscriptMarker)

	prRel := strings.Index(raw[afterNoscript:], preloadMarker)
	if prRel < 0 {
		return shellTemplate{}, false
	}
	pr := afterNoscript + prRel
	afterPreload := pr + len(preloadMarker)

	return shellTemplate{
		beforeHead:     raw[:hs],
		headToNoscript: raw[afterHead:ns],
		noscriptToPre:  raw[afterNoscript:pr],
		afterPreload:   raw[afterPreload:],
	}, true
}

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				s.logger.Error("http panic recovered",
					"request_id", middleware.GetReqID(r.Context()),
					"method", r.Method,
					"path", r.URL.Path,
					"panic", rec,
					"stack", string(debug.Stack()),
				)
				if r.Header.Get("Connection") != "Upgrade" {
					http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
				}
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requestLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		attrs := []any{
			"request_id", middleware.GetReqID(r.Context()),
			"method", r.Method,
			"path", r.URL.Path,
			"status", status,
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if status >= 500 {
			s.logger.Error("http request failed", attrs...)
		} else {
			s.logger.Debug("http request", attrs...)
		}
	})
}

func (s *Server) redirectMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/uploads/") || strings.HasPrefix(p, "/admin") {
			next.ServeHTTP(w, r)
			return
		}
		var targetPath string
		var statusCode int
		if s.state != nil {
			if rec, err := s.state.FindRedirect(r.Context(), p); err == nil && rec != nil {
				targetPath = rec.TargetPath
				statusCode = rec.StatusCode
				_ = s.state.IncrementRedirectHit(r.Context(), rec.ID)
			}
		}
		if targetPath == "" && s.repo != nil {
			if rec, err := s.repo.FindRedirect(r.Context(), p); err == nil && rec != nil {
				targetPath = rec.TargetPath
				statusCode = rec.StatusCode
			}
		}
		if targetPath == "" || targetPath == p || !content.IsSafeURL(targetPath) {
			next.ServeHTTP(w, r)
			return
		}
		switch statusCode {
		case http.StatusMovedPermanently, http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		default:
			statusCode = http.StatusMovedPermanently
		}
		http.Redirect(w, r, targetPath, statusCode)
	})
}

func (s *Server) registerAssetRoutes() {
	s.router.Get("/favicon.ico", s.serveEmbeddedFile("favicon.ico", "image/x-icon", "public, max-age=86400"))
	s.router.Get("/favicon.svg", s.serveEmbeddedFile("favicon.svg", "image/svg+xml; charset=utf-8", "public, max-age=86400"))

	assetHandler := http.FileServer(http.FS(s.distSubFS))
	s.router.Get("/assets/*", func(w http.ResponseWriter, r *http.Request) {
		reqPath := chi.URLParam(r, "*")
		clean := path.Clean("/" + reqPath)
		if clean == "/" || strings.Contains(clean, "..") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		assetHandler.ServeHTTP(w, r)
	})

	s.router.Get("/uploads/*", s.handleUploads)
}

func (s *Server) serveEmbeddedFile(name, contentType, cacheControl string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := fs.ReadFile(s.distSubFS, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		if cacheControl != "" {
			w.Header().Set("Cache-Control", cacheControl)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

func (s *Server) handleUploads(w http.ResponseWriter, r *http.Request) {
	rawWild := chi.URLParam(r, "*")
	unescaped, err := url.PathUnescape(rawWild)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if strings.Contains(unescaped, "\\") || strings.ContainsRune(unescaped, '\x00') {
		http.NotFound(w, r)
		return
	}
	cleanSlash := path.Clean("/" + unescaped)
	relSlash := strings.TrimPrefix(cleanSlash, "/")
	if relSlash == "" || relSlash == "." || strings.HasPrefix(relSlash, "..") {
		http.NotFound(w, r)
		return
	}
	for _, seg := range strings.Split(relSlash, "/") {
		if seg == "" || seg == ".." || strings.HasPrefix(seg, ".") {
			http.NotFound(w, r)
			return
		}
	}

	rootAbs, err := filepath.Abs(s.cfg.UploadsDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	targetAbs := filepath.Join(rootAbs, filepath.FromSlash(relSlash))
	if !strings.HasPrefix(targetAbs, rootAbs+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}

	// Reject symlinks anywhere along the resolved upload path to prevent sandbox escape.
	cur := rootAbs
	localMissing := false
	for _, seg := range strings.Split(relSlash, "/") {
		cur = filepath.Join(cur, seg)
		st, statErr := os.Lstat(cur)
		if statErr != nil {
			if os.IsNotExist(statErr) && s.storage != nil && s.storage.DriverName() == "r2" {
				localMissing = true
				break
			}
			http.NotFound(w, r)
			return
		}
		if st.Mode()&os.ModeSymlink != 0 {
			http.NotFound(w, r)
			return
		}
	}

	if localMissing {
		data, getErr := s.storage.Get(r.Context(), relSlash)
		if getErr != nil {
			http.NotFound(w, r)
			return
		}
		applyUploadHeaders(w, filepath.Base(relSlash))
		http.ServeContent(w, r, filepath.Base(relSlash), time.Time{}, bytes.NewReader(data))
		return
	}

	f, err := os.Open(targetAbs)
	if err != nil {
		if os.IsNotExist(err) && s.storage != nil && s.storage.DriverName() == "r2" {
			if data, getErr := s.storage.Get(r.Context(), relSlash); getErr == nil {
				applyUploadHeaders(w, filepath.Base(relSlash))
				http.ServeContent(w, r, filepath.Base(relSlash), time.Time{}, bytes.NewReader(data))
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}

	applyUploadHeaders(w, filepath.Base(targetAbs))
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func applyUploadHeaders(w http.ResponseWriter, filename string) {
	ext := strings.ToLower(filepath.Ext(filename))
	if !safeInlineUploadExts[ext] {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
		w.Header().Set("Content-Security-Policy", "sandbox")
	}
	if ct := mime.TypeByExtension(ext); ct != "" && safeInlineUploadExts[ext] {
		w.Header().Set("Content-Type", ct)
	} else if !safeInlineUploadExts[ext] {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
