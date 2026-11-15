package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/citadel"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/db"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/ops"
	"github.com/CRACKRAMMER/Inkbranch/internal/search"
	"github.com/CRACKRAMMER/Inkbranch/internal/server"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	version   = "2.0.0-dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	sub := "serve"
	rest := args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
		rest = args[1:]
	}

	switch sub {
	case "version":
		fmt.Printf("inkbranch %s (commit=%s, built=%s)\n", version, commit, buildDate)
		return 0
	case "validate":
		return runValidate(rest)
	case "migrate":
		return runMigrate()
	case "sync":
		return runSync(rest)
	case "seed":
		return runSeed(rest)
	case "backup":
		return runBackup(rest)
	case "restore":
		return runRestore(rest)
	case "admin":
		return runAdmin(rest)
	case "serve":
		return runServe(rest)
	case "help", "-h", "--help":
		printUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", sub)
		printUsage()
		return 2
	}
}

func printUsage() {
	fmt.Print(`Inkbranch v2 — Single-binary Go Knowledge Blog & Publishing Engine

Usage:
  inkbranch [command] [flags]

Commands:
  serve       Start HTTP server, content watcher, and scheduler (default)
  validate    Scan and validate frontmatter + Markdown links without DB
  sync        Sync disk Markdown files into PostgreSQL search/link index
  migrate     Apply embedded PostgreSQL schema migrations
  seed        Idempotently seed initial administrator (writes chmod 0600 file when password unset)
  backup      Create verified .tar.zst backup archive of DB state, content, and uploads
  restore     Verify and restore a .tar.zst backup archive (creates pre-restore safety backup)
  admin       Administrative maintenance subcommands (e.g. admin reset-password)
  version     Print binary build metadata
`)
}

func makeLogger() *slog.Logger {
	level := slog.LevelInfo
	if strings.EqualFold(os.Getenv("LOG_LEVEL"), "debug") {
		level = slog.LevelDebug
	}
	opts := &slog.HandlerOptions{Level: level}
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "json") {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}

func makeRenderHook(md *markdown.Renderer) content.RenderHook {
	return func(doc *content.Document, resolver content.LinkResolver) (string, []content.OutgoingLink, error) {
		res, err := md.Render(doc.Checksum, doc.Body, resolver)
		if err != nil {
			return "", nil, err
		}
		if len(res.Headings) > 0 {
			doc.Headings = res.Headings
		}
		return res.HTML, res.Links, nil
	}
}

func runValidate(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	contentDir := fs.String("content-dir", cfg.ContentDir, "Path to content directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	mdRenderer := markdown.NewRenderer()
	store := content.NewStore(*contentDir, makeRenderHook(mdRenderer))
	docs, valErrs, err := store.LoadAll()
	if err != nil {
		fmt.Fprintf(os.Stderr, "scan failed: %v\n", err)
		return 1
	}

	_, published := store.Stats()
	fmt.Printf("Scanned %d documents (%d published) in %s\n", len(docs), published, *contentDir)
	for _, ve := range valErrs {
		fmt.Fprintf(os.Stderr, "VALIDATION ERROR: %s\n", ve.Error())
	}
	if len(valErrs) > 0 {
		return 1
	}
	return 0
}

func runMigrate() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required for migrate")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL, cfg.DatabasePoolMax)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect database: %v\n", err)
		return 1
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "migrate failed: %v\n", err)
		return 1
	}
	fmt.Println("PostgreSQL migrations are up to date.")
	return 0
}

func runSync(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	contentDir := fs.String("content-dir", cfg.ContentDir, "Path to content directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required for sync")
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL, cfg.DatabasePoolMax)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect database: %v\n", err)
		return 1
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "migrate failed: %v\n", err)
		return 1
	}

	repo := db.NewRepo(pool)
	mdRenderer := markdown.NewRenderer()
	store := content.NewStore(*contentDir, makeRenderHook(mdRenderer))
	report, err := store.SyncToDatabase(ctx, repo, search.BuildSearchTokensString)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sync failed: %v\n", err)
		return 1
	}

	fmt.Printf("Sync complete: scanned=%d published=%d upserted=%d deleted=%d errors=%d\n",
		report.Scanned, report.Published, report.Upserted, report.Deleted, len(report.Errors))
	for _, ve := range report.Errors {
		fmt.Fprintf(os.Stderr, "VALIDATION ERROR: %s\n", ve.Error())
	}
	if len(report.Errors) > 0 {
		return 1
	}
	return 0
}

func openRuntimeState(ctx context.Context, cfg *config.Config, requireDB bool) (*pgxpool.Pool, *db.Repo, state.Store, error) {
	if cfg.DatabaseURL == "" {
		if requireDB {
			return nil, nil, nil, errors.New("DATABASE_URL is required")
		}
		return nil, nil, state.NewMemoryStore(), nil
	}
	dbCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	pool, err := db.NewPool(dbCtx, cfg.DatabaseURL, cfg.DatabasePoolMax)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("connect database: %w", err)
	}
	if err := db.RunMigrations(dbCtx, pool); err != nil {
		pool.Close()
		return nil, nil, nil, fmt.Errorf("run embedded migrations: %w", err)
	}
	return pool, db.NewRepo(pool), state.NewPostgresStore(pool), nil
}

func runSeed(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("seed", flag.ContinueOnError)
	passwordFile := fs.String("password-file", cfg.AdminPasswordFile, "Path to chmod 0600 file when generating initial password")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg.AdminPasswordFile = *passwordFile

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, _, stateStore, err := openRuntimeState(ctx, cfg, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	if pool != nil {
		defer pool.Close()
	}

	seeded, wrotePath, err := auth.EnsureInitialAdmin(ctx, stateStore, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "seed failed: %v\n", err)
		return 1
	}
	mode := "database"
	if pool == nil {
		mode = "memory"
	}
	if seeded {
		if wrotePath != "" {
			fmt.Printf("Initial admin seeded (mode=%s, email=%s, password_file=%s, mode=0600)\n", mode, cfg.AdminEmail, wrotePath)
		} else {
			fmt.Printf("Initial admin seeded from environment configuration (mode=%s, email=%s)\n", mode, cfg.AdminEmail)
		}
	} else {
		fmt.Printf("Initial admin already present (mode=%s); no changes made.\n", mode)
	}
	return 0
}

func runBackup(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	prefix := fs.String("prefix", "inkbranch-backup", "Backup filename prefix")
	contentDir := fs.String("content-dir", cfg.ContentDir, "Path to content directory")
	uploadsDir := fs.String("uploads-dir", cfg.UploadsDir, "Path to uploads directory")
	backupsDir := fs.String("backups-dir", cfg.BackupsDir, "Path to backups directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg.ContentDir = *contentDir
	cfg.UploadsDir = *uploadsDir
	cfg.BackupsDir = *backupsDir

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, _, stateStore, err := openRuntimeState(ctx, cfg, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	if pool != nil {
		defer pool.Close()
	}

	storageDriver, err := media.NewStorageDriver(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize storage driver: %v\n", err)
		return 1
	}

	rec, outPath, err := ops.CreateBackup(ctx, cfg, stateStore, storageDriver, nil, *prefix)
	if err != nil {
		fmt.Fprintf(os.Stderr, "backup failed: %v\n", err)
		return 1
	}
	fmt.Printf("Backup created: %s (bytes=%d, sha256=%s, driver=%s)\n", outPath, rec.ByteSize, rec.Checksum, rec.StorageDriver)
	return 0
}

func runRestore(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	archivePath := fs.String("file", "", "Path to .tar.zst backup archive")
	contentDir := fs.String("content-dir", cfg.ContentDir, "Path to content directory")
	uploadsDir := fs.String("uploads-dir", cfg.UploadsDir, "Path to uploads directory")
	backupsDir := fs.String("backups-dir", cfg.BackupsDir, "Path to backups directory (for safety pre-restore backup)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *archivePath == "" && fs.NArg() > 0 {
		*archivePath = fs.Arg(0)
	}
	if strings.TrimSpace(*archivePath) == "" {
		fmt.Fprintln(os.Stderr, "backup archive path is required (--file <path> or positional arg)")
		return 2
	}
	cfg.ContentDir = *contentDir
	cfg.UploadsDir = *uploadsDir
	cfg.BackupsDir = *backupsDir

	f, err := os.Open(*archivePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open archive: %v\n", err)
		return 1
	}
	defer f.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, repo, stateStore, err := openRuntimeState(ctx, cfg, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	if pool != nil {
		defer pool.Close()
	}

	storageDriver, err := media.NewStorageDriver(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize storage driver: %v\n", err)
		return 1
	}

	preRec, err := ops.RestoreBackup(ctx, cfg, stateStore, storageDriver, f)
	if err != nil {
		fmt.Fprintf(os.Stderr, "restore failed: %v\n", err)
		return 1
	}

	if repo != nil {
		mdRenderer := markdown.NewRenderer()
		store := content.NewStore(cfg.ContentDir, makeRenderHook(mdRenderer))
		if _, syncErr := store.SyncToDatabase(ctx, repo, search.BuildSearchTokensString); syncErr != nil {
			fmt.Fprintf(os.Stderr, "warning: content re-sync after restore failed: %v\n", syncErr)
		}
	}

	if preRec != nil {
		fmt.Printf("Backup restored successfully (pre-restore safety backup: %s)\n", preRec.Filename)
	} else {
		fmt.Println("Backup restored successfully.")
	}
	return 0
}

func runAdmin(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: inkbranch admin <reset-password> [flags]")
		return 2
	}
	switch args[0] {
	case "reset-password":
		cfg, err := config.Load()
		if err != nil {
			fmt.Fprintf(os.Stderr, "load config: %v\n", err)
			return 1
		}
		fs := flag.NewFlagSet("admin reset-password", flag.ContinueOnError)
		email := fs.String("email", cfg.AdminEmail, "Target admin email")
		explicitPassword := fs.String("password", "", "Optional explicit password (if omitted, generates high-entropy password to chmod 0600 file)")
		passwordFile := fs.String("password-file", cfg.AdminPasswordFile, "Path to chmod 0600 password file when --password is omitted")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		pool, _, stateStore, err := openRuntimeState(ctx, cfg, true)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return 1
		}
		defer pool.Close()

		wrotePath, err := auth.ResetAdminPassword(ctx, stateStore, cfg, *email, *explicitPassword, *passwordFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "reset-password failed: %v\n", err)
			return 1
		}
		if wrotePath != "" {
			fmt.Printf("Admin password reset complete; temporary password written to chmod 0600 file: %s\n", wrotePath)
		} else {
			fmt.Println("Admin password reset complete; all prior sessions revoked.")
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown admin subcommand %q\n", args[0])
		return 2
	}
}

func runServe(args []string) int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	contentDir := fs.String("content-dir", cfg.ContentDir, "Path to content directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg.ContentDir = *contentDir

	logger := makeLogger()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, repo, stateStore, err := openRuntimeState(ctx, cfg, false)
	if err != nil {
		logger.Error("database initialization failed", "error", err)
		return 1
	}
	if pool != nil {
		defer pool.Close()
		logger.Info("postgresql pool ready and migrations verified")
	} else {
		logger.Warn("DATABASE_URL not set; running with ephemeral in-memory state store")
	}

	if !cfg.HasConfiguredSecret() {
		logger.Warn("SESSION_SECRET not set; using ephemeral in-process secret (sessions will reset on restart)")
	}

	initCtx, initCancel := context.WithTimeout(ctx, 30*time.Second)
	if cfg.AuthMode != config.AuthModeCitadelOnly {
		seeded, wrotePassFile, err := auth.EnsureInitialAdmin(initCtx, stateStore, cfg)
		if err != nil {
			initCancel()
			logger.Error("initial admin seed failed", "error", err)
			return 1
		}
		if seeded {
			logger.Info("initial admin user seeded", "email", cfg.AdminEmail, "password_file", wrotePassFile)
		}
	} else {
		logger.Info("skipping initial local admin seed in citadel_only mode")
	}

	mdRenderer := markdown.NewRenderer()
	ogRenderer, err := media.NewOGRenderer()
	if err != nil {
		initCancel()
		logger.Error("initialize OG renderer failed", "error", err)
		return 1
	}
	storageDriver, err := media.NewStorageDriver(initCtx, cfg)
	if err != nil {
		initCancel()
		logger.Error("initialize storage driver failed", "error", err)
		return 1
	}

	store := content.NewStore(cfg.ContentDir, makeRenderHook(mdRenderer))
	report, err := store.SyncToDatabase(initCtx, repo, search.BuildSearchTokensString)
	initCancel()
	if err != nil {
		logger.Error("initial content sync failed", "error", err)
		return 1
	}
	logger.Info("content index loaded",
		"scanned", report.Scanned,
		"published", report.Published,
		"upserted", report.Upserted,
		"deleted", report.Deleted,
		"validation_errors", len(report.Errors),
	)
	for _, ve := range report.Errors {
		logger.Warn("content validation issue", "error", ve.Error())
	}

	authSvc := auth.NewService(cfg, stateStore)
	if cfg.UsesCitadel() {
		citClient := citadel.NewClient(citadel.Config{
			AppID:          cfg.CitadelAppID,
			InternalURL:    cfg.CitadelInternalURL,
			PublicURL:      cfg.CitadelPublicURL,
			InternalSecret: cfg.CitadelInternalSecret,
			SiteURL:        cfg.SiteURL,
			UpstreamURL:    "http://127.0.0.1:3000",
		}, logger)
		authSvc.SetCitadel(citClient)
		citClient.StartAutoRegister(ctx)
	}
	mailer := distribution.NewMailer(cfg)
	webhooks := distribution.NewWebhookDispatcher(cfg, stateStore)
	poller := community.NewFeedPoller()
	turnstile := community.NewTurnstileVerifier(cfg.TurnstileSecretKey)

	srv, err := server.New(server.Options{
		Config:    cfg,
		Logger:    logger,
		Pool:      pool,
		Repo:      repo,
		State:     stateStore,
		Auth:      authSvc,
		Storage:   storageDriver,
		Mailer:    mailer,
		Webhooks:  webhooks,
		Poller:    poller,
		Turnstile: turnstile,
		Store:     store,
		MD:        mdRenderer,
		OG:        ogRenderer,
		Version:   version,
	})
	if err != nil {
		logger.Error("initialize http server failed", "error", err)
		return 1
	}

	// Start background scheduler (scheduled publishing, friend RSS polling, analytics daily rollup).
	go ops.StartScheduler(ctx, ops.SchedulerDeps{
		Config:   cfg,
		Logger:   logger,
		Store:    store,
		Repo:     repo,
		State:    stateStore,
		Storage:  storageDriver,
		Webhooks: webhooks,
		Poller:   poller,
	})

	// Start content watcher for instant hot-reload on disk Markdown edits.
	go func() {
		err := content.Watch(ctx, cfg.ContentDir, logger, func(watchCtx context.Context) {
			mdRenderer.InvalidateCache()
			reloadCtx, cancel := context.WithTimeout(watchCtx, 20*time.Second)
			defer cancel()
			rep, rErr := store.SyncToDatabase(reloadCtx, repo, search.BuildSearchTokensString)
			if rErr != nil {
				logger.Error("content reload failed", "error", rErr)
				return
			}
			logger.Info("content reloaded from disk",
				"scanned", rep.Scanned,
				"published", rep.Published,
				"validation_errors", len(rep.Errors),
			)
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("content watcher stopped", "error", err)
		}
	}()

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("inkbranch server listening", "addr", addr, "site_url", cfg.SiteURL, "version", version)
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received; draining connections")
		shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutCtx); err != nil {
			logger.Error("graceful shutdown error", "error", err)
			return 1
		}
		return 0
	case serveErr := <-errCh:
		if serveErr != nil {
			logger.Error("http server exited unexpectedly", "error", serveErr)
			return 1
		}
		return 0
	}
}
