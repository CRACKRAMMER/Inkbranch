package server

import (
	"context"
	"encoding/json"
	"fmt"
	stdhtml "html"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/analytics"
	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (s *Server) registerPublicV2Routes() {
	s.registerPublicAuthRoutes()
	s.router.Get("/api/v1/reactions", s.handleGetReactions)
	s.router.Post("/api/v1/reactions", s.handleToggleReaction)

	s.router.Get("/api/v1/comments", s.handleGetComments)
	s.router.Post("/api/v1/comments", s.handleCreateComment)

	s.router.Get("/api/v1/friends", s.handleGetFriends)
	s.router.Post("/api/v1/friends/apply", s.handleApplyFriend)

	s.router.Post("/api/v1/newsletter/subscribe", s.handleNewsletterSubscribe)
	s.router.Get("/api/v1/newsletter/confirm", s.handleNewsletterConfirm)
	s.router.Get("/api/v1/newsletter/unsubscribe", s.handleNewsletterUnsubscribe)
	s.router.Post("/api/v1/newsletter/unsubscribe", s.handleNewsletterUnsubscribe)

	s.router.Get("/api/v1/preview/{token}", s.handleGetDraftPreview)
	s.router.Post("/api/v1/analytics/collect", s.handleAnalyticsCollect)
}

func (s *Server) handleGetReactions(w http.ResponseWriter, r *http.Request) {
	ct, ok := parseContentTypeFilter(r.URL.Query().Get("type"))
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	if !ok || slug == "" {
		writeAPIError(w, http.StatusBadRequest, "Invalid parameters", "type and slug are required")
		return
	}
	voterHash := s.auth.ClientIPHash(r)
	counts, err := s.state.GetReactionCounts(r.Context(), string(ct), slug, voterHash, community.AllowedReactions)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to load reactions", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts})
}

func (s *Server) handleToggleReaction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type  string `json:"type"`
		Slug  string `json:"slug"`
		Emoji string `json:"emoji"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ct, ok := parseContentTypeFilter(body.Type)
	if !ok || strings.TrimSpace(body.Slug) == "" {
		writeAPIError(w, http.StatusBadRequest, "Invalid target document", "")
		return
	}
	doc, found := s.store.GetPublished(ct, body.Slug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}
	if !community.IsAllowedReaction(body.Emoji) {
		writeAPIError(w, http.StatusBadRequest, "Unsupported reaction emoji", "")
		return
	}
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("reaction", ipHash, 30, time.Minute) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many reactions", "Please wait a moment before reacting again.")
		return
	}
	if _, err := s.state.ToggleReaction(r.Context(), string(doc.Type), doc.Slug, body.Emoji, ipHash); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to toggle reaction", err.Error())
		return
	}
	counts, err := s.state.GetReactionCounts(r.Context(), string(doc.Type), doc.Slug, ipHash, community.AllowedReactions)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to reload reactions", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts})
}

func (s *Server) handleGetComments(w http.ResponseWriter, r *http.Request) {
	ct, ok := parseContentTypeFilter(r.URL.Query().Get("type"))
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	if !ok || slug == "" {
		writeAPIError(w, http.StatusBadRequest, "Invalid parameters", "type and slug are required")
		return
	}

	mode := strings.ToLower(s.siteSettingString(r.Context(), "comments_mode", "builtin"))
	if mode != "builtin" && mode != "giscus" && mode != "off" {
		mode = "builtin"
	}

	commentsEnabled := true
	if doc, found := s.store.GetPublished(ct, slug); found {
		commentsEnabled = doc.Comments
		slug = doc.Slug
	} else {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}

	var items []community.CommentNode
	if mode == "builtin" && commentsEnabled {
		rows, err := s.state.ListComments(r.Context(), string(ct), slug, "approved")
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "Failed to load comments", err.Error())
			return
		}
		items = community.BuildCommentTree(rows)
	}
	if items == nil {
		items = []community.CommentNode{}
	}

	var giscusCfg map[string]string
	if mode == "giscus" {
		giscusCfg = map[string]string{
			"repo":       s.siteSettingString(r.Context(), "giscus_repo", ""),
			"repoId":     s.siteSettingString(r.Context(), "giscus_repo_id", ""),
			"category":   s.siteSettingString(r.Context(), "giscus_category", ""),
			"categoryId": s.siteSettingString(r.Context(), "giscus_category_id", ""),
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"mode":             mode,
		"commentsEnabled":  commentsEnabled,
		"turnstileSiteKey": s.cfg.TurnstileSiteKey,
		"giscus":           giscusCfg,
		"items":            items,
	})
}

func (s *Server) handleCreateComment(w http.ResponseWriter, r *http.Request) {
	var reader *auth.ReaderSession
	if s.cfg.UsesCitadel() {
		if !s.auth.VerifyPublicOrigin(r) {
			writeAPIError(w, http.StatusForbidden, "CSRF verification failed", "Missing or invalid Origin header.")
			return
		}
		var err error
		reader, err = s.auth.AuthenticateOrRefreshReader(w, r)
		if err != nil || reader == nil {
			writeAPIError(w, http.StatusUnauthorized, "Authentication required", "请先使用 Citadel 账号登录后再发表评论。")
			return
		}
		if cit := s.auth.Citadel(); cit != nil {
			if intro, ierr := cit.IntrospectToken(r.Context(), reader.AccessToken); ierr == nil && intro != nil {
				if !intro.Active || (!intro.AllowLogin && !strings.EqualFold(intro.User.GlobalRole, "super_admin")) {
					s.auth.ClearReaderSessionCookie(w, r)
					writeAPIError(w, http.StatusUnauthorized, "Authentication required", "Citadel 会话已失效，请重新登录。")
					return
				}
			}
		}
	}

	var body struct {
		Type           string `json:"type"`
		Slug           string `json:"slug"`
		ParentID       string `json:"parentId"`
		AuthorName     string `json:"authorName"`
		AuthorEmail    string `json:"authorEmail"`
		AuthorURL      string `json:"authorUrl"`
		BodyMarkdown   string `json:"bodyMarkdown"`
		NotifyOnReply  bool   `json:"notifyOnReply"`
		TurnstileToken string `json:"turnstileToken"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}

	mode := strings.ToLower(s.siteSettingString(r.Context(), "comments_mode", "builtin"))
	if mode != "builtin" {
		writeAPIError(w, http.StatusForbidden, "Comments disabled", "Built-in comments are not active.")
		return
	}

	ct, ok := parseContentTypeFilter(body.Type)
	if !ok || strings.TrimSpace(body.Slug) == "" {
		writeAPIError(w, http.StatusBadRequest, "Invalid target document", "")
		return
	}
	doc, found := s.store.GetPublished(ct, body.Slug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Document not found", "")
		return
	}
	if !doc.Comments {
		writeAPIError(w, http.StatusForbidden, "Comments closed", "Comments are disabled for this post.")
		return
	}

	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("comment", ipHash, 8, 10*time.Minute) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many comments", "Please wait a few minutes before commenting again.")
		return
	}
	if s.turnstile != nil && s.turnstile.Enabled() {
		if err := s.turnstile.Verify(r.Context(), body.TurnstileToken, r.RemoteAddr); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Human verification failed", err.Error())
			return
		}
	}

	var name string
	var parsedMail *mail.Address
	var isAdmin bool
	if reader != nil {
		rawEmail := strings.TrimSpace(reader.Email)
		parsed, perr := mail.ParseAddress(rawEmail)
		if perr != nil || parsed.Address == "" || len(parsed.Address) > 254 {
			writeAPIError(w, http.StatusUnauthorized, "Invalid user profile", "Authenticated Citadel account lacks a valid email address.")
			return
		}
		parsedMail = parsed
		name = strings.TrimSpace(reader.Name)
		if name == "" {
			if localPart, _, ok := strings.Cut(parsed.Address, "@"); ok && strings.TrimSpace(localPart) != "" {
				name = strings.TrimSpace(localPart)
			} else {
				name = "Reader"
			}
		}
		isAdmin = strings.EqualFold(reader.GlobalRole, "super_admin") ||
			reader.AllowAdmin ||
			strings.EqualFold(reader.AppRole, "admin") ||
			strings.EqualFold(reader.AppRole, "editor")
		if uid, uerr := uuid.Parse(strings.TrimSpace(reader.UserID)); uerr == nil {
			syncRole := "reader"
			if isAdmin {
				if strings.EqualFold(reader.GlobalRole, "super_admin") {
					syncRole = "admin"
				} else if strings.TrimSpace(reader.AppRole) != "" {
					syncRole = strings.ToLower(strings.TrimSpace(reader.AppRole))
				}
			}
			_, _ = s.state.EnsureCitadelUser(r.Context(), uid, parsed.Address, name, reader.AvatarURL, syncRole)
		}
	} else {
		name = strings.TrimSpace(body.AuthorName)
		if len([]rune(name)) == 0 || len([]rune(name)) > 80 {
			writeAPIError(w, http.StatusBadRequest, "Invalid authorName", "Name must be 1 to 80 characters.")
			return
		}
		parsed, err := mail.ParseAddress(strings.TrimSpace(body.AuthorEmail))
		if err != nil || parsed.Address == "" || len(parsed.Address) > 254 {
			writeAPIError(w, http.StatusBadRequest, "Invalid email address", "")
			return
		}
		parsedMail = parsed
	}
	authorURL, err := community.ValidateOptionalURL(body.AuthorURL)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid website URL", err.Error())
		return
	}

	var parentUUID *uuid.UUID
	var parentRec *state.CommentRecord
	if strings.TrimSpace(body.ParentID) != "" {
		pid, err := uuid.Parse(strings.TrimSpace(body.ParentID))
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid parentId", "")
			return
		}
		parentRec, err = s.state.GetCommentByID(r.Context(), pid)
		if err != nil || parentRec == nil || parentRec.ContentType != string(doc.Type) || parentRec.ContentSlug != doc.Slug {
			writeAPIError(w, http.StatusBadRequest, "Parent comment not found", "")
			return
		}
		parentUUID = &pid
	}

	renderedHTML, err := community.RenderCommentMarkdown(body.BodyMarkdown)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid comment body", err.Error())
		return
	}

	var notifyEnc []byte
	if body.NotifyOnReply {
		notifyEnc, _ = auth.EncryptBytes(s.cfg.EffectiveSecretKey(), []byte(strings.ToLower(strings.TrimSpace(parsedMail.Address))))
	}

	status := "pending"
	msg := "评论已提交，审核通过后将显示。"
	if isAdmin || s.siteSettingBool(r.Context(), "comment_auto_approve", false) {
		status = "approved"
		msg = "评论已发布。"
	}

	rec := state.CommentRecord{
		ID:              uuid.New(),
		ContentType:     string(doc.Type),
		ContentSlug:     doc.Slug,
		ParentID:        parentUUID,
		AuthorName:      name,
		AuthorEmailHash: community.EmailHash(parsedMail.Address),
		AuthorURL:       authorURL,
		IsAdmin:         isAdmin,
		BodyMarkdown:    strings.TrimSpace(body.BodyMarkdown),
		BodyHTML:        renderedHTML,
		Status:          status,
		NotifyReply:     body.NotifyOnReply,
		NotifyEmailEnc:  notifyEnc,
		IPHash:          ipHash,
		CreatedAt:       time.Now().UTC(),
		UpdatedAt:       time.Now().UTC(),
	}
	if err := s.state.CreateComment(r.Context(), rec); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to save comment", err.Error())
		return
	}

	if status == "approved" && parentRec != nil {
		s.notifyParentCommentReply(r.Context(), doc, parentRec, &rec)
	}
	if s.webhooks != nil {
		s.webhooks.Dispatch(r.Context(), "comment.created", map[string]any{
			"id":          rec.ID.String(),
			"contentType": rec.ContentType,
			"contentSlug": rec.ContentSlug,
			"authorName":  rec.AuthorName,
			"status":      rec.Status,
		})
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"status":  status,
		"message": msg,
	})
}

func (s *Server) notifyParentCommentReply(ctx context.Context, doc *content.Document, parent, reply *state.CommentRecord) {
	if s.mailer == nil || !s.mailer.Configured() || parent == nil || !parent.NotifyReply || len(parent.NotifyEmailEnc) == 0 {
		return
	}
	emailBytes, err := auth.DecryptBytes(s.cfg.EffectiveSecretKey(), parent.NotifyEmailEnc)
	if err != nil || len(emailBytes) == 0 {
		return
	}
	postURL := s.cfg.SiteURL + doc.CanonicalURL() + "#comments"
	_ = s.mailer.Send(ctx, distribution.EmailMessage{
		To:      string(emailBytes),
		Subject: fmt.Sprintf("[%s] %s 回复了你的评论", s.effectiveSiteName(ctx), reply.AuthorName),
		HTMLBody: fmt.Sprintf(`<p><strong>%s</strong> 在《<a href="%s">%s</a>》回复了你的评论：</p><blockquote>%s</blockquote><p><a href="%s">查看上下文</a></p>`,
			stdhtml.EscapeString(reply.AuthorName),
			stdhtml.EscapeString(postURL),
			stdhtml.EscapeString(doc.Title),
			reply.BodyHTML,
			stdhtml.EscapeString(postURL),
		),
		TextBody: fmt.Sprintf("%s 在《%s》回复了你的评论：\n\n%s\n\n查看：%s\n", reply.AuthorName, doc.Title, reply.BodyMarkdown, postURL),
	})
}

func (s *Server) handleGetFriends(w http.ResponseWriter, r *http.Request) {
	allLinks, err := s.state.ListFriendLinks(r.Context(), "")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to load friends", err.Error())
		return
	}
	type friendLinkDTO struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		URL           string `json:"url"`
		FeedURL       string `json:"feedUrl,omitempty"`
		AvatarURL     string `json:"avatarUrl,omitempty"`
		Description   string `json:"description"`
		Category      string `json:"category,omitempty"`
		HealthStatus  string `json:"healthStatus,omitempty"`
		LastCheckedAt string `json:"lastCheckedAt,omitempty"`
	}
	links := make([]friendLinkDTO, 0)
	for _, fl := range allLinks {
		if fl.Status != "active" && fl.Status != "unreachable" {
			continue
		}
		health := "unknown"
		if fl.Status == "active" {
			health = "healthy"
		} else if fl.Status == "unreachable" {
			health = "degraded"
		}
		checkedAt := ""
		if fl.LastCheckedAt != nil {
			checkedAt = fl.LastCheckedAt.UTC().Format(time.RFC3339)
		}
		links = append(links, friendLinkDTO{
			ID:            fl.ID.String(),
			Name:          fl.Name,
			URL:           fl.URL,
			FeedURL:       fl.FeedURL,
			AvatarURL:     fl.AvatarURL,
			Description:   fl.Description,
			Category:      fl.GroupName,
			HealthStatus:  health,
			LastCheckedAt: checkedAt,
		})
	}

	rawFeeds, err := s.state.ListFriendFeedItems(r.Context(), 30)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to load friend feeds", err.Error())
		return
	}
	type friendFeedDTO struct {
		ID           string `json:"id"`
		FriendName   string `json:"friendName"`
		FriendURL    string `json:"friendUrl"`
		FriendAvatar string `json:"friendAvatar,omitempty"`
		Title        string `json:"title"`
		URL          string `json:"url"`
		Summary      string `json:"summary,omitempty"`
		PublishedAt  string `json:"publishedAt"`
	}
	feeds := make([]friendFeedDTO, 0, len(rawFeeds))
	for _, it := range rawFeeds {
		feeds = append(feeds, friendFeedDTO{
			ID:           it.ID.String(),
			FriendName:   it.FriendName,
			FriendURL:    it.FriendURL,
			FriendAvatar: it.FriendAvatar,
			Title:        it.Title,
			URL:          it.Link,
			Summary:      it.Summary,
			PublishedAt:  it.PublishedAt.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"links": links,
		"feeds": feeds,
	})
}

func (s *Server) handleApplyFriend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name           string `json:"name"`
		URL            string `json:"url"`
		FeedURL        string `json:"feedUrl"`
		AvatarURL      string `json:"avatarUrl"`
		Description    string `json:"description"`
		ContactEmail   string `json:"contactEmail"`
		TurnstileToken string `json:"turnstileToken"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("friend_apply", ipHash, 3, time.Hour) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many applications", "Please try again later.")
		return
	}
	if s.turnstile != nil && s.turnstile.Enabled() {
		if err := s.turnstile.Verify(r.Context(), body.TurnstileToken, r.RemoteAddr); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Human verification failed", err.Error())
			return
		}
	}

	name := strings.TrimSpace(body.Name)
	desc := strings.TrimSpace(body.Description)
	if name == "" || len([]rune(name)) > 64 || desc == "" || len([]rune(desc)) > 200 {
		writeAPIError(w, http.StatusBadRequest, "Invalid name or description", "")
		return
	}
	allowPriv := s.poller != nil && s.poller.AllowPrivateForTest
	siteURL, err := community.ValidatePublicURL(body.URL, allowPriv)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid site URL", err.Error())
		return
	}
	var feedURLStr, avatarURLStr string
	if strings.TrimSpace(body.FeedURL) != "" {
		fu, err := community.ValidatePublicURL(body.FeedURL, allowPriv)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid feedUrl", err.Error())
			return
		}
		feedURLStr = fu.String()
	}
	if strings.TrimSpace(body.AvatarURL) != "" {
		au, err := community.ValidateOptionalURL(body.AvatarURL)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "Invalid avatarUrl", err.Error())
			return
		}
		avatarURLStr = au
	}

	existing, _ := s.state.GetFriendLinkByURL(r.Context(), siteURL.String())
	if existing != nil {
		writeAPIError(w, http.StatusConflict, "Already submitted", "该站点已在友链列表或等待审核中。")
		return
	}

	if err := s.state.CreateFriendLink(r.Context(), state.FriendLinkRecord{
		ID:          uuid.New(),
		Name:        name,
		URL:         siteURL.String(),
		FeedURL:     feedURLStr,
		AvatarURL:   avatarURLStr,
		Description: desc,
		GroupName:   "Friends",
		Status:      "pending",
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to save application", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"message": "友链申请已提交，等待站长审核。",
	})
}

func (s *Server) handleNewsletterSubscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email          string `json:"email"`
		Lang           string `json:"lang"`
		TurnstileToken string `json:"turnstileToken"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("newsletter_sub", ipHash, 5, 10*time.Minute) {
		writeAPIError(w, http.StatusTooManyRequests, "Too many requests", "Please wait a few minutes before trying again.")
		return
	}
	if s.turnstile != nil && s.turnstile.Enabled() {
		if err := s.turnstile.Verify(r.Context(), body.TurnstileToken, r.RemoteAddr); err != nil {
			writeAPIError(w, http.StatusBadRequest, "Human verification failed", err.Error())
			return
		}
	}

	res, err := distribution.Subscribe(r.Context(), s.state, s.mailer, s.cfg, body.Email)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "Subscription failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"status":  res.Status,
		"message": res.Message,
	})
}

func (s *Server) handleNewsletterConfirm(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	sub, err := distribution.ConfirmSubscription(r.Context(), s.state, tok)
	if err != nil {
		if wantsJSON(r) {
			writeAPIError(w, http.StatusBadRequest, "Confirmation failed", err.Error())
			return
		}
		http.Error(w, "Invalid or expired confirmation link.", http.StatusBadRequest)
		return
	}
	if wantsJSON(r) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": sub.Status})
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Subscription Confirmed — %s</title><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:1.5rem"><h1>订阅已确认</h1><p>邮箱 %s 已成功订阅 %s 更新。</p><p><a href="/">返回首页</a></p></body>`,
		stdhtml.EscapeString(s.effectiveSiteName(r.Context())),
		stdhtml.EscapeString(sub.Email),
		stdhtml.EscapeString(s.effectiveSiteName(r.Context())),
	)
}

func (s *Server) handleNewsletterUnsubscribe(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimSpace(r.URL.Query().Get("token"))
	if tok == "" && r.Method == http.MethodPost {
		var body struct {
			Token string `json:"token"`
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
		if len(raw) > 0 && raw[0] == '{' {
			_ = json.Unmarshal(raw, &body)
			tok = strings.TrimSpace(body.Token)
		} else if len(raw) > 0 {
			if vals, err := url.ParseQuery(string(raw)); err == nil {
				tok = strings.TrimSpace(vals.Get("token"))
			}
		}
	}
	sub, err := distribution.UnsubscribeByToken(r.Context(), s.state, tok)
	if err != nil {
		if wantsJSON(r) {
			writeAPIError(w, http.StatusBadRequest, "Unsubscribe failed", err.Error())
			return
		}
		http.Error(w, "Invalid unsubscribe link.", http.StatusBadRequest)
		return
	}
	if wantsJSON(r) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": sub.Status})
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Unsubscribed — %s</title><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:1.5rem"><h1>已退订</h1><p>邮箱 %s 已停止接收邮件推送。</p><p><a href="/">返回首页</a></p></body>`,
		stdhtml.EscapeString(s.effectiveSiteName(r.Context())),
		stdhtml.EscapeString(sub.Email),
	)
}

func (s *Server) handleGetDraftPreview(w http.ResponseWriter, r *http.Request) {
	rawToken := strings.TrimSpace(chi.URLParam(r, "token"))
	if rawToken == "" {
		writeAPIError(w, http.StatusNotFound, "Preview not found", "")
		return
	}
	rec, err := s.state.GetDraftPreviewByTokenHash(r.Context(), auth.HashToken(rawToken))
	if err != nil || rec == nil || rec.RevokedAt != nil || time.Now().UTC().After(rec.ExpiresAt) {
		writeAPIError(w, http.StatusNotFound, "Preview link invalid or expired", "")
		return
	}
	doc, found := s.store.GetAny(content.ContentType(rec.ContentType), rec.ContentSlug)
	if !found {
		writeAPIError(w, http.StatusNotFound, "Draft document no longer exists", "")
		return
	}
	detail := s.buildDocumentDetailPayload(doc)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	writeJSON(w, http.StatusOK, map[string]any{
		"expiresAt": rec.ExpiresAt.UTC().Format(time.RFC3339),
		"document":  detail.Document,
		"context":   detail.Context,
	})
}

func (s *Server) handleAnalyticsCollect(w http.ResponseWriter, r *http.Request) {
	ipHash := s.auth.ClientIPHash(r)
	if !s.auth.AllowRate("analytics", ipHash, 120, time.Minute) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var payload analytics.CollectPayload
	if err := decodeJSON(r, &payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "Invalid beacon payload", err.Error())
		return
	}
	if payload.EventType != "pageview" && payload.EventType != "read_depth" {
		writeAPIError(w, http.StatusBadRequest, "Unsupported eventType", "")
		return
	}
	_ = analytics.Collect(r.Context(), s.state, s.auth.SecretKey(), r, payload)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeAPIError(w http.ResponseWriter, status int, title, detail string) {
	writeJSON(w, status, map[string]any{
		"title":  title,
		"status": status,
		"detail": detail,
	})
}

func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 4<<20))
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func wantsJSON(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/json")
}
