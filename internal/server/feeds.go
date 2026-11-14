package server

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	stdhtml "html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/go-chi/chi/v5"
)

func (s *Server) registerFeedRoutes() {
	s.router.Get("/api/chroma.css", s.handleChromaCSS)
	s.router.Get("/api/og", s.handleOGImage)
	s.router.Get("/feed.xml", s.handleRSSRoot)
	s.router.Get("/rss.xml", s.handleRSSRoot)
	s.router.Get("/tags/{tag}/feed.xml", s.handleRSSTag)
	s.router.Get("/categories/{category}/feed.xml", s.handleRSSCategory)
	s.router.Get("/atom.xml", s.handleAtomFeed)
	s.router.Get("/feed.json", s.handleJSONFeed)
	s.router.Get("/llms.txt", s.handleLLMsTxt)
	s.router.Get("/llms-full.txt", s.handleLLMsFullTxt)
	s.router.Get("/sitemap.xml", s.handleSitemapXML)
	s.router.Get("/robots.txt", s.handleRobotsTxt)
}

func (s *Server) handleChromaCSS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(s.chromaCSS))
}

func (s *Server) handleOGImage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rawType := strings.TrimSpace(q.Get("type"))
	rawSlug := strings.TrimSpace(q.Get("slug"))
	title := strings.TrimSpace(q.Get("title"))
	desc := strings.TrimSpace(q.Get("description"))
	meta := strings.TrimSpace(q.Get("meta"))
	typeLabel := rawType

	if rawSlug != "" {
		var doc *content.Document
		if ct, ok := parseContentTypeFilter(rawType); ok {
			if d, found := s.store.GetPublished(ct, rawSlug); found {
				doc = d
			}
		} else {
			for _, ct := range content.AllTypes {
				if d, found := s.store.GetPublished(ct, rawSlug); found {
					doc = d
					break
				}
			}
		}
		if doc != nil {
			title = doc.Title
			if desc == "" {
				desc = doc.Description
			}
			typeLabel = string(doc.Type)
			if doc.Category != "" {
				typeLabel = string(doc.Type) + " / " + doc.Category
			}
			if meta == "" {
				dateStr := docEffectiveTime(doc).Format("2006-01-02")
				meta = fmt.Sprintf("%s · %d min read", dateStr, doc.ReadingMinutes)
			}
		}
	}

	if title == "" {
		title = s.cfg.SiteName
	}
	if desc == "" && rawSlug == "" {
		desc = s.cfg.SiteDescription
	}

	pngBytes, err := s.og.RenderPNG(media.OGInput{
		SiteName:    s.cfg.SiteName,
		TypeLabel:   limitRunes(typeLabel, 48),
		Title:       limitRunes(title, 120),
		Description: limitRunes(desc, 180),
		FooterMeta:  limitRunes(meta, 96),
	})
	if err != nil {
		s.logger.Error("render OG PNG failed", "error", err)
		http.Error(w, "failed to render og image", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(pngBytes)
}

func (s *Server) handleRSSRoot(w http.ResponseWriter, r *http.Request) {
	docs := s.filterFeedDocs("", "")
	s.writeRSSFeed(r.Context(), w, s.effectiveSiteName(r.Context()), s.effectiveSiteDesc(r.Context()), s.cfg.SiteURL+"/feed.xml", docs)
}

func (s *Server) handleRSSTag(w http.ResponseWriter, r *http.Request) {
	rawTag := pathParamUnescaped(r, "tag")
	docs := s.filterFeedDocs(rawTag, "")
	escTag := url.PathEscape(rawTag)
	name := s.effectiveSiteName(r.Context())
	s.writeRSSFeed(
		r.Context(),
		w,
		fmt.Sprintf("%s · Tag: %s", name, rawTag),
		fmt.Sprintf("Articles tagged %q on %s", rawTag, name),
		s.cfg.SiteURL+"/tags/"+escTag+"/feed.xml",
		docs,
	)
}

func (s *Server) handleRSSCategory(w http.ResponseWriter, r *http.Request) {
	rawCat := pathParamUnescaped(r, "category")
	docs := s.filterFeedDocs("", rawCat)
	escCat := url.PathEscape(rawCat)
	name := s.effectiveSiteName(r.Context())
	s.writeRSSFeed(
		r.Context(),
		w,
		fmt.Sprintf("%s · Category: %s", name, rawCat),
		fmt.Sprintf("Articles in category %q on %s", rawCat, name),
		s.cfg.SiteURL+"/categories/"+escCat+"/feed.xml",
		docs,
	)
}

func (s *Server) filterFeedDocs(tagFilter, catFilter string) []*content.Document {
	all := s.store.ListPublished("")
	var out []*content.Document
	for _, doc := range all {
		if doc.SEO.NoIndex {
			continue
		}
		if tagFilter != "" && !docHasTag(doc.Tags, tagFilter) {
			continue
		}
		if catFilter != "" && !strings.EqualFold(doc.Category, catFilter) &&
			content.Slugify(doc.Category, "cat") != content.Slugify(catFilter, "cat") {
			continue
		}
		out = append(out, doc)
		if len(out) >= 50 {
			break
		}
	}
	return out
}

type rssEnvelope struct {
	XMLName    xml.Name   `xml:"rss"`
	Version    string     `xml:"version,attr"`
	AtomNS     string     `xml:"xmlns:atom,attr"`
	ContentNS  string     `xml:"xmlns:content,attr"`
	Channel    rssChannel `xml:"channel"`
}

type rssAtomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

type rssGUID struct {
	IsPermaLink bool   `xml:"isPermaLink,attr"`
	Value       string `xml:",chardata"`
}

type rawXMLInner struct {
	Inner string `xml:",innerxml"`
}

type rssItem struct {
	Title          string       `xml:"title"`
	Link           string       `xml:"link"`
	GUID           rssGUID      `xml:"guid"`
	PubDate        string       `xml:"pubDate"`
	Description    string       `xml:"description"`
	Categories     []string     `xml:"category,omitempty"`
	ContentEncoded *rawXMLInner `xml:"content:encoded,omitempty"`
}

type rssChannel struct {
	Title         string      `xml:"title"`
	Link          string      `xml:"link"`
	Description   string      `xml:"description"`
	Language      string      `xml:"language"`
	LastBuildDate string      `xml:"lastBuildDate"`
	AtomLink      rssAtomLink `xml:"atom:link"`
	Items         []rssItem   `xml:"item"`
}

func (s *Server) writeRSSFeed(ctx context.Context, w http.ResponseWriter, title, desc, selfURL string, docs []*content.Document) {
	items := make([]rssItem, 0, len(docs))
	latest := time.Now().UTC()
	if len(docs) > 0 {
		latest = docEffectiveTime(docs[0])
	}
	summaryOnly := s.isSummaryFeed(ctx)

	for _, doc := range docs {
		absURL := s.absDocURL(doc)
		htmlBody := doc.RenderedHTML
		if summaryOnly {
			htmlBody = summaryFeedHTML(doc, absURL)
		}
		items = append(items, rssItem{
			Title:       doc.Title,
			Link:        absURL,
			GUID:        rssGUID{IsPermaLink: true, Value: absURL},
			PubDate:     docEffectiveTime(doc).UTC().Format(time.RFC1123Z),
			Description: doc.Description,
			Categories:  doc.Tags,
			ContentEncoded: &rawXMLInner{
				Inner: wrapCDATA(htmlBody),
			},
		})
	}

	env := rssEnvelope{
		Version:   "2.0",
		AtomNS:    "http://www.w3.org/2005/Atom",
		ContentNS: "http://purl.org/rss/1.0/modules/content/",
		Channel: rssChannel{
			Title:         title,
			Link:          s.cfg.SiteURL + "/",
			Description:   desc,
			Language:      "zh-cn",
			LastBuildDate: latest.UTC().Format(time.RFC1123Z),
			AtomLink: rssAtomLink{
				Href: selfURL,
				Rel:  "self",
				Type: "application/rss+xml",
			},
			Items: items,
		},
	}

	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if err := enc.Encode(env); err != nil {
		http.Error(w, "failed to encode rss feed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

type atomFeed struct {
	XMLName  xml.Name    `xml:"feed"`
	Xmlns    string      `xml:"xmlns,attr"`
	Title    string      `xml:"title"`
	Subtitle string      `xml:"subtitle,omitempty"`
	ID       string      `xml:"id"`
	Updated  string      `xml:"updated"`
	Links    []atomLink  `xml:"link"`
	Author   atomAuthor  `xml:"author"`
	Entries  []atomEntry `xml:"entry"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr,omitempty"`
	Type string `xml:"type,attr,omitempty"`
}

type atomAuthor struct {
	Name string `xml:"name"`
}

type atomCategory struct {
	Term string `xml:"term,attr"`
}

type atomContent struct {
	Type  string `xml:"type,attr"`
	Inner string `xml:",innerxml"`
}

type atomEntry struct {
	Title      string         `xml:"title"`
	ID         string         `xml:"id"`
	Link       atomLink       `xml:"link"`
	Published  string         `xml:"published"`
	Updated    string         `xml:"updated"`
	Summary    string         `xml:"summary"`
	Categories []atomCategory `xml:"category"`
	Content    atomContent    `xml:"content"`
}

func (s *Server) handleAtomFeed(w http.ResponseWriter, r *http.Request) {
	docs := s.filterFeedDocs("", "")
	latest := time.Now().UTC()
	if len(docs) > 0 {
		latest = docEffectiveTime(docs[0])
	}
	summaryOnly := s.isSummaryFeed(r.Context())

	entries := make([]atomEntry, 0, len(docs))
	for _, doc := range docs {
		absURL := s.absDocURL(doc)
		htmlBody := doc.RenderedHTML
		if summaryOnly {
			htmlBody = summaryFeedHTML(doc, absURL)
		}
		cats := make([]atomCategory, 0, len(doc.Tags))
		for _, t := range doc.Tags {
			cats = append(cats, atomCategory{Term: t})
		}
		entries = append(entries, atomEntry{
			Title:      doc.Title,
			ID:         absURL,
			Link:       atomLink{Href: absURL, Rel: "alternate", Type: "text/html"},
			Published:  docEffectiveTime(doc).UTC().Format(time.RFC3339),
			Updated:    doc.UpdatedAt.UTC().Format(time.RFC3339),
			Summary:    doc.Description,
			Categories: cats,
			Content: atomContent{
				Type:  "html",
				Inner: wrapCDATA(htmlBody),
			},
		})
	}

	authorName := s.cfg.AdminName
	siteName := s.effectiveSiteName(r.Context())
	if authorName == "" {
		authorName = siteName
	}

	feed := atomFeed{
		Xmlns:    "http://www.w3.org/2005/Atom",
		Title:    siteName,
		Subtitle: s.effectiveSiteDesc(r.Context()),
		ID:       s.cfg.SiteURL + "/",
		Updated:  latest.UTC().Format(time.RFC3339),
		Links: []atomLink{
			{Href: s.cfg.SiteURL + "/atom.xml", Rel: "self", Type: "application/atom+xml"},
			{Href: s.cfg.SiteURL + "/", Rel: "alternate", Type: "text/html"},
		},
		Author:  atomAuthor{Name: authorName},
		Entries: entries,
	}

	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if err := enc.Encode(feed); err != nil {
		http.Error(w, "failed to encode atom feed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

type jsonFeedDoc struct {
	Version     string         `json:"version"`
	Title       string         `json:"title"`
	Description string         `json:"description,omitempty"`
	HomePageURL string         `json:"home_page_url"`
	FeedURL     string         `json:"feed_url"`
	Language    string         `json:"language,omitempty"`
	Items       []jsonFeedItem `json:"items"`
}

type jsonFeedItem struct {
	ID            string   `json:"id"`
	URL           string   `json:"url"`
	Title         string   `json:"title"`
	Summary       string   `json:"summary,omitempty"`
	ContentHTML   string   `json:"content_html"`
	ContentText   string   `json:"content_text,omitempty"`
	DatePublished string   `json:"date_published"`
	DateModified  string   `json:"date_modified"`
	Tags          []string `json:"tags,omitempty"`
	Language      string   `json:"language,omitempty"`
}

func (s *Server) handleJSONFeed(w http.ResponseWriter, r *http.Request) {
	docs := s.filterFeedDocs("", "")
	summaryOnly := s.isSummaryFeed(r.Context())
	items := make([]jsonFeedItem, 0, len(docs))
	for _, doc := range docs {
		absURL := s.absDocURL(doc)
		htmlBody := doc.RenderedHTML
		textBody := doc.PlainText
		if summaryOnly {
			htmlBody = summaryFeedHTML(doc, absURL)
			textBody = doc.Description
		}
		items = append(items, jsonFeedItem{
			ID:            absURL,
			URL:           absURL,
			Title:         doc.Title,
			Summary:       doc.Description,
			ContentHTML:   htmlBody,
			ContentText:   textBody,
			DatePublished: docEffectiveTime(doc).UTC().Format(time.RFC3339),
			DateModified:  doc.UpdatedAt.UTC().Format(time.RFC3339),
			Tags:          doc.Tags,
			Language:      doc.Lang,
		})
	}

	payload := jsonFeedDoc{
		Version:     "https://jsonfeed.org/version/1.1",
		Title:       s.effectiveSiteName(r.Context()),
		Description: s.effectiveSiteDesc(r.Context()),
		HomePageURL: s.cfg.SiteURL + "/",
		FeedURL:     s.cfg.SiteURL + "/feed.json",
		Language:    "zh-CN",
		Items:       items,
	}

	w.Header().Set("Content-Type", "application/feed+json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func (s *Server) handleLLMsTxt(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", s.cfg.SiteName)
	fmt.Fprintf(&b, "> %s\n\n", s.cfg.SiteDescription)
	fmt.Fprintf(&b, "This site exposes machine-readable Markdown endpoints (`/{posts|notes|projects}/{slug}.md` and `Accept: text/markdown`).\n\n")
	fmt.Fprintf(&b, "## Endpoints\n\n")
	fmt.Fprintf(&b, "- [Full Markdown Corpus](%s/llms-full.txt): All published posts, notes, and projects concatenated in Markdown\n", s.cfg.SiteURL)
	fmt.Fprintf(&b, "- [OpenAPI 3.1 Specification](%s/api/openapi.json): Typed REST API contract\n", s.cfg.SiteURL)
	fmt.Fprintf(&b, "- [RSS 2.0 Feed](%s/feed.xml): Syndication feed\n", s.cfg.SiteURL)
	fmt.Fprintf(&b, "- [Atom 1.0 Feed](%s/atom.xml): Atom feed\n", s.cfg.SiteURL)
	fmt.Fprintf(&b, "- [JSON Feed 1.1](%s/feed.json): Structured JSON feed\n\n", s.cfg.SiteURL)

	sections := []struct {
		heading string
		docType content.ContentType
	}{
		{"Posts", content.TypePost},
		{"Notes", content.TypeNote},
		{"Projects", content.TypeProject},
	}

	for _, sec := range sections {
		docs := s.store.ListPublished(sec.docType)
		if len(docs) == 0 {
			continue
		}
		fmt.Fprintf(&b, "## %s\n\n", sec.heading)
		for _, doc := range docs {
			if doc.SEO.NoIndex {
				continue
			}
			mdURL := s.cfg.SiteURL + doc.CanonicalURL() + ".md"
			desc := strings.ReplaceAll(strings.TrimSpace(doc.Description), "\n", " ")
			if desc != "" {
				fmt.Fprintf(&b, "- [%s](%s): %s\n", doc.Title, mdURL, desc)
			} else {
				fmt.Fprintf(&b, "- [%s](%s)\n", doc.Title, mdURL)
			}
		}
		b.WriteByte('\n')
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

func (s *Server) handleLLMsFullTxt(w http.ResponseWriter, r *http.Request) {
	docs := s.store.ListPublished("")
	var b strings.Builder
	fmt.Fprintf(&b, "# %s — Full Corpus\n\n", s.cfg.SiteName)
	fmt.Fprintf(&b, "Site: %s\n\n", s.cfg.SiteURL)

	for _, doc := range docs {
		if doc.SEO.NoIndex {
			continue
		}
		b.WriteString("================================================================================\n")
		fmt.Fprintf(&b, "TITLE: %s\n", doc.Title)
		fmt.Fprintf(&b, "TYPE: %s\n", doc.Type)
		fmt.Fprintf(&b, "URL: %s\n", s.absDocURL(doc))
		fmt.Fprintf(&b, "MARKDOWN_URL: %s.md\n", s.absDocURL(doc))
		fmt.Fprintf(&b, "PUBLISHED: %s\n", docEffectiveTime(doc).Format("2006-01-02"))
		if len(doc.Tags) > 0 {
			fmt.Fprintf(&b, "TAGS: %s\n", strings.Join(doc.Tags, ", "))
		}
		b.WriteString("--------------------------------------------------------------------------------\n\n")
		b.WriteString(strings.TrimSpace(doc.Raw))
		b.WriteString("\n\n")
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

type sitemapURLSet struct {
	XMLName xml.Name     `xml:"urlset"`
	Xmlns   string       `xml:"xmlns,attr"`
	URLs    []sitemapURL `xml:"url"`
}

type sitemapURL struct {
	Loc        string `xml:"loc"`
	LastMod    string `xml:"lastmod,omitempty"`
	ChangeFreq string `xml:"changefreq,omitempty"`
	Priority   string `xml:"priority,omitempty"`
}

func (s *Server) handleSitemapXML(w http.ResponseWriter, r *http.Request) {
	staticRoutes := []struct {
		path     string
		freq     string
		priority string
	}{
		{"/", "daily", "1.0"},
		{"/posts", "daily", "0.9"},
		{"/notes", "daily", "0.8"},
		{"/projects", "weekly", "0.8"},
		{"/series", "weekly", "0.7"},
		{"/tags", "weekly", "0.7"},
		{"/archive", "weekly", "0.6"},
		{"/graph", "weekly", "0.6"},
		{"/friends", "weekly", "0.6"},
	}

	urls := make([]sitemapURL, 0, len(staticRoutes)+32)
	for _, sr := range staticRoutes {
		urls = append(urls, sitemapURL{
			Loc:        s.cfg.SiteURL + sr.path,
			ChangeFreq: sr.freq,
			Priority:   sr.priority,
		})
	}

	for _, doc := range s.store.ListPublished("") {
		if doc.SEO.NoIndex {
			continue
		}
		urls = append(urls, sitemapURL{
			Loc:        s.absDocURL(doc),
			LastMod:    doc.UpdatedAt.UTC().Format("2006-01-02"),
			ChangeFreq: "monthly",
			Priority:   "0.8",
		})
	}

	set := sitemapURLSet{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		URLs:  urls,
	}

	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if err := enc.Encode(set); err != nil {
		http.Error(w, "failed to encode sitemap", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) handleRobotsTxt(w http.ResponseWriter, r *http.Request) {
	body := fmt.Sprintf("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/\nDisallow: /preview/\n\nSitemap: %s/sitemap.xml\n", s.cfg.SiteURL)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

func (s *Server) serveRawMarkdown(w http.ResponseWriter, _ *http.Request, doc *content.Document) {
	canonical := s.absDocURL(doc)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Vary", "Accept")
	w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="canonical"`, canonical))
	if doc.SEO.NoIndex {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(doc.Raw))
}

func (s *Server) absDocURL(doc *content.Document) string {
	return s.cfg.SiteURL + doc.CanonicalURL()
}

func wrapCDATA(raw string) string {
	return "<![CDATA[" + strings.ReplaceAll(raw, "]]>", "]]]]><![CDATA[>") + "]]>"
}

func pathParamUnescaped(r *http.Request, key string) string {
	raw := chi.URLParam(r, key)
	if raw == "" {
		raw = r.PathValue(key)
	}
	if u, err := url.PathUnescape(raw); err == nil {
		return u
	}
	return raw
}

func limitRunes(s string, max int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= max {
		return string(r)
	}
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

func summaryFeedHTML(doc *content.Document, absURL string) string {
	desc := strings.TrimSpace(doc.Description)
	if desc == "" {
		desc = doc.Summary
	}
	if desc == "" {
		desc = limitRunes(doc.PlainText, 240)
	}
	return fmt.Sprintf("<p>%s</p><p><a href=\"%s\">阅读全文 →</a></p>",
		stdhtml.EscapeString(desc),
		stdhtml.EscapeString(absURL),
	)
}

func (s *Server) isSummaryFeed(ctx context.Context) bool {
	return strings.EqualFold(s.siteSettingString(ctx, "feed_mode", "full"), "summary")
}

func (s *Server) effectiveSiteName(ctx context.Context) string {
	return s.siteSettingString(ctx, "site_name", s.cfg.SiteName)
}

func (s *Server) effectiveSiteDesc(ctx context.Context) string {
	return s.siteSettingString(ctx, "site_description", s.cfg.SiteDescription)
}

func (s *Server) siteSettingString(ctx context.Context, key, fallback string) string {
	if s.state == nil {
		return fallback
	}
	settings, err := s.state.GetAllSettings(ctx)
	if err != nil || settings == nil {
		return fallback
	}
	raw, ok := settings[key]
	if !ok || len(raw) == 0 {
		return fallback
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil && strings.TrimSpace(str) != "" {
		return strings.TrimSpace(str)
	}
	return fallback
}

func (s *Server) siteSettingBool(ctx context.Context, key string, fallback bool) bool {
	if s.state == nil {
		return fallback
	}
	settings, err := s.state.GetAllSettings(ctx)
	if err != nil || settings == nil {
		return fallback
	}
	raw, ok := settings[key]
	if !ok || len(raw) == 0 {
		return fallback
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		return b
	}
	return fallback
}
