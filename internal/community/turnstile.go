package community

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type TurnstileVerifier struct {
	SecretKey string
	Endpoint  string
	Client    *http.Client
}

func NewTurnstileVerifier(secretKey string) *TurnstileVerifier {
	return &TurnstileVerifier{
		SecretKey: strings.TrimSpace(secretKey),
		Endpoint:  "https://challenges.cloudflare.com/turnstile/v0/siteverify",
		Client:    &http.Client{Timeout: 6 * time.Second},
	}
}

func (v *TurnstileVerifier) Enabled() bool {
	return v != nil && v.SecretKey != ""
}

func (v *TurnstileVerifier) Verify(ctx context.Context, token, remoteIP string) error {
	if !v.Enabled() {
		return nil
	}
	tok := strings.TrimSpace(token)
	if tok == "" {
		return fmt.Errorf("turnstile verification token is required")
	}
	form := url.Values{}
	form.Set("secret", v.SecretKey)
	form.Set("response", tok)
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := v.Client
	if client == nil {
		client = &http.Client{Timeout: 6 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("turnstile siteverify failed: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Success    bool     `json:"success"`
		ErrorCodes []string `json:"error-codes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode turnstile response: %w", err)
	}
	if !result.Success {
		return fmt.Errorf("turnstile verification failed (%v)", result.ErrorCodes)
	}
	return nil
}
