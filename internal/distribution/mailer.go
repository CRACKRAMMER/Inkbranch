package distribution

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"sync"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
)

type EmailMessage struct {
	To              string
	Subject         string
	HTMLBody        string
	TextBody        string
	ListUnsubscribe string
}

type MailSender interface {
	Configured() bool
	Send(ctx context.Context, msg EmailMessage) error
}

type Mailer struct {
	cfg    *config.Config
	client *http.Client
}

func NewMailer(cfg *config.Config) *Mailer {
	return &Mailer{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (m *Mailer) Configured() bool {
	if m == nil || m.cfg == nil {
		return false
	}
	return strings.TrimSpace(m.cfg.ResendAPIKey) != "" || strings.TrimSpace(m.cfg.SMTPHost) != ""
}

func (m *Mailer) Send(ctx context.Context, msg EmailMessage) error {
	if !m.Configured() {
		return nil
	}
	if strings.TrimSpace(m.cfg.ResendAPIKey) != "" {
		return m.sendViaResend(ctx, msg)
	}
	return m.sendViaSMTP(msg)
}

func (m *Mailer) sendViaResend(ctx context.Context, msg EmailMessage) error {
	payload := map[string]any{
		"from":    m.cfg.SMTPFrom,
		"to":      []string{msg.To},
		"subject": msg.Subject,
		"html":    msg.HTMLBody,
		"text":    msg.TextBody,
	}
	if msg.ListUnsubscribe != "" {
		payload["headers"] = map[string]string{
			"List-Unsubscribe":      "<" + msg.ListUnsubscribe + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.cfg.ResendAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("resend status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (m *Mailer) sendViaSMTP(msg EmailMessage) error {
	host := strings.TrimSpace(m.cfg.SMTPHost)
	port := m.cfg.SMTPPort
	if port <= 0 {
		port = 587
	}
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))

	fromAddr := extractBareEmail(m.cfg.SMTPFrom)
	if fromAddr == "" {
		fromAddr = "noreply@localhost"
	}

	var headers strings.Builder
	fmt.Fprintf(&headers, "From: %s\r\n", sanitizeHeaderValue(m.cfg.SMTPFrom))
	fmt.Fprintf(&headers, "To: %s\r\n", sanitizeHeaderValue(msg.To))
	fmt.Fprintf(&headers, "Subject: %s\r\n", sanitizeHeaderValue(msg.Subject))
	headers.WriteString("MIME-Version: 1.0\r\n")
	if msg.ListUnsubscribe != "" {
		fmt.Fprintf(&headers, "List-Unsubscribe: <%s>\r\n", sanitizeHeaderValue(msg.ListUnsubscribe))
		headers.WriteString("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n")
	}
	headers.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	headers.WriteString(msg.HTMLBody)

	var auth smtp.Auth
	if m.cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", m.cfg.SMTPUser, m.cfg.SMTPPass, host)
	}

	if port == 465 {
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err != nil {
			return err
		}
		c, err := smtp.NewClient(conn, host)
		if err != nil {
			_ = conn.Close()
			return err
		}
		defer c.Close()
		if auth != nil {
			if err := c.Auth(auth); err != nil {
				return err
			}
		}
		if err := c.Mail(fromAddr); err != nil {
			return err
		}
		if err := c.Rcpt(msg.To); err != nil {
			return err
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(headers.String())); err != nil {
			_ = w.Close()
			return err
		}
		return w.Close()
	}

	return smtp.SendMail(addr, auth, fromAddr, []string{msg.To}, []byte(headers.String()))
}

func extractBareEmail(from string) string {
	s := strings.TrimSpace(from)
	if start := strings.IndexByte(s, '<'); start >= 0 {
		if end := strings.IndexByte(s[start:], '>'); end > 1 {
			return strings.TrimSpace(s[start+1 : start+end])
		}
	}
	return s
}

func sanitizeHeaderValue(v string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(strings.TrimSpace(v))
}

// MemoryMailer captures outbound messages in memory for deterministic tests.
type MemoryMailer struct {
	mu       sync.Mutex
	Messages []EmailMessage
	Err      error
}

func (m *MemoryMailer) Configured() bool {
	return true
}

func (m *MemoryMailer) Send(_ context.Context, msg EmailMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	m.Messages = append(m.Messages, msg)
	return nil
}

func ErrMailerUnavailable() error {
	return errors.New("mailer not configured")
}
