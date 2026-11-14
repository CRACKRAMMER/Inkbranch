package distribution

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

func TestNewsletterDoubleOptInAndCampaign(t *testing.T) {
	st := state.NewMemoryStore()
	cfg := &config.Config{
		SiteURL:  "https://blog.crackrammer.com",
		SiteName: "Inkbranch",
	}
	mailer := &MemoryMailer{}

	res, err := Subscribe(context.Background(), st, mailer, cfg, "reader@example.com")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if res.Status != "pending_confirmation" || len(mailer.Messages) != 1 {
		t.Fatalf("expected confirmation email, got status=%s msgs=%d", res.Status, len(mailer.Messages))
	}
	sub, _ := st.GetSubscriberByEmail(context.Background(), "reader@example.com")
	if sub == nil || sub.Status != "pending" || sub.ConfirmToken == "" {
		t.Fatalf("expected pending subscriber with confirm token, got %+v", sub)
	}

	confirmed, err := ConfirmSubscription(context.Background(), st, sub.ConfirmToken)
	if err != nil || confirmed.Status != "active" {
		t.Fatalf("ConfirmSubscription failed: err=%v sub=%+v", err, confirmed)
	}

	campaign, err := SendNewsletterCampaign(context.Background(), st, mailer, cfg, "Issue #1", "Hello **Readers**", "post", "hello")
	if err != nil {
		t.Fatalf("SendNewsletterCampaign: %v", err)
	}
	if campaign.SentCount != 1 || campaign.FailedCount != 0 {
		t.Fatalf("unexpected campaign counts: %+v", campaign)
	}
	lastMsg := mailer.Messages[len(mailer.Messages)-1]
	if !strings.Contains(lastMsg.ListUnsubscribe, url.QueryEscape(sub.UnsubscribeToken)) {
		t.Fatalf("missing RFC 8058 List-Unsubscribe token in %q", lastMsg.ListUnsubscribe)
	}

	unsub, err := UnsubscribeByToken(context.Background(), st, sub.UnsubscribeToken)
	if err != nil || unsub.Status != "unsubscribed" {
		t.Fatalf("UnsubscribeByToken failed: err=%v sub=%+v", err, unsub)
	}
}

func TestWebhookHMACSignatureDispatch(t *testing.T) {
	var gotSig, gotEvent string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Inkbranch-Signature-256")
		gotEvent = r.Header.Get("X-Inkbranch-Event")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("queued"))
	}))
	defer srv.Close()

	cfg := &config.Config{
		SiteURL:       "https://blog.crackrammer.com",
		SessionSecret: "webhook-test-secret-32-bytes-minimum",
	}
	st := state.NewMemoryStore()
	encSecret, err := auth.EncryptBytes(cfg.EffectiveSecretKey(), []byte("hook-hmac-secret"))
	if err != nil {
		t.Fatalf("EncryptBytes: %v", err)
	}
	hookID := uuid.New()
	_ = st.CreateWebhook(context.Background(), state.WebhookRecord{
		ID:        hookID,
		Name:      "Portal Sync",
		TargetURL: srv.URL + "/hook",
		SecretEnc: encSecret,
		Events:    []string{"content.published"},
		Enabled:   true,
	})

	disp := NewWebhookDispatcher(cfg, st)
	disp.AllowPrivateForTest = true
	disp.Dispatch(context.Background(), "content.published", map[string]string{"slug": "go-v2"})

	if gotEvent != "content.published" {
		t.Fatalf("expected X-Inkbranch-Event=content.published, got %q", gotEvent)
	}
	wantSig := ComputeSignature("hook-hmac-secret", gotBody)
	if gotSig == "" || gotSig != wantSig {
		t.Fatalf("signature mismatch: got=%q want=%q", gotSig, wantSig)
	}

	deliveries, _ := st.ListWebhookDeliveries(context.Background(), &hookID, 10)
	if len(deliveries) != 1 || deliveries[0].StatusCode == nil || *deliveries[0].StatusCode != 202 {
		t.Fatalf("expected recorded 202 delivery, got %+v", deliveries)
	}
}
