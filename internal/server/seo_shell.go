package server

import (
	"encoding/json"
	"fmt"
	stdhtml "html"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/graph"
)

type pageSEO struct {
	Title        string
	Description  string
	CanonicalURL string
	OGType       string
	OGImage      string
	MarkdownURL  string
	NoIndex      bool
	IncludeChroma bool
	Hreflangs    []hreflangEntry
	JSONLD       any
}

type hreflangEntry struct {
	Lang string
	Href string
}

type preloadEnvelope struct {
	RouteKind string `json:"routeKind"`
	Site      SiteInfo `json:"site"`
	Data      any    `json:"data,omitempty"`
}

func (s *Server) registerPageRoutes() {
	s.router.Get("/", s.handleHomeShell)

	s.router.Get("/posts", s.handleHubShell("posts", "Articles", "Long-form essays and engineering deep dives"))
	s.router.Get("/notes", s.handleHubShell("notes", "Notes", "Short engineering notes, TILs, and observations"))
	s.router.Get("/projects", s.handleHubShell("projects", "Projects", "Active software systems, tools, and experiments"))
	s.router.Get("/series", s.handleHubShell("series", "Series", "Multi-part technical series and guides"))
	s.router.Get("/tags", s.handleHubShell("tags", "Tags", "Browse content by topic tag"))
	s.router.Get("/archive", s.handleHubShell("archive", "Archive", "Complete timeline of published posts and notes"))
	s.router.Get("/graph", s.handleHubShell("graph", "Knowledge Graph", "Interactive map of linked essays, notes, and projects"))
	s.router.Get("/friends", s.handleHubShell("friends", "Friends & Blogroll", "Independent blogs and syndicated updates"))
	s.router.Get("/search", s.handleHubShell("search", "Search", "Full-text search across articles, notes, and projects"))

	s.router.Get("/series/{series}", s.handleParamHubShell("series"))
	s.router.Get("/tags/{tag}", s.handleParamHubShell("tag"))
	s.router.Get("/categories/{category}", s.handleParamHubShell("category"))

	s.router.Get("/posts/{slugParam}", s.handleDocumentRoute(content.TypePost))
	s.router.Get("/notes/{slugParam}", s.handleDocumentRoute(content.TypeNote))
	s.router.Get("/projects/{slugParam}", s.handleDocumentRoute(content.TypeProject))

	s.router.Get("/preview/{token}", s.handleNoIndexShell("preview", "Draft Preview"))
	s.router.Get("/admin", s.handleNoIndexShell("admin", "Admin Studio"))
	s.router.Get("/admin/*", s.handleNoIndexShell("admin", "Admin Studio"))

	s.router.NotFound(s.handleNotFound)
}

func (s *Server) handleDocumentRoute(docType content.ContentType) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slugParam := pathParamUnescaped(r, "slugParam")
		hasMdExt := strings.HasSuffix(slugParam, ".md")
		slug := slugParam
		if hasMdExt {
			slug = strings.TrimSuffix(slugParam, ".md")
		}
		wantMarkdown := hasMdExt || acceptsMarkdown(r)

		doc, found := s.store.GetPublished(docType, slug)
		if !found {
			if wantMarkdown && hasMdExt {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.Header().Set("X-Robots-Tag", "noindex, nofollow")
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("Not Found"))
				return
			}
			s.serveNotFoundShell(w, r)
			return
		}

		if wantMarkdown {
			s.serveRawMarkdown(w, r, doc)
			return
		}

		detail := s.buildDocumentDetailPayload(doc)
		canonical := s.absDocURL(doc)
		if doc.SEO.Canonical != "" {
			canonical = s.resolveAbsURL(doc.SEO.Canonical)
		}

		pageTitle := fmt.Sprintf("%s — %s", doc.Title, s.cfg.SiteName)
		if doc.SEO.Title != "" {
			pageTitle = doc.SEO.Title
		}
		pageDesc := doc.Description
		if doc.SEO.Description != "" {
			pageDesc = doc.SEO.Description
		}

		ogImage := s.cfg.SiteURL + "/api/og?type=" + url.QueryEscape(string(doc.Type)) + "&slug=" + url.QueryEscape(doc.Slug)
		if doc.SEO.OGImage != "" {
			ogImage = s.resolveAbsURL(doc.SEO.OGImage)
		} else if doc.Cover != "" {
			ogImage = s.resolveAbsURL(doc.Cover)
		}

		ogType := "article"
		if doc.Type == content.TypeProject {
			ogType = "website"
		}

		var hreflangs []hreflangEntry
		if len(detail.Context.Translations) > 0 {
			hreflangs = append(hreflangs, hreflangEntry{Lang: doc.Lang, Href: canonical})
			for _, tr := range detail.Context.Translations {
				hreflangs = append(hreflangs, hreflangEntry{
					Lang: tr.Lang,
					Href: s.cfg.SiteURL + tr.URL,
				})
			}
			hreflangs = append(hreflangs, hreflangEntry{Lang: "x-default", Href: canonical})
		}

		headers := map[string]string{
			"Vary": "Accept",
		}
		if doc.SEO.NoIndex {
			headers["X-Robots-Tag"] = "noindex, nofollow"
		}

		seo := pageSEO{
			Title:         pageTitle,
			Description:   pageDesc,
			CanonicalURL:  canonical,
			OGType:        ogType,
			OGImage:       ogImage,
			MarkdownURL:   s.absDocURL(doc) + ".md",
			NoIndex:       doc.SEO.NoIndex,
			IncludeChroma: true,
			Hreflangs:     hreflangs,
			JSONLD:        s.buildDocumentJSONLD(doc, canonical, ogImage, pageDesc),
		}

		noscriptHTML := s.buildDocumentNoscriptHTML(doc)
		preload := preloadEnvelope{
			RouteKind: "document",
			Site:      s.siteInfo(),
			Data:      detail,
		}
		s.serveShellHTML(w, http.StatusOK, seo, preload, noscriptHTML, headers)
	}
}

func (s *Server) handleHomeShell(w http.ResponseWriter, r *http.Request) {
	home := s.buildHomePayload()
	seo := pageSEO{
		Title:        fmt.Sprintf("%s — %s", s.cfg.SiteName, s.cfg.SiteDescription),
		Description:  s.cfg.SiteDescription,
		CanonicalURL: s.cfg.SiteURL + "/",
		OGType:       "website",
		OGImage:      s.cfg.SiteURL + "/api/og?title=" + url.QueryEscape(s.cfg.SiteName),
		JSONLD: map[string]any{
			"@context":    "https://schema.org",
			"@type":       "WebSite",
			"name":        s.cfg.SiteName,
			"description": s.cfg.SiteDescription,
			"url":         s.cfg.SiteURL + "/",
			"potentialAction": map[string]any{
				"@type":       "SearchAction",
				"target":      s.cfg.SiteURL + "/search?q={search_term_string}",
				"query-input": "required name=search_term_string",
			},
		},
	}

	noscriptHTML := s.buildHomeNoscriptHTML(home)
	preload := preloadEnvelope{
		RouteKind: "home",
		Site:      s.siteInfo(),
		Data:      home,
	}
	s.serveShellHTML(w, http.StatusOK, seo, preload, noscriptHTML, nil)
}

func (s *Server) handleHubShell(routeKind, heading, desc string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		canonical := s.cfg.SiteURL + r.URL.Path
		seo := pageSEO{
			Title:        fmt.Sprintf("%s — %s", heading, s.cfg.SiteName),
			Description:  desc,
			CanonicalURL: canonical,
			OGType:       "website",
			OGImage:      s.cfg.SiteURL + "/api/og?title=" + url.QueryEscape(heading) + "&description=" + url.QueryEscape(desc),
		}
		noscript := fmt.Sprintf("<main><h1>%s</h1><p>%s</p><p><a href=\"/\">%s</a></p></main>",
			stdhtml.EscapeString(heading), stdhtml.EscapeString(desc), stdhtml.EscapeString(s.cfg.SiteName))
		preload := preloadEnvelope{
			RouteKind: routeKind,
			Site:      s.siteInfo(),
		}
		s.serveShellHTML(w, http.StatusOK, seo, preload, noscript, nil)
	}
}

func (s *Server) handleParamHubShell(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var label string
		switch kind {
		case "series":
			label = pathParamUnescaped(r, "series")
		case "tag":
			label = pathParamUnescaped(r, "tag")
		case "category":
			label = pathParamUnescaped(r, "category")
		}
		title := fmt.Sprintf("%s · %s — %s", capitalizeASCII(kind), label, s.cfg.SiteName)
		desc := fmt.Sprintf("Browse %s %q on %s", kind, label, s.cfg.SiteName)
		canonical := s.cfg.SiteURL + r.URL.Path
		seo := pageSEO{
			Title:        title,
			Description:  desc,
			CanonicalURL: canonical,
			OGType:       "website",
			OGImage:      s.cfg.SiteURL + "/api/og?type=" + url.QueryEscape(kind) + "&title=" + url.QueryEscape(label),
		}
		noscript := fmt.Sprintf("<main><h1>%s: %s</h1><p>%s</p></main>",
			stdhtml.EscapeString(kind), stdhtml.EscapeString(label), stdhtml.EscapeString(desc))
		preload := preloadEnvelope{
			RouteKind: kind + "-detail",
			Site:      s.siteInfo(),
			Data:      map[string]string{kind: label},
		}
		s.serveShellHTML(w, http.StatusOK, seo, preload, noscript, nil)
	}
}

func (s *Server) handleNoIndexShell(routeKind, heading string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		seo := pageSEO{
			Title:         fmt.Sprintf("%s — %s", heading, s.cfg.SiteName),
			Description:   s.cfg.SiteDescription,
			NoIndex:       true,
			IncludeChroma: routeKind == "preview",
		}
		headers := map[string]string{
			"X-Robots-Tag":  "noindex, nofollow",
			"Cache-Control": "no-store",
		}
		noscript := fmt.Sprintf("<main><h1>%s</h1></main>", stdhtml.EscapeString(heading))
		preload := preloadEnvelope{
			RouteKind: routeKind,
			Site:      s.siteInfo(),
		}
		s.serveShellHTML(w, http.StatusOK, seo, preload, noscript, headers)
	}
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"title":"Not Found","status":404,"detail":"endpoint not found"}`))
		return
	}
	s.serveNotFoundShell(w, r)
}

func (s *Server) serveNotFoundShell(w http.ResponseWriter, r *http.Request) {
	seo := pageSEO{
		Title:       fmt.Sprintf("404 Not Found — %s", s.cfg.SiteName),
		Description: "The requested page could not be found.",
		NoIndex:     true,
	}
	headers := map[string]string{
		"X-Robots-Tag": "noindex, nofollow",
	}
	noscript := fmt.Sprintf("<main><h1>404 Not Found</h1><p>The page <code>%s</code> does not exist.</p><p><a href=\"/\">Return Home</a></p></main>",
		stdhtml.EscapeString(r.URL.Path))
	preload := preloadEnvelope{
		RouteKind: "not-found",
		Site:      s.siteInfo(),
	}
	s.serveShellHTML(w, http.StatusNotFound, seo, preload, noscript, headers)
}

func (s *Server) serveShellHTML(w http.ResponseWriter, status int, seo pageSEO, preload preloadEnvelope, noscriptHTML string, extraHeaders map[string]string) {
	for k, v := range extraHeaders {
		w.Header().Set(k, v)
	}

	headHTML := s.renderSEOHead(seo)
	preloadScript := renderPreloadScript(preload)

	var out strings.Builder
	out.Grow(len(s.shell.beforeHead) + len(headHTML) + len(s.shell.headToNoscript) + len(noscriptHTML) + len(s.shell.noscriptToPre) + len(preloadScript) + len(s.shell.afterPreload) + 64)
	out.WriteString(s.shell.beforeHead)
	out.WriteString(headHTML)
	out.WriteString(s.shell.headToNoscript)
	out.WriteString(noscriptHTML)
	out.WriteString(s.shell.noscriptToPre)
	out.WriteString(preloadScript)
	out.WriteString(s.shell.afterPreload)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(out.String()))
}

func (s *Server) renderSEOHead(seo pageSEO) string {
	var b strings.Builder
	fmt.Fprintf(&b, "<title>%s</title>\n", stdhtml.EscapeString(seo.Title))
	if seo.Description != "" {
		fmt.Fprintf(&b, `    <meta name="description" content="%s" />`+"\n", stdhtml.EscapeString(seo.Description))
	}
	if seo.NoIndex {
		b.WriteString(`    <meta name="robots" content="noindex, nofollow" />` + "\n")
	}
	if seo.CanonicalURL != "" {
		fmt.Fprintf(&b, `    <link rel="canonical" href="%s" />`+"\n", stdhtml.EscapeString(seo.CanonicalURL))
	}
	if seo.MarkdownURL != "" {
		fmt.Fprintf(&b, `    <link rel="alternate" type="text/markdown" title="Markdown Source" href="%s" />`+"\n", stdhtml.EscapeString(seo.MarkdownURL))
	}
	for _, hl := range seo.Hreflangs {
		fmt.Fprintf(&b, `    <link rel="alternate" hreflang="%s" href="%s" />`+"\n", stdhtml.EscapeString(hl.Lang), stdhtml.EscapeString(hl.Href))
	}
	if seo.IncludeChroma {
		b.WriteString(`    <link rel="stylesheet" href="/api/chroma.css" />` + "\n")
	}
	if seo.OGType != "" {
		fmt.Fprintf(&b, `    <meta property="og:type" content="%s" />`+"\n", stdhtml.EscapeString(seo.OGType))
		fmt.Fprintf(&b, `    <meta property="og:site_name" content="%s" />`+"\n", stdhtml.EscapeString(s.cfg.SiteName))
		fmt.Fprintf(&b, `    <meta property="og:title" content="%s" />`+"\n", stdhtml.EscapeString(seo.Title))
		if seo.Description != "" {
			fmt.Fprintf(&b, `    <meta property="og:description" content="%s" />`+"\n", stdhtml.EscapeString(seo.Description))
		}
		if seo.CanonicalURL != "" {
			fmt.Fprintf(&b, `    <meta property="og:url" content="%s" />`+"\n", stdhtml.EscapeString(seo.CanonicalURL))
		}
		if seo.OGImage != "" {
			fmt.Fprintf(&b, `    <meta property="og:image" content="%s" />`+"\n", stdhtml.EscapeString(seo.OGImage))
			fmt.Fprintf(&b, `    <meta name="twitter:card" content="summary_large_image" />`+"\n")
			fmt.Fprintf(&b, `    <meta name="twitter:title" content="%s" />`+"\n", stdhtml.EscapeString(seo.Title))
			if seo.Description != "" {
				fmt.Fprintf(&b, `    <meta name="twitter:description" content="%s" />`+"\n", stdhtml.EscapeString(seo.Description))
			}
			fmt.Fprintf(&b, `    <meta name="twitter:image" content="%s" />`+"\n", stdhtml.EscapeString(seo.OGImage))
		}
	}
	if seo.JSONLD != nil {
		if rawJSON, err := marshalScriptSafeJSON(seo.JSONLD); err == nil {
			b.WriteString(`    <script type="application/ld+json">`)
			b.Write(rawJSON)
			b.WriteString(`</script>` + "\n")
		}
	}
	return b.String()
}

func renderPreloadScript(preload preloadEnvelope) string {
	raw, err := marshalScriptSafeJSON(preload)
	if err != nil {
		return ""
	}
	return `<script>window.__INKBRANCH_DATA__ = ` + string(raw) + `;</script>`
}

func marshalScriptSafeJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	// Neutralize closing script tags and Unicode line/paragraph separators inside inline <script>.
	s := string(raw)
	s = strings.ReplaceAll(s, "</", `<\/`)
	s = strings.ReplaceAll(s, "\u2028", `\u2028`)
	s = strings.ReplaceAll(s, "\u2029", `\u2029`)
	return []byte(s), nil
}

func (s *Server) buildDocumentJSONLD(doc *content.Document, canonical, ogImage, desc string) map[string]any {
	authorName := s.cfg.AdminName
	if authorName == "" {
		authorName = s.cfg.SiteName
	}

	sectionLabel := "Posts"
	sectionURL := s.cfg.SiteURL + "/posts"
	entityType := "BlogPosting"
	switch doc.Type {
	case content.TypeNote:
		sectionLabel = "Notes"
		sectionURL = s.cfg.SiteURL + "/notes"
	case content.TypeProject:
		sectionLabel = "Projects"
		sectionURL = s.cfg.SiteURL + "/projects"
		entityType = "SoftwareSourceCode"
	}

	mainEntity := map[string]any{
		"@type":         entityType,
		"@id":           canonical + "#primary",
		"headline":      doc.Title,
		"name":          doc.Title,
		"description":   desc,
		"url":           canonical,
		"inLanguage":    doc.Lang,
		"datePublished": docEffectiveTime(doc).UTC().Format("2006-01-02T15:04:05Z"),
		"dateModified":  doc.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		"author": map[string]any{
			"@type": "Person",
			"name":  authorName,
		},
		"publisher": map[string]any{
			"@type": "Organization",
			"name":  s.cfg.SiteName,
		},
		"image": ogImage,
	}
	if len(doc.Tags) > 0 {
		mainEntity["keywords"] = strings.Join(doc.Tags, ", ")
	}
	if doc.Type == content.TypeProject && doc.RepoURL != "" {
		mainEntity["codeRepository"] = doc.RepoURL
	}

	breadcrumb := map[string]any{
		"@type": "BreadcrumbList",
		"itemListElement": []map[string]any{
			{
				"@type":    "ListItem",
				"position": 1,
				"name":     s.cfg.SiteName,
				"item":     s.cfg.SiteURL + "/",
			},
			{
				"@type":    "ListItem",
				"position": 2,
				"name":     sectionLabel,
				"item":     sectionURL,
			},
			{
				"@type":    "ListItem",
				"position": 3,
				"name":     doc.Title,
				"item":     canonical,
			},
		},
	}

	return map[string]any{
		"@context": "https://schema.org",
		"@graph":   []any{mainEntity, breadcrumb},
	}
}

func (s *Server) buildDocumentNoscriptHTML(doc *content.Document) string {
	var b strings.Builder
	b.WriteString(`<article class="inkbranch-noscript-article">`)
	fmt.Fprintf(&b, `<h1>%s</h1>`, stdhtml.EscapeString(doc.Title))
	if doc.Description != "" {
		fmt.Fprintf(&b, `<p>%s</p>`, stdhtml.EscapeString(doc.Description))
	}
	fmt.Fprintf(&b, `<p><time>%s</time> · %d min read</p>`,
		docEffectiveTime(doc).Format("2006-01-02"), doc.ReadingMinutes)
	b.WriteString(doc.RenderedHTML)
	b.WriteString(`</article>`)
	return b.String()
}

func (s *Server) buildHomeNoscriptHTML(home HomeBody) string {
	var b strings.Builder
	b.WriteString(`<main>`)
	fmt.Fprintf(&b, `<h1>%s</h1><p>%s</p>`,
		stdhtml.EscapeString(home.Site.Name), stdhtml.EscapeString(home.Site.Description))
	if len(home.RecentPosts) > 0 {
		b.WriteString(`<h2>Recent Posts</h2><ul>`)
		for _, p := range home.RecentPosts {
			fmt.Fprintf(&b, `<li><a href="%s">%s</a> — %s</li>`,
				stdhtml.EscapeString(p.URL), stdhtml.EscapeString(p.Title), stdhtml.EscapeString(p.Description))
		}
		b.WriteString(`</ul>`)
	}
	if len(home.RecentNotes) > 0 {
		b.WriteString(`<h2>Recent Notes</h2><ul>`)
		for _, n := range home.RecentNotes {
			fmt.Fprintf(&b, `<li><a href="%s">%s</a></li>`,
				stdhtml.EscapeString(n.URL), stdhtml.EscapeString(n.Title))
		}
		b.WriteString(`</ul>`)
	}
	if len(home.ActiveProjects) > 0 {
		b.WriteString(`<h2>Projects</h2><ul>`)
		for _, pr := range home.ActiveProjects {
			fmt.Fprintf(&b, `<li><a href="%s">%s</a> — %s</li>`,
				stdhtml.EscapeString(pr.URL), stdhtml.EscapeString(pr.Title), stdhtml.EscapeString(pr.Description))
		}
		b.WriteString(`</ul>`)
	}
	b.WriteString(`</main>`)
	return b.String()
}

func (s *Server) siteInfo() SiteInfo {
	return SiteInfo{
		Name:        s.cfg.SiteName,
		Description: s.cfg.SiteDescription,
		URL:         s.cfg.SiteURL,
	}
}

func (s *Server) resolveAbsURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "https://") || strings.HasPrefix(trimmed, "http://") {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "/") {
		return s.cfg.SiteURL + trimmed
	}
	return s.cfg.SiteURL + "/" + trimmed
}

// acceptsMarkdown determines whether HTTP Accept prefers text/markdown over text/html.
func acceptsMarkdown(r *http.Request) bool {
	accept := strings.ToLower(strings.TrimSpace(r.Header.Get("Accept")))
	if accept == "" {
		return false
	}
	var mdQ float64 = -1
	var htmlQ float64 = -1
	for _, item := range strings.Split(accept, ",") {
		parts := strings.Split(strings.TrimSpace(item), ";")
		mediaType := strings.TrimSpace(parts[0])
		q := 1.0
		for _, param := range parts[1:] {
			kv := strings.SplitN(strings.TrimSpace(param), "=", 2)
			if len(kv) == 2 && strings.TrimSpace(kv[0]) == "q" {
				if parsed, err := strconv.ParseFloat(strings.TrimSpace(kv[1]), 64); err == nil {
					q = parsed
				}
			}
		}
		switch mediaType {
		case "text/markdown", "text/x-markdown":
			if q > mdQ {
				mdQ = q
			}
		case "text/html":
			if q > htmlQ {
				htmlQ = q
			}
		}
	}
	return mdQ > 0 && mdQ >= htmlQ
}

func capitalizeASCII(s string) string {
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// Ensure graph package remains directly tied to DocumentContext contract.
var _ = graph.DocumentContext{}
