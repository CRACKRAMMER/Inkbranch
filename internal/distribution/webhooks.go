package distribution

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

type WebhookDispatcher struct {
	cfg                 *config.Config
	state               state.Store
	client              *http.Client
	AllowPrivateForTest bool
}

func NewWebhookDispatcher(cfg *config.Config, st state.Store) *WebhookDispatcher {
	return &WebhookDispatcher{
		cfg:    cfg,
		state:  st,
		client: &http.Client{Timeout: 8 * time.Second},
	}
}

func ComputeSignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Dispatch emits an event to all enabled webhooks subscribed to eventName (or "*").
func (d *WebhookDispatcher) Dispatch(ctx context.Context, eventName string, data any) {
	if d == nil || d.state == nil {
		return
	}
	hooks, err := d.state.ListWebhooks(ctx)
	if err != nil {
		return
	}
	for _, hook := range hooks {
		if !hook.Enabled {
			continue
		}
		if len(hook.Events) > 0 && !slices.Contains(hook.Events, "*") && !slices.Contains(hook.Events, eventName) {
			continue
		}
		_, _ = d.DeliverWebhook(ctx, hook, eventName, data, 1)
	}
}

// DeliverWebhook synchronously executes a single webhook delivery and records the result.
func (d *WebhookDispatcher) DeliverWebhook(ctx context.Context, hook state.WebhookRecord, eventName string, data any, attempt int) (*state.WebhookDeliveryRecord, error) {
	deliveryID := uuid.New()
	envelope := map[string]any{
		"id":        deliveryID.String(),
		"event":     eventName,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"siteUrl":   d.cfg.SiteURL,
		"data":      data,
	}
	payloadBytes, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}

	rec := state.WebhookDeliveryRecord{
		ID:          deliveryID,
		WebhookID:   hook.ID,
		EventName:   eventName,
		PayloadJSON: payloadBytes,
		Attempt:     attempt,
		CreatedAt:   time.Now().UTC(),
	}

	if _, err := community.ValidatePublicURL(hook.TargetURL, d.AllowPrivateForTest); err != nil {
		rec.ErrorMessage = fmt.Sprintf("blocked webhook URL: %v", err)
		_ = d.state.RecordWebhookDelivery(ctx, rec)
		return &rec, err
	}

	secretPlain := ""
	if len(hook.SecretEnc) > 0 {
		if dec, err := auth.DecryptBytes(d.cfg.EffectiveSecretKey(), hook.SecretEnc); err == nil {
			secretPlain = string(dec)
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hook.TargetURL, bytes.NewReader(payloadBytes))
	if err != nil {
		rec.ErrorMessage = err.Error()
		_ = d.state.RecordWebhookDelivery(ctx, rec)
		return &rec, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Inkbranch-Webhook/2.0")
	req.Header.Set("X-Inkbranch-Event", eventName)
	req.Header.Set("X-Inkbranch-Delivery", deliveryID.String())
	if secretPlain != "" {
		req.Header.Set("X-Inkbranch-Signature-256", ComputeSignature(secretPlain, payloadBytes))
	}

	client := d.client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		rec.ErrorMessage = err.Error()
		_ = d.state.RecordWebhookDelivery(ctx, rec)
		return &rec, err
	}
	defer resp.Body.Close()

	code := resp.StatusCode
	rec.StatusCode = &code
	rawResp, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	rec.ResponseBody = strings.TrimSpace(string(rawResp))
	now := time.Now().UTC()
	rec.DeliveredAt = &now
	if code < 200 || code >= 300 {
		rec.ErrorMessage = fmt.Sprintf("webhook returned HTTP %d", code)
	}
	_ = d.state.RecordWebhookDelivery(ctx, rec)
	return &rec, nil
}
