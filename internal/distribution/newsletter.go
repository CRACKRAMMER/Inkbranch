package distribution

import (
	"bytes"
	"context"
	"fmt"
	stdhtml "html"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

var newsletterMD = goldmark.New(goldmark.WithExtensions(extension.GFM, extension.Strikethrough))

type SubscribeResult struct {
	Status           string `json:"status"` // "pending_confirmation" | "already_active" | "active"
	Message          string `json:"message"`
	ConfirmURL       string `json:"confirmUrl,omitempty"`
	UnsubscribeToken string `json:"-"`
}

// Subscribe creates or refreshes a Double Opt-in subscriber and sends a confirmation email when mailer is configured.
func Subscribe(ctx context.Context, st state.Store, mailer MailSender, cfg *config.Config, rawEmail string) (*SubscribeResult, error) {
	parsed, err := mail.ParseAddress(strings.TrimSpace(rawEmail))
	if err != nil || parsed.Address == "" || len(parsed.Address) > 254 {
		return nil, fmt.Errorf("please enter a valid email address")
	}
	email := strings.ToLower(strings.TrimSpace(parsed.Address))

	existing, err := st.GetSubscriberByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == "active" {
		return &SubscribeResult{
			Status:  "already_active",
			Message: "该邮箱已确认订阅。",
		}, nil
	}

	confirmTok, _, _, err := auth.GenerateRandomToken("subconf_", 24)
	if err != nil {
		return nil, err
	}
	unsubTok := ""
	if existing != nil && existing.UnsubscribeToken != "" {
		unsubTok = existing.UnsubscribeToken
	} else {
		unsubTok, _, _, err = auth.GenerateRandomToken("unsub_", 24)
		if err != nil {
			return nil, err
		}
	}

	sub, err := st.UpsertSubscriber(ctx, state.SubscriberRecord{
		Email:            email,
		Status:           "pending",
		ConfirmToken:     confirmTok,
		UnsubscribeToken: unsubTok,
	})
	if err != nil {
		return nil, err
	}

	siteURL := "http://localhost:3000"
	siteName := "Inkbranch"
	if cfg != nil {
		if cfg.SiteURL != "" {
			siteURL = cfg.SiteURL
		}
		if cfg.SiteName != "" {
			siteName = cfg.SiteName
		}
	}
	confirmURL := siteURL + "/api/v1/newsletter/confirm?token=" + url.QueryEscape(sub.ConfirmToken)
	unsubURL := siteURL + "/api/v1/newsletter/unsubscribe?token=" + url.QueryEscape(sub.UnsubscribeToken)

	if mailer != nil && mailer.Configured() {
		htmlBody := fmt.Sprintf(`<p>感谢订阅 <strong>%s</strong>！请点击下方链接确认你的邮箱地址：</p>
<p><a href="%s">确认订阅</a></p>
<p style="font-size:12px;color:#666">如果这不是你的操作，请忽略此邮件。退订链接：%s</p>`,
			stdhtml.EscapeString(siteName),
			stdhtml.EscapeString(confirmURL),
			stdhtml.EscapeString(unsubURL),
		)
		textBody := fmt.Sprintf("感谢订阅 %s！请打开以下链接确认订阅：\n%s\n\n退订：%s\n", siteName, confirmURL, unsubURL)
		if err := mailer.Send(ctx, EmailMessage{
			To:              sub.Email,
			Subject:         fmt.Sprintf("确认订阅 %s", siteName),
			HTMLBody:        htmlBody,
			TextBody:        textBody,
			ListUnsubscribe: unsubURL,
		}); err != nil {
			return nil, fmt.Errorf("send confirmation email: %w", err)
		}
		return &SubscribeResult{
			Status:  "pending_confirmation",
			Message: "确认邮件已发送，请检查收件箱点击确认链接。",
		}, nil
	}

	return &SubscribeResult{
		Status:  "pending_confirmation",
		Message: "已登记待确认订阅，站长尚未配置发信服务或请使用确认链接完成验证。",
	}, nil
}

func ConfirmSubscription(ctx context.Context, st state.Store, token string) (*state.SubscriberRecord, error) {
	tok := strings.TrimSpace(token)
	if tok == "" {
		return nil, fmt.Errorf("missing confirmation token")
	}
	sub, err := st.GetSubscriberByConfirmToken(ctx, tok)
	if err != nil || sub == nil {
		return nil, fmt.Errorf("invalid or expired confirmation token")
	}
	if err := st.UpdateSubscriberStatus(ctx, sub.ID, "active", time.Now().UTC()); err != nil {
		return nil, err
	}
	return st.GetSubscriberByEmail(ctx, sub.Email)
}

func UnsubscribeByToken(ctx context.Context, st state.Store, token string) (*state.SubscriberRecord, error) {
	tok := strings.TrimSpace(token)
	if tok == "" {
		return nil, fmt.Errorf("missing unsubscribe token")
	}
	sub, err := st.GetSubscriberByUnsubscribeToken(ctx, tok)
	if err != nil || sub == nil {
		return nil, fmt.Errorf("invalid unsubscribe token")
	}
	if err := st.UpdateSubscriberStatus(ctx, sub.ID, "unsubscribed", time.Now().UTC()); err != nil {
		return nil, err
	}
	return st.GetSubscriberByEmail(ctx, sub.Email)
}

// SendNewsletterCampaign renders Markdown, persists a campaign record, and sends to active subscribers with RFC 8058 headers.
func SendNewsletterCampaign(ctx context.Context, st state.Store, mailer MailSender, cfg *config.Config, subject, bodyMarkdown, contentType, contentSlug string) (*state.NewsletterRecord, error) {
	subj := strings.TrimSpace(subject)
	md := strings.TrimSpace(bodyMarkdown)
	if subj == "" || md == "" {
		return nil, fmt.Errorf("subject and bodyMarkdown are required")
	}
	var buf bytes.Buffer
	if err := newsletterMD.Convert([]byte(md), &buf); err != nil {
		return nil, err
	}
	bodyHTML := buf.String()

	rec := state.NewsletterRecord{
		ID:           uuid.New(),
		Subject:      subj,
		BodyMarkdown: md,
		BodyHTML:     bodyHTML,
		ContentType:  contentType,
		ContentSlug:  contentSlug,
		Status:       "sending",
		CreatedAt:    time.Now().UTC(),
	}
	if err := st.CreateNewsletter(ctx, rec); err != nil {
		return nil, err
	}

	subs, err := st.ListSubscribers(ctx, "active")
	if err != nil {
		return nil, err
	}

	siteURL := "http://localhost:3000"
	siteName := "Inkbranch"
	if cfg != nil {
		if cfg.SiteURL != "" {
			siteURL = cfg.SiteURL
		}
		if cfg.SiteName != "" {
			siteName = cfg.SiteName
		}
	}

	sent, failed := 0, 0
	for _, sub := range subs {
		unsubURL := siteURL + "/api/v1/newsletter/unsubscribe?token=" + url.QueryEscape(sub.UnsubscribeToken)
		fullHTML := bodyHTML + fmt.Sprintf(`<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb"/><p style="font-size:12px;color:#666">You received this email from %s. <a href="%s">One-click unsubscribe</a></p>`,
			stdhtml.EscapeString(siteName),
			stdhtml.EscapeString(unsubURL),
		)
		fullText := md + "\n\n---\nUnsubscribe: " + unsubURL + "\n"
		if mailer != nil && mailer.Configured() {
			if err := mailer.Send(ctx, EmailMessage{
				To:              sub.Email,
				Subject:         subj,
				HTMLBody:        fullHTML,
				TextBody:        fullText,
				ListUnsubscribe: unsubURL,
			}); err != nil {
				failed++
				continue
			}
			sent++
		} else {
			sent++
		}
	}

	now := time.Now().UTC()
	status := "sent"
	if sent == 0 && failed > 0 {
		status = "failed"
	}
	if err := st.UpdateNewsletterCounts(ctx, rec.ID, status, sent, failed, &now); err != nil {
		return nil, err
	}
	rec.Status = status
	rec.SentCount = sent
	rec.FailedCount = failed
	rec.SentAt = &now
	return &rec, nil
}
