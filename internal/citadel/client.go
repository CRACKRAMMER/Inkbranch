package citadel

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	defaultIntrospectTTL    = 15 * time.Second
	maxIntrospectCacheItems = 512
)

// Config holds the settings required for Inkbranch to communicate with Citadel.
type Config struct {
	AppID          string
	InternalURL    string
	PublicURL      string
	InternalSecret string
	SiteURL        string
	UpstreamURL    string
	HTTPClient     *http.Client
}

// RoleDefinition matches Citadel's /internal/v1/apps/register defined_roles element.
type RoleDefinition struct {
	Role        string   `json:"role"`
	Label       string   `json:"label"`
	Permissions []string `json:"permissions"`
}

// RegisterPayload is the idempotent startup registration body sent to Citadel.
type RegisterPayload struct {
	AppID                  string           `json:"app_id"`
	Name                   string           `json:"name"`
	Description            string           `json:"description"`
	IconURL                string           `json:"icon_url"`
	PublicURL              string           `json:"public_url"`
	APIOrigin              string           `json:"api_origin,omitempty"`
	AdminPath              string           `json:"admin_path"`
	UpstreamURL            string           `json:"upstream_url"`
	HealthURL              string           `json:"health_url"`
	LoginPolicy            string           `json:"login_policy"`
	LegacyTokenPassthrough bool             `json:"legacy_token_passthrough"`
	PreservePolicy         *bool            `json:"preserve_policy,omitempty"`
	OAuthRedirectURIs      []string         `json:"oauth_redirect_uris"`
	DefinedRoles           []RoleDefinition `json:"defined_roles"`
}

// RegisterResponse is Citadel's response to POST /internal/v1/apps/register.
type RegisterResponse struct {
	AppID         string `json:"app_id"`
	OAuthClientID string `json:"oauth_client_id"`
	LoginPolicy   string `json:"login_policy"`
	RegisteredAt  string `json:"registered_at"`
}

// UserInfo represents a Citadel identity returned by introspection or OAuth token exchange.
type UserInfo struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	AvatarURL  string `json:"avatar_url"`
	GlobalRole string `json:"global_role"`
}

// IntrospectResult is Citadel's response to POST /internal/v1/auth/introspect.
type IntrospectResult struct {
	Active     bool     `json:"active"`
	TokenKind  string   `json:"token_kind"`
	User       UserInfo `json:"user"`
	AppID      string   `json:"app_id"`
	AllowLogin bool     `json:"allow_login"`
	AllowAdmin bool     `json:"allow_admin"`
	AppRole    string   `json:"app_role"`
	Scopes     []string `json:"scopes"`
	ExpiresAt  string   `json:"expires_at"`
}

// OAuthAppGrant describes app-level grants returned in OAuth token exchange.
type OAuthAppGrant struct {
	AllowLogin  bool     `json:"allow_login"`
	AllowAdmin  bool     `json:"allow_admin"`
	AppRole     string   `json:"app_role"`
	Permissions []string `json:"permissions"`
}

// OAuthTokenResponse is Citadel's response to POST /internal/v1/oauth/token.
type OAuthTokenResponse struct {
	AccessToken  string         `json:"access_token"`
	TokenType    string         `json:"token_type"`
	ExpiresIn    int            `json:"expires_in"`
	RefreshToken string         `json:"refresh_token"`
	Scope        string         `json:"scope"`
	User         UserInfo       `json:"user"`
	AppGrant     *OAuthAppGrant `json:"app_grant,omitempty"`
}

// APIError captures non-2xx responses from Citadel internal endpoints.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("citadel returned HTTP %d: %s", e.StatusCode, e.Body)
}

type cachedIntrospection struct {
	result      IntrospectResult
	cachedUntil time.Time
}

// Client handles backend-to-backend integration with Citadel.
type Client struct {
	appID          string
	internalURL    string
	publicURL      string
	internalSecret string
	siteURL        string
	upstreamURL    string
	httpClient     *http.Client
	logger         *slog.Logger

	cacheMu         sync.RWMutex
	introspectCache map[string]cachedIntrospection
}

// NewClient creates a new Citadel backend client.
func NewClient(cfg Config, logger *slog.Logger) *Client {
	appID := strings.TrimSpace(cfg.AppID)
	if appID == "" {
		appID = "inkbranch"
	}
	siteURL := strings.TrimRight(strings.TrimSpace(cfg.SiteURL), "/")
	if siteURL == "" {
		siteURL = "https://blog.crackrammer.com"
	}
	upstreamURL := strings.TrimRight(strings.TrimSpace(cfg.UpstreamURL), "/")
	if upstreamURL == "" {
		upstreamURL = "http://127.0.0.1:3000"
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 8 * time.Second}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{
		appID:           appID,
		internalURL:     strings.TrimRight(strings.TrimSpace(cfg.InternalURL), "/"),
		publicURL:       strings.TrimRight(strings.TrimSpace(cfg.PublicURL), "/"),
		internalSecret:  strings.TrimSpace(cfg.InternalSecret),
		siteURL:         siteURL,
		upstreamURL:     upstreamURL,
		httpClient:      httpClient,
		logger:          logger,
		introspectCache: make(map[string]cachedIntrospection),
	}
}

// AppID returns the configured Citadel application ID.
func (c *Client) AppID() string {
	return c.appID
}

// PublicURL returns Citadel's configured public base URL.
func (c *Client) PublicURL() string {
	return c.publicURL
}

// OAuthClientID returns the Citadel OAuth2 client identifier for this application.
func (c *Client) OAuthClientID() string {
	return "cit_app_" + c.appID
}

// DefaultDefinedRoles returns Inkbranch's declared role matrix matching inkbranch.manifest.json.
func DefaultDefinedRoles() []RoleDefinition {
	return []RoleDefinition{
		{
			Role:        "viewer",
			Label:       "内容只读成员",
			Permissions: []string{"content:read"},
		},
		{
			Role:        "editor",
			Label:       "编辑与评论审核员",
			Permissions: []string{"content:read", "content:write", "media:write", "comments:moderate"},
		},
		{
			Role:  "admin",
			Label: "Inkbranch 超级管理员",
			Permissions: []string{
				"admin:*",
				"content:read",
				"content:write",
				"media:write",
				"comments:moderate",
				"webhooks:manage",
			},
		},
	}
}

// RegisterApp idempotently registers or updates Inkbranch's metadata and roles in Citadel.
func (c *Client) RegisterApp(ctx context.Context) (*RegisterResponse, error) {
	preservePolicy := true
	payload := RegisterPayload{
		AppID:                  c.appID,
		Name:                   "Inkbranch",
		Description:            "CRACKRAMMER Personal Knowledge System & Publishing Platform",
		IconURL:                c.siteURL + "/favicon.svg",
		PublicURL:              c.siteURL,
		APIOrigin:              c.siteURL,
		AdminPath:              "/blog/",
		UpstreamURL:            c.upstreamURL,
		HealthURL:              c.upstreamURL + "/api/health",
		LoginPolicy:            "open",
		LegacyTokenPassthrough: true,
		PreservePolicy:         &preservePolicy,
		OAuthRedirectURIs:      []string{c.siteURL + "/api/v1/public/auth/callback"},
		DefinedRoles:           DefaultDefinedRoles(),
	}
	var out RegisterResponse
	if err := c.doInternalJSON(ctx, http.MethodPost, "/internal/v1/apps/register", payload, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// StartAutoRegister registers Inkbranch with Citadel in the background with exponential backoff
// so startup is never blocked when Citadel is temporarily unavailable.
func (c *Client) StartAutoRegister(ctx context.Context) {
	if c == nil || c.internalURL == "" {
		return
	}
	go func() {
		backoff := 2 * time.Second
		const maxBackoff = 60 * time.Second
		for {
			attemptCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			res, err := c.RegisterApp(attemptCtx)
			cancel()
			if err == nil {
				c.logger.Info("registered app with Citadel",
					"app_id", res.AppID,
					"oauth_client_id", res.OAuthClientID,
					"login_policy", res.LoginPolicy,
				)
				return
			}
			c.logger.Warn("citadel app registration attempt failed; retrying",
				"error", err,
				"retry_in", backoff.String(),
			)
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}()
}

// IntrospectToken verifies a Citadel PAT (cit_pat_*) or OAuth2 access token (cit_at_*)
// against Citadel's internal introspection endpoint with a bounded 15s cache.
func (c *Client) IntrospectToken(ctx context.Context, rawToken string) (*IntrospectResult, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return &IntrospectResult{Active: false}, nil
	}
	cacheKey := tokenCacheKey(rawToken)
	now := time.Now().UTC()

	c.cacheMu.RLock()
	cached, ok := c.introspectCache[cacheKey]
	c.cacheMu.RUnlock()
	if ok && now.Before(cached.cachedUntil) {
		cloned := cloneIntrospectResult(cached.result)
		return &cloned, nil
	}

	reqBody := struct {
		Token string `json:"token"`
		AppID string `json:"app_id"`
	}{
		Token: rawToken,
		AppID: c.appID,
	}
	var res IntrospectResult
	if err := c.doInternalJSON(ctx, http.MethodPost, "/internal/v1/auth/introspect", reqBody, true, &res); err != nil {
		return nil, err
	}

	if res.Active {
		until := now.Add(defaultIntrospectTTL)
		if res.ExpiresAt != "" {
			if exp, err := time.Parse(time.RFC3339, res.ExpiresAt); err == nil {
				if !exp.After(now) {
					res.Active = false
					cloned := cloneIntrospectResult(res)
					return &cloned, nil
				}
				if exp.Before(until) {
					until = exp
				}
			}
		}
		stored := cloneIntrospectResult(res)
		c.cacheMu.Lock()
		if len(c.introspectCache) >= maxIntrospectCacheItems {
			for k, v := range c.introspectCache {
				if !now.Before(v.cachedUntil) {
					delete(c.introspectCache, k)
				}
			}
			if len(c.introspectCache) >= maxIntrospectCacheItems {
				clear(c.introspectCache)
			}
		}
		c.introspectCache[cacheKey] = cachedIntrospection{
			result:      stored,
			cachedUntil: until,
		}
		c.cacheMu.Unlock()
	}

	cloned := cloneIntrospectResult(res)
	return &cloned, nil
}

// InvalidateTokenCache removes a cached introspection result if present.
func (c *Client) InvalidateTokenCache(rawToken string) {
	if c == nil || strings.TrimSpace(rawToken) == "" {
		return
	}
	c.cacheMu.Lock()
	delete(c.introspectCache, tokenCacheKey(strings.TrimSpace(rawToken)))
	c.cacheMu.Unlock()
}

// ExchangeOAuthCode exchanges an OAuth2 authorization code and PKCE verifier via Citadel's internal endpoint.
func (c *Client) ExchangeOAuthCode(ctx context.Context, code, redirectURI, codeVerifier string) (*OAuthTokenResponse, error) {
	payload := map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     c.OAuthClientID(),
		"code":          code,
		"redirect_uri":  redirectURI,
		"code_verifier": codeVerifier,
	}
	var out OAuthTokenResponse
	if err := c.doInternalJSON(ctx, http.MethodPost, "/internal/v1/oauth/token", payload, c.internalSecret != "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RefreshOAuthToken refreshes a Citadel OAuth2 access token using a stored refresh_token.
func (c *Client) RefreshOAuthToken(ctx context.Context, refreshToken string) (*OAuthTokenResponse, error) {
	payload := map[string]string{
		"grant_type":    "refresh_token",
		"client_id":     c.OAuthClientID(),
		"refresh_token": refreshToken,
	}
	var out OAuthTokenResponse
	if err := c.doInternalJSON(ctx, http.MethodPost, "/internal/v1/oauth/token", payload, c.internalSecret != "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) doInternalJSON(ctx context.Context, method, path string, reqPayload any, sendSecret bool, out any) error {
	if c.internalURL == "" {
		return fmt.Errorf("citadel internal URL is not configured")
	}
	rawBody, err := json.Marshal(reqPayload)
	if err != nil {
		return fmt.Errorf("marshal citadel request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.internalURL+path, bytes.NewReader(rawBody))
	if err != nil {
		return fmt.Errorf("create citadel request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if sendSecret && c.internalSecret != "" {
		req.Header.Set("Authorization", "Bearer "+c.internalSecret)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("citadel request %s: %w", path, err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read citadel response %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(bodyBytes))
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return &APIError{
			StatusCode: resp.StatusCode,
			Body:       msg,
		}
	}
	if out != nil && len(bytes.TrimSpace(bodyBytes)) > 0 {
		if err := json.Unmarshal(bodyBytes, out); err != nil {
			return fmt.Errorf("decode citadel response %s: %w", path, err)
		}
	}
	return nil
}

func tokenCacheKey(rawToken string) string {
	sum := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(sum[:])
}

func cloneIntrospectResult(in IntrospectResult) IntrospectResult {
	out := in
	if len(in.Scopes) > 0 {
		out.Scopes = append([]string(nil), in.Scopes...)
	}
	return out
}
