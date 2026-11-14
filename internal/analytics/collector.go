package analytics

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/auth"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
)

type CollectPayload struct {
	EventType    string `json:"eventType"` // "pageview" | "read_depth"
	ContentType  string `json:"contentType,omitempty"`
	Slug         string `json:"slug,omitempty"`
	Path         string `json:"path"`
	Referrer     string `json:"referrer,omitempty"`
	MaxDepth     int    `json:"maxDepth,omitempty"`
	DwellSeconds int    `json:"dwellSeconds,omitempty"`
}

// Collect validates and persists a cookie-free privacy-preserving analytics beacon.
func Collect(ctx context.Context, st state.Store, secretKey []byte, r *http.Request, p CollectPayload) error {
	if st == nil || strings.TrimSpace(p.Path) == "" {
		return nil
	}
	cleanPath := "/" + strings.TrimLeft(strings.TrimSpace(p.Path), "/")
	if len(cleanPath) > 512 {
		cleanPath = cleanPath[:512]
	}

	ip := strings.TrimSpace(r.RemoteAddr)
	if idx := strings.LastIndex(ip, ":"); idx > 0 && !strings.Contains(ip[idx:], "]") {
		ip = ip[:idx]
	}
	ua := r.UserAgent()
	visitorHash := auth.DailyRotatingHash(secretKey, "visitor", ip+"|"+ua, time.Now().UTC())

	refHost := normalizeReferrerHost(p.Referrer, r.Host)
	device := detectDeviceKind(ua)

	dwellMs := 0
	scrollPct := 0
	if p.EventType == "read_depth" {
		if p.DwellSeconds > 0 {
			dwellMs = min(p.DwellSeconds*1000, 3600*1000)
		}
		if p.MaxDepth > 0 {
			scrollPct = min(p.MaxDepth, 100)
		}
	}

	return st.InsertAnalyticsEvent(ctx, state.AnalyticsEventInput{
		Path:         cleanPath,
		ContentType:  strings.TrimSpace(p.ContentType),
		ContentSlug:  strings.TrimSpace(p.Slug),
		VisitorHash:  visitorHash,
		ReferrerHost: refHost,
		DeviceKind:   device,
		DwellMs:      dwellMs,
		ScrollPct:    scrollPct,
		OccurredAt:   time.Now().UTC(),
	})
}

func normalizeReferrerHost(rawRef, selfHost string) string {
	s := strings.TrimSpace(rawRef)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return ""
	}
	self := strings.ToLower(selfHost)
	if idx := strings.IndexByte(self, ':'); idx > 0 {
		self = self[:idx]
	}
	if self != "" && host == self {
		return ""
	}
	return host
}

func detectDeviceKind(ua string) string {
	lower := strings.ToLower(ua)
	if strings.Contains(lower, "ipad") || strings.Contains(lower, "tablet") {
		return "tablet"
	}
	if strings.Contains(lower, "mobile") || strings.Contains(lower, "android") || strings.Contains(lower, "iphone") {
		return "mobile"
	}
	return "desktop"
}
