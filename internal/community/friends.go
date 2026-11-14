package community

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

const maxFeedBytes = 2 << 20 // 2 MiB

type FeedPoller struct {
	Client              *http.Client
	AllowPrivateForTest bool
}

func NewFeedPoller() *FeedPoller {
	return &FeedPoller{
		Client: &http.Client{Timeout: 8 * time.Second},
	}
}

var htmlTagStripRe = regexp.MustCompile(`<[^>]+>`)

// ValidatePublicURL verifies http/https URLs and blocks loopback/private network SSRF targets unless AllowPrivateForTest is set.
func ValidatePublicURL(raw string, allowPrivate bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, fmt.Errorf("URL must be valid http/https")
	}
	if allowPrivate {
		return u, nil
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, fmt.Errorf("local host %q is not allowed", host)
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedIP(ip) {
			return nil, fmt.Errorf("private IP %s is not allowed", ip)
		}
		return u, nil
	}
	ips, err := net.LookupIP(host)
	if err == nil {
		for _, ip := range ips {
			if isBlockedIP(ip) {
				return nil, fmt.Errorf("resolved private IP %s is not allowed", ip)
			}
		}
	}
	return u, nil
}

func isBlockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}

// PollAll fetches feeds for all active/unreachable friend links that specify a feedUrl.
func (fp *FeedPoller) PollAll(ctx context.Context, st state.Store) (checked int, itemsAdded int) {
	links, err := st.ListFriendLinks(ctx, "")
	if err != nil {
		return 0, 0
	}
	for _, fl := range links {
		if fl.FeedURL == "" || (fl.Status != "active" && fl.Status != "unreachable") {
			continue
		}
		checked++
		n, _ := fp.PollOne(ctx, st, fl)
		itemsAdded += n
	}
	return checked, itemsAdded
}

// PollOne fetches a single friend's RSS 2.0 or Atom 1.0 feed and upserts up to 10 recent entries.
func (fp *FeedPoller) PollOne(ctx context.Context, st state.Store, fl state.FriendLinkRecord) (int, error) {
	if fl.FeedURL == "" {
		return 0, nil
	}
	u, err := ValidatePublicURL(fl.FeedURL, fp.AllowPrivateForTest)
	if err != nil {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "unreachable", fl.ETag, fl.LastModified, time.Now().UTC())
		return 0, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Inkbranch-FeedPoller/2.0 (+https://blog.crackrammer.com)")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9")
	if fl.ETag != "" {
		req.Header.Set("If-None-Match", fl.ETag)
	}
	if fl.LastModified != "" {
		req.Header.Set("If-Modified-Since", fl.LastModified)
	}

	client := fp.Client
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resp, err := client.Do(req)
	now := time.Now().UTC()
	if err != nil {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "unreachable", fl.ETag, fl.LastModified, now)
		return 0, err
	}
	defer resp.Body.Close()

	etag := firstNonEmpty(resp.Header.Get("ETag"), fl.ETag)
	lastMod := firstNonEmpty(resp.Header.Get("Last-Modified"), fl.LastModified)
	if resp.StatusCode == http.StatusNotModified {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "active", etag, lastMod, now)
		return 0, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "unreachable", etag, lastMod, now)
		return 0, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFeedBytes))
	if err != nil {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "unreachable", etag, lastMod, now)
		return 0, err
	}

	parsed, err := ParseFeedItems(body, fl.ID)
	if err != nil {
		_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "unreachable", etag, lastMod, now)
		return 0, err
	}
	if len(parsed) > 10 {
		parsed = parsed[:10]
	}
	if err := st.UpsertFriendFeedItems(ctx, parsed); err != nil {
		return 0, err
	}
	_ = st.UpdateFriendFeedCheck(ctx, fl.ID, "active", etag, lastMod, now)
	return len(parsed), nil
}

// ParseFeedItems parses RSS 2.0 or Atom 1.0 XML bytes into normalized FriendFeedRecord items.
func ParseFeedItems(data []byte, friendID uuid.UUID) ([]state.FriendFeedRecord, error) {
	trimmed := strings.TrimSpace(string(data))
	if strings.Contains(trimmed, "<rss") {
		var rss struct {
			Channel struct {
				Items []struct {
					Title       string `xml:"title"`
					Link        string `xml:"link"`
					GUID        string `xml:"guid"`
					Description string `xml:"description"`
					PubDate     string `xml:"pubDate"`
				} `xml:"item"`
			} `xml:"channel"`
		}
		if err := xml.Unmarshal(data, &rss); err != nil {
			return nil, fmt.Errorf("parse rss: %w", err)
		}
		out := make([]state.FriendFeedRecord, 0, len(rss.Channel.Items))
		for _, it := range rss.Channel.Items {
			title := strings.TrimSpace(it.Title)
			link := strings.TrimSpace(it.Link)
			if title == "" || link == "" {
				continue
			}
			guid := firstNonEmpty(strings.TrimSpace(it.GUID), link)
			out = append(out, state.FriendFeedRecord{
				ID:          uuid.New(),
				FriendID:    friendID,
				ItemGUID:    guid,
				Title:       title,
				Link:        link,
				Summary:     cleanSummary(it.Description),
				PublishedAt: parseFeedTime(it.PubDate),
			})
		}
		return out, nil
	}

	var atom struct {
		Entries []struct {
			ID      string `xml:"id"`
			Title   string `xml:"title"`
			Summary string `xml:"summary"`
			Content string `xml:"content"`
			Updated string `xml:"updated"`
			Pub     string `xml:"published"`
			Links   []struct {
				Href string `xml:"href,attr"`
				Rel  string `xml:"rel,attr"`
			} `xml:"link"`
		} `xml:"entry"`
	}
	if err := xml.Unmarshal(data, &atom); err != nil {
		return nil, fmt.Errorf("parse atom: %w", err)
	}
	out := make([]state.FriendFeedRecord, 0, len(atom.Entries))
	for _, entry := range atom.Entries {
		title := strings.TrimSpace(entry.Title)
		link := ""
		for _, l := range entry.Links {
			if l.Rel == "" || l.Rel == "alternate" {
				link = strings.TrimSpace(l.Href)
				break
			}
		}
		if link == "" && len(entry.Links) > 0 {
			link = strings.TrimSpace(entry.Links[0].Href)
		}
		if title == "" || link == "" {
			continue
		}
		guid := firstNonEmpty(strings.TrimSpace(entry.ID), link)
		summary := firstNonEmpty(entry.Summary, entry.Content)
		pubStr := firstNonEmpty(entry.Pub, entry.Updated)
		out = append(out, state.FriendFeedRecord{
			ID:          uuid.New(),
			FriendID:    friendID,
			ItemGUID:    guid,
			Title:       title,
			Link:        link,
			Summary:     cleanSummary(summary),
			PublishedAt: parseFeedTime(pubStr),
		})
	}
	return out, nil
}

type atomEntryAlias struct {
	Published string
}

func (a *atomEntryAlias) _unused() {}

func parseFeedTime(raw string) time.Time {
	s := strings.TrimSpace(raw)
	if s == "" {
		return time.Now().UTC()
	}
	layouts := []string{
		time.RFC3339,
		time.RFC3339Nano,
		time.RFC1123Z,
		time.RFC1123,
		time.RFC822Z,
		time.RFC822,
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Now().UTC()
}

func cleanSummary(raw string) string {
	stripped := htmlTagStripRe.ReplaceAllString(raw, " ")
	fields := strings.Fields(stripped)
	joined := strings.Join(fields, " ")
	runes := []rune(joined)
	if len(runes) > 220 {
		return string(runes[:219]) + "…"
	}
	return joined
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
