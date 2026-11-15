package server

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/citadel"
	"github.com/google/uuid"
)

func (s *Server) registerPublicAuthRoutes() {
	s.router.Get("/api/v1/public/auth/login", s.handlePublicAuthLogin)
	s.router.Get("/api/v1/public/auth/callback", s.handlePublicAuthCallback)
	s.router.Get("/api/v1/public/auth/me", s.handlePublicAuthMe)
	s.router.Post("/api/v1/public/auth/logout", s.handlePublicAuthLogout)
}

func (s *Server) handlePublicAuthLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	cit := s.auth.Citadel()
	if !s.cfg.UsesCitadel() || cit == nil || strings.TrimSpace(s.cfg.CitadelPublicURL) == "" {
		writeAPIError(w, http.StatusNotFound, "SSO unavailable", "Public reader SSO requires Citadel mode.")
		return
	}

	stateTok, err := auth.RandomURLToken(24)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to generate OAuth state", err.Error())
		return
	}
	verifier, err := auth.RandomURLToken(48)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to generate PKCE verifier", err.Error())
		return
	}

	returnTo := auth.SanitizeReturnURL(r.URL.Query().Get("rd"))
	if err := s.auth.SetPKCECookie(w, r, auth.PKCEState{
		State:     stateTok,
		Verifier:  verifier,
		ReturnTo:  returnTo,
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to persist PKCE state", err.Error())
		return
	}

	callbackURI := strings.TrimRight(s.cfg.SiteURL, "/") + "/api/v1/public/auth/callback"
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", cit.OAuthClientID())
	q.Set("redirect_uri", callbackURI)
	q.Set("scope", "profile email")
	q.Set("state", stateTok)
	q.Set("code_challenge", auth.ComputePKCES256(verifier))
	q.Set("code_challenge_method", "S256")

	authorizeURL := strings.TrimRight(s.cfg.CitadelPublicURL, "/") + "/oauth/authorize?" + q.Encode()
	http.Redirect(w, r, authorizeURL, http.StatusFound)
}

func (s *Server) handlePublicAuthCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	cit := s.auth.Citadel()
	if !s.cfg.UsesCitadel() || cit == nil {
		writeAPIError(w, http.StatusNotFound, "SSO unavailable", "")
		return
	}

	if errCode := strings.TrimSpace(r.URL.Query().Get("error")); errCode != "" {
		s.auth.ClearPKCECookie(w, r)
		desc := strings.TrimSpace(r.URL.Query().Get("error_description"))
		if desc == "" {
			desc = errCode
		}
		writeAPIError(w, http.StatusForbidden, "Authorization failed", desc)
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	stateParam := strings.TrimSpace(r.URL.Query().Get("state"))
	pkce, err := s.auth.ReadPKCECookie(r)
	s.auth.ClearPKCECookie(w, r)
	if err != nil || pkce == nil || code == "" || stateParam == "" ||
		subtle.ConstantTimeCompare([]byte(pkce.State), []byte(stateParam)) != 1 {
		writeAPIError(w, http.StatusBadRequest, "Invalid OAuth state", "Missing or mismatched PKCE state cookie.")
		return
	}

	callbackURI := strings.TrimRight(s.cfg.SiteURL, "/") + "/api/v1/public/auth/callback"
	tokResp, err := cit.ExchangeOAuthCode(r.Context(), code, callbackURI, pkce.Verifier)
	if err != nil {
		status := http.StatusBadGateway
		var apiErr *citadel.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 400 && apiErr.StatusCode < 500 {
			status = http.StatusUnauthorized
		}
		writeAPIError(w, status, "OAuth token exchange failed", err.Error())
		return
	}

	if uid, perr := uuid.Parse(strings.TrimSpace(tokResp.User.ID)); perr == nil && strings.TrimSpace(tokResp.User.Email) != "" {
		localRole := "reader"
		if strings.EqualFold(tokResp.User.GlobalRole, "super_admin") {
			localRole = "admin"
		} else if tokResp.AppGrant != nil && tokResp.AppGrant.AllowAdmin && strings.TrimSpace(tokResp.AppGrant.AppRole) != "" {
			localRole = strings.ToLower(strings.TrimSpace(tokResp.AppGrant.AppRole))
		}
		_, _ = s.state.EnsureCitadelUser(
			r.Context(),
			uid,
			tokResp.User.Email,
			tokResp.User.Name,
			tokResp.User.AvatarURL,
			localRole,
		)
	}

	sess := auth.ReaderSessionFromOAuthToken(tokResp)
	if err := s.auth.SetReaderSessionCookie(w, r, sess); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "Failed to persist reader session", err.Error())
		return
	}

	http.Redirect(w, r, pkce.ReturnTo, http.StatusFound)
}

func (s *Server) handlePublicAuthMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	studioURL := "/admin"
	if s.cfg.UsesCitadel() && strings.TrimSpace(s.cfg.CitadelPublicURL) != "" {
		studioURL = strings.TrimRight(s.cfg.CitadelPublicURL, "/") + "/blog/"
	}

	resp := map[string]any{
		"authMode":         s.cfg.AuthMode,
		"usesCitadel":      s.cfg.UsesCitadel(),
		"citadelPublicUrl": s.cfg.CitadelPublicURL,
		"studioUrl":        studioURL,
		"authenticated":    false,
	}
	if !s.cfg.UsesCitadel() {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	sess, err := s.auth.AuthenticateOrRefreshReader(w, r)
	if err != nil || sess == nil {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	resp["authenticated"] = true
	resp["user"] = map[string]any{
		"id":         sess.UserID,
		"email":      sess.Email,
		"name":       sess.Name,
		"avatarUrl":  sess.AvatarURL,
		"globalRole": sess.GlobalRole,
		"appRole":    sess.AppRole,
		"allowAdmin": sess.AllowAdmin,
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handlePublicAuthLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.auth.VerifyPublicOrigin(r) {
		writeAPIError(w, http.StatusForbidden, "CSRF verification failed", "Missing or invalid Origin header.")
		return
	}
	s.auth.ClearReaderSessionCookie(w, r)
	w.Header().Set("Clear-Site-Data", `"cookies", "storage"`)

	resp := map[string]any{"ok": true}
	if s.cfg.UsesCitadel() && strings.TrimSpace(s.cfg.CitadelPublicURL) != "" {
		resp["citadelLogoutUrl"] = strings.TrimRight(s.cfg.CitadelPublicURL, "/") + "/oauth/logout?rd=" + url.QueryEscape(s.cfg.SiteURL)
	}
	writeJSON(w, http.StatusOK, resp)
}
