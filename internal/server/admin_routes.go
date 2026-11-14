package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/ops"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (s *Server) registerAdminRoutes() {
	// Auth endpoints
	s.router.Get("/api/v1/auth/me", s.handleAuthMe)
	s.router.Post("/api/v1/auth/login", s.handleAuthLogin)
	s.router.Post("/api/v1/auth/mfa/verify", s.handleAuthMFAVerify)
	s.router.Post("/api/v1/auth/passkey/login/begin", s.handlePasskeyLoginBegin)
	s.router.Post("/api/v1/auth/passkey/login/finish", s.handlePasskeyLoginFinish)
	s.router.Post("/api/v1/auth/logout", s.withAdminAuth("", s.handleAuthLogout))

	// Studio endpoints
	s.router.Get("/api/v1/admin/overview", s.withAdminAuth("content:read", s.handleAdminOverview))

	s.router.Get("/api/v1/admin/content", s.withAdminAuth("content:read", s.handleAdminListContent))
	s.router.Get("/api/v1/admin/content/{type}/{slug}", s.withAdminAuth("content:read", s.handleAdminGetContent))
	s.router.Post("/api/v1/admin/content", s.withAdminAuth("content:write", s.handleAdminSaveContent))
	s.router.Delete("/api/v1/admin/content/{type}/{slug}", s.withAdminAuth("content:write", s.handleAdminDeleteContent))
	s.router.Post("/api/v1/admin/markdown/preview", s.withAdminAuth("content:read", s.handleAdminMarkdownPreview))

	s.router.Get("/api/v1/admin/revisions/{id}", s.withAdminAuth("content:read", s.handleAdminGetRevision))
	s.router.Post("/api/v1/admin/revisions/{id}/restore", s.withAdminAuth("content:write", s.handleAdminRestoreRevision))

	s.router.Get("/api/v1/admin/previews", s.withAdminAuth("content:write", s.handleAdminListPreviews))
	s.router.Post("/api/v1/admin/previews", s.withAdminAuth("content:write", s.handleAdminCreatePreview))
	s.router.Delete("/api/v1/admin/previews/{id}", s.withAdminAuth("content:write", s.handleAdminRevokePreview))

	s.router.Get("/api/v1/admin/media", s.withAdminAuth("content:read", s.handleAdminListMedia))
	s.router.Post("/api/v1/admin/media", s.withAdminAuth("media:write", s.handleAdminUploadMedia))
	s.router.Get("/api/v1/admin/media/orphans", s.withAdminAuth("content:read", s.handleAdminListOrphans))
	s.router.Post("/api/v1/admin/media/orphans/clean", s.withAdminAuth("media:write", s.handleAdminCleanOrphans))
	s.router.Delete("/api/v1/admin/media/{id}", s.withAdminAuth("media:write", s.handleAdminDeleteMedia))

	s.router.Get("/api/v1/admin/comments", s.withAdminAuth("comments:moderate", s.handleAdminListComments))
	s.router.Patch("/api/v1/admin/comments/{id}", s.withAdminAuth("comments:moderate", s.handleAdminModerateComment))
	s.router.Post("/api/v1/admin/comments/{id}/reply", s.withAdminAuth("comments:moderate", s.handleAdminReplyComment))
	s.router.Delete("/api/v1/admin/comments/{id}", s.withAdminAuth("comments:moderate", s.handleAdminDeleteComment))

	s.router.Get("/api/v1/admin/friends", s.withAdminAuth("content:read", s.handleAdminListFriends))
	s.router.Post("/api/v1/admin/friends", s.withAdminAuth("content:write", s.handleAdminSaveFriend))
	s.router.Patch("/api/v1/admin/friends/{id}", s.withAdminAuth("content:write", s.handleAdminUpdateFriend))
	s.router.Delete("/api/v1/admin/friends/{id}", s.withAdminAuth("content:write", s.handleAdminDeleteFriend))
	s.router.Post("/api/v1/admin/friends/poll", s.withAdminAuth("content:write", s.handleAdminPollFriends))

	s.router.Get("/api/v1/admin/newsletter/subscribers", s.withAdminAuth("content:read", s.handleAdminListSubscribers))
	s.router.Delete("/api/v1/admin/newsletter/subscribers/{id}", s.withAdminAuth("content:write", s.handleAdminDeleteSubscriber))
	s.router.Get("/api/v1/admin/newsletter/campaigns", s.withAdminAuth("content:read", s.handleAdminListCampaigns))
	s.router.Post("/api/v1/admin/newsletter/send", s.withAdminAuth("content:write", s.handleAdminSendNewsletter))

	s.router.Get("/api/v1/admin/redirects", s.withAdminAuth("content:read", s.handleAdminListRedirects))
	s.router.Post("/api/v1/admin/redirects", s.withAdminAuth("content:write", s.handleAdminCreateRedirect))
	s.router.Delete("/api/v1/admin/redirects/{id}", s.withAdminAuth("content:write", s.handleAdminDeleteRedirect))

	s.router.Get("/api/v1/admin/settings", s.withAdminAuth("content:read", s.handleAdminGetSettings))
	s.router.Put("/api/v1/admin/settings", s.withAdminAuth("content:write", s.handleAdminPutSettings))

	s.router.Get("/api/v1/admin/tokens", s.withAdminAuth("admin:*", s.handleAdminListTokens))
	s.router.Post("/api/v1/admin/tokens", s.withAdminAuth("admin:*", s.handleAdminCreateToken))
	s.router.Delete("/api/v1/admin/tokens/{id}", s.withAdminAuth("admin:*", s.handleAdminRevokeToken))

	s.router.Get("/api/v1/admin/webhooks", s.withAdminAuth("webhooks:manage", s.handleAdminListWebhooks))
	s.router.Post("/api/v1/admin/webhooks", s.withAdminAuth("webhooks:manage", s.handleAdminSaveWebhook))
	s.router.Patch("/api/v1/admin/webhooks/{id}", s.withAdminAuth("webhooks:manage", s.handleAdminUpdateWebhook))
	s.router.Delete("/api/v1/admin/webhooks/{id}", s.withAdminAuth("webhooks:manage", s.handleAdminDeleteWebhook))
	s.router.Post("/api/v1/admin/webhooks/{id}/test", s.withAdminAuth("webhooks:manage", s.handleAdminTestWebhook))
	s.router.Get("/api/v1/admin/webhooks/{id}/deliveries", s.withAdminAuth("webhooks:manage", s.handleAdminWebhookDeliveries))

	s.router.Get("/api/v1/admin/security", s.withAdminAuth("admin:*", s.handleAdminSecurityOverview))
	s.router.Post("/api/v1/admin/security/password", s.withAdminSessionOnly(s.handleAdminChangePassword))
	s.router.Post("/api/v1/admin/security/totp/setup", s.withAdminSessionOnly(s.handleAdminSetupTOTP))
	s.router.Post("/api/v1/admin/security/totp/verify", s.withAdminSessionOnly(s.handleAdminVerifyTOTP))
	s.router.Delete("/api/v1/admin/security/totp", s.withAdminSessionOnly(s.handleAdminDisableTOTP))
	s.router.Post("/api/v1/admin/security/passkeys/register/begin", s.withAdminSessionOnly(s.handleAdminPasskeyBegin))
	s.router.Post("/api/v1/admin/security/passkeys/register/finish", s.withAdminSessionOnly(s.handleAdminPasskeyFinish))
	s.router.Delete("/api/v1/admin/security/passkeys/{id}", s.withAdminSessionOnly(s.handleAdminPasskeyDelete))
	s.router.Delete("/api/v1/admin/security/sessions/{id}", s.withAdminSessionOnly(s.handleAdminRevokeSession))

	s.router.Get("/api/v1/admin/backups", s.withAdminAuth("admin:*", s.handleAdminListBackups))
	s.router.Post("/api/v1/admin/backups", s.withAdminAuth("admin:*", s.handleAdminCreateBackup))
	s.router.Get("/api/v1/admin/backups/{id}/download", s.withAdminAuth("admin:*", s.handleAdminDownloadBackup))
	s.router.Post("/api/v1/admin/backups/restore", s.withAdminAuth("admin:*", s.handleAdminRestoreBackup))
}

type adminHandlerFunc func(w http.ResponseWriter, r *http.Request, p *auth.Principal)

func (s *Server) withAdminAuth(requiredScope string, fn adminHandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.auth.AuthenticateRequest(r)
		if err != nil {
			writeAPIError(w, http.StatusUnauthorized, "Authentication required", err.Error())
			return
		}
		if !s.auth.VerifyCSRF(r, p) {
			writeAPIError(w, http.StatusForbidden, "CSRF verification failed", "Missing or invalid X-CSRF-Token header.")
			return
		}
		if requiredScope != "" && !p.HasScope(requiredScope) {
			writeAPIError(w, http.StatusForbidden, "Insufficient scope", "Required scope: "+requiredScope)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		fn(w, r, p)
	}
}

func (s *Server) withAdminSessionOnly(fn adminHandlerFunc) http.HandlerFunc {
	return s.withAdminAuth("", func(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
		if p.AuthKind != "session" {
			writeAPIError(w, http.StatusForbidden, "Session required", "Security changes require an interactive browser session.")
			return
		}
		fn(w, r, p)
	})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, err := s.auth.AuthenticateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	csrf := ""
	if p.Session != nil {
		csrf = p.Session.CSRFSecret
	}
	totpEnabled := false
	recoveryLeft := 0
	if t, err := s.state.GetTOTP(r.Context(), p.User.ID); err == nil && t != nil {
		totpEnabled = t.Enabled
		recoveryLeft = len(t.RecoveryCodeHashes)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated":          true,
		"authKind":               p.AuthKind,
		"user":                   p.User,
		"csrfToken":              csrf,
		"totpEnabled":            totpEnabled,
		"recoveryCodesRemaining": recoveryLeft,
	})
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("login", ipHash, 10, 10*time.Minute) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many login attempts", "Please wait 10 minutes before trying again.")
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	outcome, err := s.auth.LoginWithPassword(r.Context(), body.Email, body.Password, r)
	if err != nil {
		_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
			ActorType: "anonymous",
			Action:    "auth.login.failed",
			IPHash:    ipHash,
		})
		writeAPIError(w, http.StatusUnauthorized, "Invalid credentials", "Email or password is incorrect.")
		return
	}
	if outcome.MFARequired {
		writeJSON(w, http.StatusOK, map[string]any{
			"authenticated": false,
			"mfaRequired":   true,
			"mfaToken":      outcome.MFAToken,
		})
		return
	}
	s.auth.SetSessionCookie(w, r, outcome.CookieToken, outcome.Session.ExpiresAt)
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &outcome.User.ID,
		Action:    "auth.login.success",
		IPHash:    ipHash,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"user":          outcome.User,
		"csrfToken":     outcome.Session.CSRFSecret,
	})
}

func (s *Server) handleAuthMFAVerify(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("mfa", ipHash, 10, 10*time.Minute) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many attempts", "")
		return
	}
	var body struct {
		MFAToken string `json:"mfaToken"`
		Code     string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	outcome, err := s.auth.VerifyMFACode(r.Context(), body.MFAToken, body.Code, r)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "Verification failed", err.Error())
		return
	}
	s.auth.SetSessionCookie(w, r, outcome.CookieToken, outcome.Session.ExpiresAt)
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &outcome.User.ID,
		Action:    "auth.mfa.success",
		IPHash:    ipHash,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"user":          outcome.User,
		"csrfToken":     outcome.Session.CSRFSecret,
	})
}

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var body struct {
		Email string `json:"email"`
	}
	_ = decodeJSON(r, &body)
	cid, options, err := s.auth.BeginPasskeyLogin(r.Context(), body.Email, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Passkey login unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ceremonyId": cid,
		"options":    options,
	})
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	cid := strings.TrimSpace(r.URL.Query().Get("ceremonyId"))
	if cid == "" {
		cid = strings.TrimSpace(r.Header.Get("X-WebAuthn-Ceremony"))
	}
	if cid == "" {
		writeAPIError(w, http.StatusBadRequest, "ceremonyId is required", "")
		return
	}
	outcome, err := s.auth.FinishPasskeyLogin(r.Context(), cid, r)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "Passkey verification failed", err.Error())
		return
	}
	s.auth.SetSessionCookie(w, r, outcome.CookieToken, outcome.Session.ExpiresAt)
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &outcome.User.ID,
		Action:    "auth.passkey.success",
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"user":          outcome.User,
		"csrfToken":     outcome.Session.CSRFSecret,
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	if p.Session != nil {
		_ = s.state.DeleteSession(r.Context(), p.Session.ID)
	}
	s.auth.ClearSessionCookie(w, r)
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "auth.logout",
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	docs := s.store.ListAll()
	counts := map[string]int{
		"total":     len(docs),
		"published": 0,
		"draft":     0,
		"scheduled": 0,
		"archived":  0,
		"unlisted":  0,
		"posts":     0,
		"notes":     0,
		"projects":  0,
	}
	for _, d := range docs {
		counts[string(d.Status)]++
		switch d.Type {
		case content.TypePost:
			counts["posts"]++
		case content.TypeNote:
			counts["notes"]++
		case content.TypeProject:
			counts["projects"]++
		}
	}

	pendingComments, _ := s.state.ListComments(r.Context(), "", "", "pending")
	pendingFriends, _ := s.state.ListFriendLinks(r.Context(), "pending")
	activeSubs, _ := s.state.ListSubscribers(r.Context(), "active")
	backups, _ := s.state.ListBackups(r.Context())
	audits, _ := s.state.ListAuditLogs(r.Context(), 12)
	analytics30d, _ := s.state.GetAnalyticsOverview(r.Context(), 30)

	if audits == nil {
		audits = []state.AuditLogRecord{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"content": counts,
		"inbox": map[string]int{
			"pendingComments":   len(pendingComments),
			"pendingFriends":    len(pendingFriends),
			"activeSubscribers": len(activeSubs),
			"backups":           len(backups),
		},
		"analytics": analytics30d,
		"auditLogs": audits,
	})
}

func (s *Server) handleAdminListContent(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	typeFilter := strings.TrimSpace(r.URL.Query().Get("type"))
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))

	var ct content.ContentType
	if typeFilter != "" {
		parsed, ok := parseContentTypeFilter(typeFilter)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
			return
		}
		ct = parsed
	}

	docs := s.store.ListAll()
	type adminContentItem struct {
		ContentSummary
		RelativePath string `json:"relativePath"`
		Checksum     string `json:"checksum"`
		ScheduledAt  string `json:"scheduledAt,omitempty"`
	}
	items := make([]adminContentItem, 0, len(docs))
	for _, d := range docs {
		if ct != "" && d.Type != ct {
			continue
		}
		if statusFilter != "" && string(d.Status) != statusFilter {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(d.Title+" "+d.Slug+" "+d.Category), q) {
			continue
		}
		sched := ""
		if d.ScheduledAt != nil {
			sched = d.ScheduledAt.UTC().Format(time.RFC3339)
		}
		items = append(items, adminContentItem{
			ContentSummary: toContentSummary(d),
			RelativePath:   d.RelativePath,
			Checksum:       d.Checksum,
			ScheduledAt:    sched,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminGetContent(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	ct, ok := parseContentTypeFilter(chi.URLParam(r, "type"))
	slug := pathParamUnescaped(r, "slug")
	if !ok || slug == "" {
		writeAPIError(w, http.StatusNotFound, "Invalid content target", "")
		return
	}
	doc, found := s.store.GetAny(ct, slug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}
	revs, _ := s.state.ListRevisions(r.Context(), string(doc.Type), doc.Slug)
	if revs == nil {
		revs = []state.RevisionRecord{}
	}
	previews, _ := s.state.ListDraftPreviews(r.Context(), string(doc.Type), doc.Slug)
	if previews == nil {
		previews = []state.DraftPreviewRecord{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"document":     s.buildDocumentDetailPayload(doc).Document,
		"relativePath": doc.RelativePath,
		"checksum":     doc.Checksum,
		"rawMarkdown":  doc.Raw,
		"revisions":    revs,
		"previews":     previews,
	})
}

func (s *Server) handleAdminSaveContent(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		Type                   string `json:"type"`
		Filename               string `json:"filename"`
		RawMarkdown            string `json:"rawMarkdown"`
		ExpectedChecksum       string `json:"expectedChecksum"`
		PreviousPath           string `json:"previousPath"`
		CreateRedirectOnRename *bool  `json:"createRedirectOnRename"`
		Note                   string `json:"note"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ct, ok := parseContentTypeFilter(body.Type)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "Invalid content type", "Must be post, note, or project.")
		return
	}
	raw := strings.ReplaceAll(body.RawMarkdown, "\r\n", "\n")
	yamlPart, mdBody, _, err := content.SplitFrontmatter(raw)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Frontmatter error", err.Error())
		return
	}
	fm, err := content.ParseFrontmatter(yamlPart, ct)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Frontmatter validation error", err.Error())
		return
	}

	fileSlugHint := fm.Slug
	if fileSlugHint == "" && strings.TrimSpace(body.Filename) != "" {
		fileSlugHint = strings.TrimSuffix(filepath.Base(strings.TrimSpace(body.Filename)), ".md")
	}
	derived := content.DeriveDocumentMetadata(ct, fileSlugHint+".md", mdBody, fm.Title, fm.Slug, fm.Description)
	relPath := fmt.Sprintf("%s/%s.md", ct.Dir(), derived.Slug)

	expectedSHA := strings.TrimSpace(body.ExpectedChecksum)
	prevPath := filepath.ToSlash(strings.TrimSpace(body.PreviousPath))
	if prevPath != "" && prevPath != relPath {
		expectedSHA = ""
	}

	var prevDoc *content.Document
	if prevPath != "" {
		prevDoc, _ = s.store.GetByPath(prevPath)
	} else {
		prevDoc, _ = s.store.GetByPath(relPath)
	}

	writeRes, err := content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:     s.cfg.ContentDir,
		RelativePath:   relPath,
		Data:           []byte(raw),
		ExpectedSHA256: expectedSHA,
	})
	if err != nil {
		status := http.StatusInternalServerError
		if err == content.ErrConflict {
			status = http.StatusConflict
		} else if err == content.ErrLocked {
			status = http.StatusLocked
		}
		writeAPIError(w, status, "Save failed", err.Error())
		return
	}

	var autoRedirectCreated string
	if prevPath != "" && prevPath != relPath {
		_ = s.state.MigrateContentPath(r.Context(), prevPath, relPath)
		_ = content.DeleteDocumentFile(s.cfg.ContentDir, prevPath)
		createRedir := true
		if body.CreateRedirectOnRename != nil {
			createRedir = *body.CreateRedirectOnRename
		}
		if createRedir && prevDoc != nil {
			oldURL := prevDoc.CanonicalURL()
			newURL := (&content.Document{Type: ct, Slug: derived.Slug}).CanonicalURL()
			existing, _ := s.state.ListRedirects(r.Context())
			if state.ValidateRedirectGraph(existing, oldURL, newURL) == nil {
				if err := s.state.CreateRedirect(r.Context(), state.RedirectRecord{
					ID:         uuid.New(),
					SourcePath: oldURL,
					TargetPath: newURL,
					StatusCode: 301,
					CreatedAt:  time.Now().UTC(),
				}); err == nil {
					autoRedirectCreated = oldURL + " -> " + newURL
				}
			}
		}
	}

	if err := s.reloadContentStore(r.Context()); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Saved file but reload failed", err.Error())
		return
	}

	// Store zstd-compressed revision
	if compressed, cErr := ops.ZstdCompressBytes([]byte(raw)); cErr == nil {
		note := strings.TrimSpace(body.Note)
		if note == "" {
			note = "Saved via Admin Studio"
		}
		_, _ = s.state.CreateRevision(r.Context(), state.RevisionRecord{
			ID:             uuid.New(),
			ContentID:      state.ContentUUID(relPath),
			ContentType:    string(ct),
			ContentSlug:    derived.Slug,
			Path:           relPath,
			Checksum:       writeRes.SHA256,
			CompressedBody: compressed,
			ActorID:        &p.User.ID,
			Note:           note,
			CreatedAt:      time.Now().UTC(),
		})
	}

	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType:  "user",
		ActorID:    &p.User.ID,
		Action:     "content.save",
		TargetType: string(ct),
		TargetID:   derived.Slug,
		IPHash:     s.auth.ClientIPHash(r),
	})

	if s.webhooks != nil {
		evName := "content.saved"
		if fm.Status == content.StatusPublished {
			evName = "content.published"
		}
		s.webhooks.Dispatch(r.Context(), evName, map[string]any{
			"type":         string(ct),
			"slug":         derived.Slug,
			"title":        derived.Title,
			"status":       string(fm.Status),
			"relativePath": relPath,
		})
	}

	doc, _ := s.store.GetAny(ct, derived.Slug)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                  true,
		"relativePath":        relPath,
		"checksum":            writeRes.SHA256,
		"slug":                derived.Slug,
		"url":                 (&content.Document{Type: ct, Slug: derived.Slug}).CanonicalURL(),
		"autoRedirectCreated": autoRedirectCreated,
		"document": func() any {
			if doc != nil {
				return s.buildDocumentDetailPayload(doc).Document
			}
			return nil
		}(),
	})
}

func (s *Server) handleAdminDeleteContent(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	ct, ok := parseContentTypeFilter(chi.URLParam(r, "type"))
	slug := pathParamUnescaped(r, "slug")
	if !ok || slug == "" {
		writeAPIError(w, http.StatusNotFound, "Invalid content target", "")
		return
	}
	doc, found := s.store.GetAny(ct, slug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}
	if err := content.DeleteDocumentFile(s.cfg.ContentDir, doc.RelativePath); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to delete document", err.Error())
		return
	}
	_ = s.reloadContentStore(r.Context())
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType:  "user",
		ActorID:    &p.User.ID,
		Action:     "content.delete",
		TargetType: string(doc.Type),
		TargetID:   doc.Slug,
		IPHash:     s.auth.ClientIPHash(r),
	})
	if s.webhooks != nil {
		s.webhooks.Dispatch(r.Context(), "content.deleted", map[string]any{
			"type": string(doc.Type),
			"slug": doc.Slug,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminMarkdownPreview(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	var body struct {
		Type        string `json:"type"`
		RawMarkdown string `json:"rawMarkdown"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ct, ok := parseContentTypeFilter(body.Type)
	if !ok {
		ct = content.TypePost
	}
	raw := strings.ReplaceAll(body.RawMarkdown, "\r\n", "\n")
	yamlPart, mdBody, _, splitErr := content.SplitFrontmatter(raw)
	if splitErr != nil {
		// Allow live previewing pure Markdown before frontmatter is closed
		mdBody = raw
	}
	var frontmatterError string
	var title string
	if splitErr == nil {
		fm, err := content.ParseFrontmatter(yamlPart, ct)
		if err != nil {
			frontmatterError = err.Error()
		} else {
			title = fm.Title
		}
	}
	res, err := s.md.Render("preview:"+content.SHA256Hex([]byte(mdBody)), mdBody, s.store)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Render error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"title":            title,
		"frontmatterError": frontmatterError,
		"renderedHtml":     res.HTML,
		"headings":         res.Headings,
	})
}

func (s *Server) handleAdminGetRevision(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid revision ID", "")
		return
	}
	rev, err := s.state.GetRevision(r.Context(), id)
	if err != nil || rev == nil {
		writeAPIError(w, http.StatusNotFound, "Revision not found", "")
		return
	}
	raw, err := ops.ZstdDecompressBytes(rev.CompressedBody)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to decompress revision", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"revision":    rev,
		"rawMarkdown": string(raw),
	})
}

func (s *Server) handleAdminRestoreRevision(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid revision ID", "")
		return
	}
	rev, err := s.state.GetRevision(r.Context(), id)
	if err != nil || rev == nil {
		writeAPIError(w, http.StatusNotFound, "Revision not found", "")
		return
	}
	raw, err := ops.ZstdDecompressBytes(rev.CompressedBody)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to decompress revision", err.Error())
		return
	}
	res, err := content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:   s.cfg.ContentDir,
		RelativePath: rev.Path,
		Data:         raw,
	})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Restore write failed", err.Error())
		return
	}
	_ = s.reloadContentStore(r.Context())
	if compressed, cErr := ops.ZstdCompressBytes(raw); cErr == nil {
		_, _ = s.state.CreateRevision(r.Context(), state.RevisionRecord{
			ID:             uuid.New(),
			ContentID:      state.ContentUUID(rev.Path),
			ContentType:    rev.ContentType,
			ContentSlug:    rev.ContentSlug,
			Path:           rev.Path,
			Checksum:       res.SHA256,
			CompressedBody: compressed,
			ActorID:        &p.User.ID,
			Note:           fmt.Sprintf("Restored from revision #%d", rev.RevisionNum),
			CreatedAt:      time.Now().UTC(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"checksum":    res.SHA256,
		"rawMarkdown": string(raw),
	})
}

func (s *Server) handleAdminListPreviews(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	ct := strings.TrimSpace(r.URL.Query().Get("type"))
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	items, err := s.state.ListDraftPreviews(r.Context(), ct, slug)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list previews", err.Error())
		return
	}
	if items == nil {
		items = []state.DraftPreviewRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminCreatePreview(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		Type       string `json:"type"`
		Slug       string `json:"slug"`
		Label      string `json:"label"`
		TTLHours   int    `json:"ttlHours"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ct, ok := parseContentTypeFilter(body.Type)
	if !ok || strings.TrimSpace(body.Slug) == "" {
		writeAPIError(w, http.StatusBadRequest, "Invalid type or slug", "")
		return
	}
	doc, found := s.store.GetAny(ct, body.Slug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}
	ttl := body.TTLHours
	if ttl <= 0 || ttl > 720 {
		ttl = 72
	}
	plainTok, tokHash, _, err := auth.GenerateRandomToken("ibr_prev_", 24)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to generate token", err.Error())
		return
	}
	rec := state.DraftPreviewRecord{
		ID:          uuid.New(),
		TokenHash:   tokHash,
		ContentType: string(doc.Type),
		ContentSlug: doc.Slug,
		Label:       strings.TrimSpace(body.Label),
		ExpiresAt:   time.Now().UTC().Add(time.Duration(ttl) * time.Hour),
		CreatedBy:   &p.User.ID,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.state.CreateDraftPreview(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to save preview link", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         rec.ID.String(),
		"token":      plainTok,
		"previewUrl": "/preview/" + plainTok,
		"expiresAt":  rec.ExpiresAt.UTC().Format(time.RFC3339),
		"label":      rec.Label,
	})
}

func (s *Server) handleAdminRevokePreview(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid preview ID", "")
		return
	}
	_ = s.state.RevokeDraftPreview(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListMedia(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListAssets(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list media", err.Error())
		return
	}
	if items == nil {
		items = []state.AssetRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminUploadMedia(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	r.Body = http.MaxBytesReader(w, r.Body, media.MaxUploadBytes+1024*1024)
	if err := r.ParseMultipartForm(media.MaxUploadBytes); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid multipart upload", err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Missing file field", err.Error())
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, media.MaxUploadBytes+1))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Read file failed", err.Error())
		return
	}
	processed, err := media.ProcessUpload(hdr.Filename, raw, time.Now().UTC())
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Unsupported upload", err.Error())
		return
	}
	publicURL, err := s.storage.Put(r.Context(), processed.StorageKey, processed.Data, processed.MimeType)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Storage upload failed", err.Error())
		return
	}

	altText := strings.TrimSpace(r.FormValue("altText"))
	asset := state.AssetRecord{
		ID:            uuid.New(),
		StorageDriver: s.storage.DriverName(),
		StorageKey:    processed.StorageKey,
		PublicURL:     publicURL,
		Filename:      processed.Filename,
		MimeType:      processed.MimeType,
		ByteSize:      processed.ByteSize,
		Width:         processed.Width,
		Height:        processed.Height,
		Thumbhash:     processed.Thumbhash,
		EXIFStripped:  processed.EXIFStripped,
		AltText:       altText,
		CreatedBy:     &p.User.ID,
		CreatedAt:     time.Now().UTC(),
	}
	if err := s.state.CreateAsset(r.Context(), asset); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Save asset record failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"asset": asset})
}

func (s *Server) handleAdminListOrphans(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	assets, err := s.state.ListAssets(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to scan assets", err.Error())
		return
	}
	minAgeHours := 24
	if q := r.URL.Query().Get("minAgeHours"); q != "" {
		if v, err := strconv.Atoi(q); err == nil && v >= 0 {
			minAgeHours = v
		}
	}
	orphans := media.FindOrphanAssets(assets, s.store.ListAll(), time.Duration(minAgeHours)*time.Hour)
	if orphans == nil {
		orphans = []state.AssetRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": orphans})
}

func (s *Server) handleAdminCleanOrphans(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	assets, _ := s.state.ListAssets(r.Context())
	orphans := media.FindOrphanAssets(assets, s.store.ListAll(), 24*time.Hour)
	deleted := 0
	for _, a := range orphans {
		_ = s.storage.Delete(r.Context(), a.StorageKey)
		if err := s.state.DeleteAsset(r.Context(), a.ID); err == nil {
			deleted++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (s *Server) handleAdminDeleteMedia(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid asset ID", "")
		return
	}
	asset, err := s.state.GetAssetByID(r.Context(), id)
	if err != nil || asset == nil {
		writeAPIError(w, http.StatusNotFound, "Asset not found", "")
		return
	}
	_ = s.storage.Delete(r.Context(), asset.StorageKey)
	_ = s.state.DeleteAsset(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListComments(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	items, err := s.state.ListComments(r.Context(), "", "", status)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list comments", err.Error())
		return
	}
	if items == nil {
		items = []state.CommentRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminModerateComment(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid comment ID", "")
		return
	}
	var body struct {
		Status string `json:"status"`
		Pinned *bool  `json:"pinned"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if body.Status != "" && body.Status != "pending" && body.Status != "approved" && body.Status != "spam" && body.Status != "deleted" {
		writeAPIError(w, http.StatusBadRequest, "Invalid comment status", "")
		return
	}
	if err := s.state.UpdateCommentStatus(r.Context(), id, body.Status, body.Pinned); err != nil {
		writeAPIError(w, http.StatusNotFound, "Comment not found", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminReplyComment(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	parentID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid comment ID", "")
		return
	}
	parent, err := s.state.GetCommentByID(r.Context(), parentID)
	if err != nil || parent == nil {
		writeAPIError(w, http.StatusNotFound, "Parent comment not found", "")
		return
	}
	var body struct {
		BodyMarkdown string `json:"bodyMarkdown"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	rendered, err := community.RenderCommentMarkdown(body.BodyMarkdown)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid reply body", err.Error())
		return
	}
	// Ensure parent is approved when author replies to it.
	if parent.Status == "pending" {
		_ = s.state.UpdateCommentStatus(r.Context(), parent.ID, "approved", nil)
	}

	reply := state.CommentRecord{
		ID:              uuid.New(),
		ContentType:     parent.ContentType,
		ContentSlug:     parent.ContentSlug,
		ParentID:        &parent.ID,
		AuthorName:      p.User.Name,
		AuthorEmailHash: community.EmailHash(p.User.Email),
		IsAdmin:         true,
		BodyMarkdown:    strings.TrimSpace(body.BodyMarkdown),
		BodyHTML:        rendered,
		Status:          "approved",
		CreatedAt:       time.Now().UTC(),
		UpdatedAt:       time.Now().UTC(),
	}
	if err := s.state.CreateComment(r.Context(), reply); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Save reply failed", err.Error())
		return
	}
	if doc, ok := s.store.GetPublished(content.ContentType(parent.ContentType), parent.ContentSlug); ok {
		s.notifyParentCommentReply(r.Context(), doc, parent, &reply)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "comment": reply})
}

func (s *Server) handleAdminDeleteComment(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid comment ID", "")
		return
	}
	_ = s.state.DeleteComment(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListFriends(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListFriendLinks(r.Context(), "")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list friends", err.Error())
		return
	}
	if items == nil {
		items = []state.FriendLinkRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminSaveFriend(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	var body struct {
		Name        string `json:"name"`
		URL         string `json:"url"`
		FeedURL     string `json:"feedUrl"`
		AvatarURL   string `json:"avatarUrl"`
		Description string `json:"description"`
		GroupName   string `json:"groupName"`
		Status      string `json:"status"`
		SortOrder   int    `json:"sortOrder"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.URL) == "" {
		writeAPIError(w, http.StatusBadRequest, "name and url are required", "")
		return
	}
	if body.Status == "" {
		body.Status = "active"
	}
	if body.GroupName == "" {
		body.GroupName = "Friends"
	}
	rec := state.FriendLinkRecord{
		ID:          uuid.New(),
		Name:        strings.TrimSpace(body.Name),
		URL:         strings.TrimSpace(body.URL),
		FeedURL:     strings.TrimSpace(body.FeedURL),
		AvatarURL:   strings.TrimSpace(body.AvatarURL),
		Description: strings.TrimSpace(body.Description),
		GroupName:   strings.TrimSpace(body.GroupName),
		Status:      body.Status,
		SortOrder:   body.SortOrder,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.state.CreateFriendLink(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusConflict, "Create friend failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "friend": rec})
}

func (s *Server) handleAdminUpdateFriend(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid friend ID", "")
		return
	}
	existing, err := s.state.GetFriendLink(r.Context(), id)
	if err != nil || existing == nil {
		writeAPIError(w, http.StatusNotFound, "Friend link not found", "")
		return
	}
	var body struct {
		Name        *string `json:"name"`
		URL         *string `json:"url"`
		FeedURL     *string `json:"feedUrl"`
		AvatarURL   *string `json:"avatarUrl"`
		Description *string `json:"description"`
		GroupName   *string `json:"groupName"`
		Status      *string `json:"status"`
		SortOrder   *int    `json:"sortOrder"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if body.Name != nil {
		existing.Name = strings.TrimSpace(*body.Name)
	}
	if body.URL != nil {
		existing.URL = strings.TrimSpace(*body.URL)
	}
	if body.FeedURL != nil {
		existing.FeedURL = strings.TrimSpace(*body.FeedURL)
	}
	if body.AvatarURL != nil {
		existing.AvatarURL = strings.TrimSpace(*body.AvatarURL)
	}
	if body.Description != nil {
		existing.Description = strings.TrimSpace(*body.Description)
	}
	if body.GroupName != nil {
		existing.GroupName = strings.TrimSpace(*body.GroupName)
	}
	if body.Status != nil {
		existing.Status = strings.TrimSpace(*body.Status)
	}
	if body.SortOrder != nil {
		existing.SortOrder = *body.SortOrder
	}
	if err := s.state.UpdateFriendLink(r.Context(), *existing); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Update friend failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "friend": existing})
}

func (s *Server) handleAdminDeleteFriend(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid friend ID", "")
		return
	}
	_ = s.state.DeleteFriendLink(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminPollFriends(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	checked, added := s.poller.PollAll(r.Context(), s.state)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checked": checked, "itemsUpdated": added})
}

func (s *Server) handleAdminListSubscribers(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListSubscribers(r.Context(), "")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list subscribers", err.Error())
		return
	}
	if items == nil {
		items = []state.SubscriberRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminDeleteSubscriber(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid subscriber ID", "")
		return
	}
	_ = s.state.DeleteSubscriber(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListCampaigns(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListNewsletters(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list newsletters", err.Error())
		return
	}
	if items == nil {
		items = []state.NewsletterRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminSendNewsletter(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	var body struct {
		Subject      string `json:"subject"`
		BodyMarkdown string `json:"bodyMarkdown"`
		ContentType  string `json:"contentType"`
		ContentSlug  string `json:"contentSlug"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	rec, err := distribution.SendNewsletterCampaign(r.Context(), s.state, s.mailer, s.cfg, body.Subject, body.BodyMarkdown, body.ContentType, body.ContentSlug)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Send newsletter failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "campaign": rec})
}

func (s *Server) handleAdminListRedirects(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListRedirects(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list redirects", err.Error())
		return
	}
	if items == nil {
		items = []state.RedirectRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminCreateRedirect(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	var body struct {
		SourcePath string `json:"sourcePath"`
		TargetPath string `json:"targetPath"`
		StatusCode int    `json:"statusCode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	existing, _ := s.state.ListRedirects(r.Context())
	if err := state.ValidateRedirectGraph(existing, body.SourcePath, body.TargetPath); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid redirect rule", err.Error())
		return
	}
	code := body.StatusCode
	switch code {
	case 301, 302, 307, 308:
	default:
		code = 301
	}
	rec := state.RedirectRecord{
		ID:         uuid.New(),
		SourcePath: strings.TrimSpace(body.SourcePath),
		TargetPath: strings.TrimSpace(body.TargetPath),
		StatusCode: code,
		CreatedAt:  time.Now().UTC(),
	}
	if err := s.state.CreateRedirect(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Save redirect failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "redirect": rec})
}

func (s *Server) handleAdminDeleteRedirect(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid redirect ID", "")
		return
	}
	_ = s.state.DeleteRedirect(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminGetSettings(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	raw, _ := s.state.GetAllSettings(r.Context())
	out := map[string]any{
		"site_name":            s.effectiveSiteName(r.Context()),
		"site_description":     s.effectiveSiteDesc(r.Context()),
		"feed_mode":            s.siteSettingString(r.Context(), "feed_mode", "full"),
		"comments_mode":        s.siteSettingString(r.Context(), "comments_mode", "builtin"),
		"comment_auto_approve": s.siteSettingBool(r.Context(), "comment_auto_approve", false),
		"giscus_repo":          s.siteSettingString(r.Context(), "giscus_repo", ""),
		"giscus_repo_id":       s.siteSettingString(r.Context(), "giscus_repo_id", ""),
		"giscus_category":      s.siteSettingString(r.Context(), "giscus_category", ""),
		"giscus_category_id":   s.siteSettingString(r.Context(), "giscus_category_id", ""),
	}
	for k, v := range raw {
		var parsed any
		if json.Unmarshal(v, &parsed) == nil {
			out[k] = parsed
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": out})
}

func (s *Server) handleAdminPutSettings(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body map[string]any
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	allowedKeys := map[string]bool{
		"site_name":            true,
		"site_description":     true,
		"feed_mode":            true,
		"comments_mode":        true,
		"comment_auto_approve": true,
		"giscus_repo":          true,
		"giscus_repo_id":       true,
		"giscus_category":      true,
		"giscus_category_id":   true,
	}
	for k, v := range body {
		if !allowedKeys[k] {
			continue
		}
		if k == "feed_mode" {
			if str, ok := v.(string); ok && str != "full" && str != "summary" {
				writeAPIError(w, http.StatusBadRequest, "Invalid feed_mode", "Must be full or summary.")
				return
			}
		}
		if k == "comments_mode" {
			if str, ok := v.(string); ok && str != "builtin" && str != "giscus" && str != "off" {
				writeAPIError(w, http.StatusBadRequest, "Invalid comments_mode", "Must be builtin, giscus, or off.")
				return
			}
		}
		b, _ := json.Marshal(v)
		_ = s.state.SetSetting(r.Context(), k, b)
	}
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "settings.update",
		IPHash:    s.auth.ClientIPHash(r),
	})
	s.handleAdminGetSettings(w, r, p)
}

func (s *Server) handleAdminListTokens(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	items, err := s.state.ListAPITokens(r.Context(), p.User.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list tokens", err.Error())
		return
	}
	if items == nil {
		items = []state.APITokenRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminCreateToken(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays int      `json:"expiresInDays"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeAPIError(w, http.StatusBadRequest, "Token name is required", "")
		return
	}
	if len(body.Scopes) == 0 {
		body.Scopes = []string{"content:read"}
	}
	plainTok, tokHash, prefix, err := auth.GenerateRandomToken("ibr_pat_", 24)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Generate token failed", err.Error())
		return
	}
	var exp *time.Time
	if body.ExpiresInDays > 0 {
		t := time.Now().UTC().AddDate(0, 0, body.ExpiresInDays)
		exp = &t
	}
	rec := state.APITokenRecord{
		ID:          uuid.New(),
		UserID:      p.User.ID,
		Name:        name,
		TokenPrefix: prefix,
		TokenHash:   tokHash,
		Scopes:      body.Scopes,
		ExpiresAt:   exp,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.state.CreateAPIToken(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Create token failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"token": plainTok,
		"item":  rec,
	})
}

func (s *Server) handleAdminRevokeToken(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid token ID", "")
		return
	}
	_ = s.state.RevokeAPIToken(r.Context(), p.User.ID, id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListWebhooks(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListWebhooks(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list webhooks", err.Error())
		return
	}
	if items == nil {
		items = []state.WebhookRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminSaveWebhook(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	var body struct {
		Name      string   `json:"name"`
		TargetURL string   `json:"targetUrl"`
		Secret    string   `json:"secret"`
		Events    []string `json:"events"`
		Enabled   *bool    `json:"enabled"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeAPIError(w, http.StatusBadRequest, "Webhook name is required", "")
		return
	}
	allowPriv := s.webhooks != nil && s.webhooks.AllowPrivateForTest
	if _, err := community.ValidatePublicURL(body.TargetURL, allowPriv); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid targetUrl", err.Error())
		return
	}
	secret := strings.TrimSpace(body.Secret)
	if secret == "" {
		gen, _, _, _ := auth.GenerateRandomToken("whsec_", 24)
		secret = gen
	}
	secretEnc, err := auth.EncryptBytes(s.cfg.EffectiveSecretKey(), []byte(secret))
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Encrypt secret failed", err.Error())
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	if len(body.Events) == 0 {
		body.Events = []string{"content.published"}
	}
	rec := state.WebhookRecord{
		ID:        uuid.New(),
		Name:      strings.TrimSpace(body.Name),
		TargetURL: strings.TrimSpace(body.TargetURL),
		SecretEnc: secretEnc,
		Events:    body.Events,
		Enabled:   enabled,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := s.state.CreateWebhook(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Save webhook failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "webhook": rec, "signingSecret": secret})
}

func (s *Server) handleAdminUpdateWebhook(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid webhook ID", "")
		return
	}
	hook, err := s.state.GetWebhook(r.Context(), id)
	if err != nil || hook == nil {
		writeAPIError(w, http.StatusNotFound, "Webhook not found", "")
		return
	}
	var body struct {
		Name      *string  `json:"name"`
		TargetURL *string  `json:"targetUrl"`
		Secret    *string  `json:"secret"`
		Events    []string `json:"events"`
		Enabled   *bool    `json:"enabled"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if body.Name != nil {
		hook.Name = strings.TrimSpace(*body.Name)
	}
	if body.TargetURL != nil {
		allowPriv := s.webhooks != nil && s.webhooks.AllowPrivateForTest
		if _, err := community.ValidatePublicURL(*body.TargetURL, allowPriv); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid targetUrl", err.Error())
			return
		}
		hook.TargetURL = strings.TrimSpace(*body.TargetURL)
	}
	if body.Secret != nil && strings.TrimSpace(*body.Secret) != "" {
		enc, err := auth.EncryptBytes(s.cfg.EffectiveSecretKey(), []byte(strings.TrimSpace(*body.Secret)))
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "Encrypt secret failed", err.Error())
			return
		}
		hook.SecretEnc = enc
	}
	if body.Events != nil {
		hook.Events = body.Events
	}
	if body.Enabled != nil {
		hook.Enabled = *body.Enabled
	}
	if err := s.state.UpdateWebhook(r.Context(), *hook); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Update webhook failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "webhook": hook})
}

func (s *Server) handleAdminDeleteWebhook(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid webhook ID", "")
		return
	}
	_ = s.state.DeleteWebhook(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminTestWebhook(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid webhook ID", "")
		return
	}
	hook, err := s.state.GetWebhook(r.Context(), id)
	if err != nil || hook == nil {
		writeAPIError(w, http.StatusNotFound, "Webhook not found", "")
		return
	}
	rec, err := s.webhooks.DeliverWebhook(r.Context(), *hook, "webhook.test", map[string]string{
		"message": "Hello from Inkbranch v2",
	}, 1)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "delivery": rec, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "delivery": rec})
}

func (s *Server) handleAdminWebhookDeliveries(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid webhook ID", "")
		return
	}
	items, err := s.state.ListWebhookDeliveries(r.Context(), &id, 50)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list deliveries", err.Error())
		return
	}
	if items == nil {
		items = []state.WebhookDeliveryRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminSecurityOverview(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	passkeys, _ := s.state.ListPasskeys(r.Context(), p.User.ID)
	sessions, _ := s.state.ListSessionsByUser(r.Context(), p.User.ID)
	totpRec, _ := s.state.GetTOTP(r.Context(), p.User.ID)
	if passkeys == nil {
		passkeys = []state.PasskeyRecord{}
	}
	if sessions == nil {
		sessions = []state.Session{}
	}
	currentSessID := ""
	if p.Session != nil {
		currentSessID = p.Session.ID.String()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"totpEnabled":            totpRec != nil && totpRec.Enabled,
		"recoveryCodesRemaining": func() int { if totpRec != nil { return len(totpRec.RecoveryCodeHashes) }; return 0 }(),
		"passkeys":               passkeys,
		"sessions":               sessions,
		"currentSessionId":       currentSessID,
	})
}

func (s *Server) handleAdminChangePassword(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ok, err := auth.VerifyPassword(body.CurrentPassword, p.User.PasswordHash)
	if err != nil || !ok {
		writeAPIError(w, http.StatusUnauthorized, "Current password is incorrect", "")
		return
	}
	newHash, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid new password", err.Error())
		return
	}
	if err := s.state.UpdateUserPassword(r.Context(), p.User.ID, newHash); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to update password", err.Error())
		return
	}
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "security.password.changed",
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminSetupTOTP(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	secret, otpURL, codes, err := s.auth.SetupTOTP(r.Context(), p.User)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to initialize TOTP", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":        secret,
		"otpauthUrl":    otpURL,
		"recoveryCodes": codes,
	})
}

func (s *Server) handleAdminVerifyTOTP(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		Code string `json:"code"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	if err := s.auth.EnableTOTP(r.Context(), p.User.ID, body.Code); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid verification code", err.Error())
		return
	}
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "security.totp.enabled",
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminDisableTOTP(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	_ = s.auth.DisableTOTP(r.Context(), p.User.ID)
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "security.totp.disabled",
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminPasskeyBegin(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	var body struct {
		Label string `json:"label"`
	}
	_ = decodeJSON(r, &body)
	cid, options, err := s.auth.BeginPasskeyRegistration(r.Context(), p.User, body.Label, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Failed to start passkey registration", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ceremonyId": cid,
		"options":    options,
	})
}

func (s *Server) handleAdminPasskeyFinish(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	cid := strings.TrimSpace(r.URL.Query().Get("ceremonyId"))
	if cid == "" {
		cid = strings.TrimSpace(r.Header.Get("X-WebAuthn-Ceremony"))
	}
	if cid == "" {
		writeAPIError(w, http.StatusBadRequest, "ceremonyId is required", "")
		return
	}
	rec, err := s.auth.FinishPasskeyRegistration(r.Context(), p.User, cid, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Passkey registration failed", err.Error())
		return
	}
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "security.passkey.added",
		TargetID:  rec.ID.String(),
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "passkey": rec})
}

func (s *Server) handleAdminPasskeyDelete(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid passkey ID", "")
		return
	}
	_ = s.state.DeletePasskey(r.Context(), p.User.ID, id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminRevokeSession(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid session ID", "")
		return
	}
	sessions, _ := s.state.ListSessionsByUser(r.Context(), p.User.ID)
	for _, sess := range sessions {
		if sess.ID == id {
			_ = s.state.DeleteSession(r.Context(), id)
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAdminListBackups(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	items, err := s.state.ListBackups(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to list backups", err.Error())
		return
	}
	if items == nil {
		items = []state.BackupRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleAdminCreateBackup(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	rec, _, err := ops.CreateBackup(r.Context(), s.cfg, s.state, s.storage, &p.User.ID, "inkbranch-backup")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Create backup failed", err.Error())
		return
	}
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "ops.backup.create",
		TargetID:  rec.ID.String(),
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "backup": rec})
}

func (s *Server) handleAdminDownloadBackup(w http.ResponseWriter, r *http.Request, _ *auth.Principal) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid backup ID", "")
		return
	}
	rec, err := s.state.GetBackupByID(r.Context(), id)
	if err != nil || rec == nil {
		writeAPIError(w, http.StatusNotFound, "Backup not found", "")
		return
	}
	localPath := filepath.Join(s.cfg.BackupsDir, filepath.Base(rec.Filename))
	data, err := os.ReadFile(localPath)
	if err != nil && rec.StorageDriver == "r2" && s.storage != nil {
		data, err = s.storage.Get(r.Context(), rec.StorageKey)
	}
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "Backup archive unavailable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/zstd")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(rec.Filename)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleAdminRestoreBackup(w http.ResponseWriter, r *http.Request, p *auth.Principal) {
	r.Body = http.MaxBytesReader(w, r.Body, 512<<20)
	var archiveReader io.Reader
	var closer io.Closer

	ctHeader := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(ctHeader, "multipart/form-data") {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid multipart backup upload", err.Error())
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "Missing backup file", err.Error())
			return
		}
		archiveReader = file
		closer = file
	} else {
		var body struct {
			BackupID string `json:"backupId"`
		}
		if err := decodeJSON(r, &body); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
			return
		}
		id, err := uuid.Parse(strings.TrimSpace(body.BackupID))
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid backupId", "")
			return
		}
		rec, err := s.state.GetBackupByID(r.Context(), id)
		if err != nil || rec == nil {
			writeAPIError(w, http.StatusNotFound, "Backup not found", "")
			return
		}
		localPath := filepath.Join(s.cfg.BackupsDir, filepath.Base(rec.Filename))
		data, err := os.ReadFile(localPath)
		if err != nil && rec.StorageDriver == "r2" && s.storage != nil {
			data, err = s.storage.Get(r.Context(), rec.StorageKey)
		}
		if err != nil {
			writeAPIError(w, http.StatusNotFound, "Backup archive unavailable", err.Error())
			return
		}
		archiveReader = bytes.NewReader(data)
	}
	if closer != nil {
		defer closer.Close()
	}

	rollback, err := ops.RestoreBackup(r.Context(), s.cfg, s.state, s.storage, archiveReader)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Restore backup failed", err.Error())
		return
	}
	_ = s.reloadContentStore(r.Context())
	_ = s.state.AppendAuditLog(r.Context(), state.AuditLogRecord{
		ActorType: "user",
		ActorID:   &p.User.ID,
		Action:    "ops.backup.restore",
		TargetID:  rollback.ID.String(),
		IPHash:    s.auth.ClientIPHash(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rollbackBackup": rollback})
}
