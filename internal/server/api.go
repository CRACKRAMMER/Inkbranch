package server

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/db"
	"github.com/CRACKRAMMER/Inkbranch/internal/graph"
	"github.com/CRACKRAMMER/Inkbranch/internal/search"
	"github.com/danielgtaylor/huma/v2"
)

// DatabaseHealth summarizes PostgreSQL pool readiness for health probes.
type DatabaseHealth struct {
	Configured bool  `json:"configured"`
	OK         bool  `json:"ok"`
	LatencyMs  int64 `json:"latencyMs"`
}

// ContentHealth summarizes loaded content counts and frontmatter validation errors.
type ContentHealth struct {
	Scanned          int      `json:"scanned"`
	Published        int      `json:"published"`
	ValidationErrors []string `json:"validationErrors"`
}

// HealthBody is returned by /api/health and /api/v1/health.
type HealthBody struct {
	Status        string         `json:"status"`
	Version       string         `json:"version"`
	Database      DatabaseHealth `json:"database"`
	Content       ContentHealth  `json:"content"`
	StorageDriver string         `json:"storageDriver"`
	Timestamp     string         `json:"timestamp"`
}

// SiteInfo exposes public site identity fields.
type SiteInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
}

// ContentSummary represents a list/card view of a published document.
type ContentSummary struct {
	Type           content.ContentType   `json:"type"`
	Slug           string                `json:"slug"`
	Title          string                `json:"title"`
	Description    string                `json:"description"`
	Summary        string                `json:"summary,omitempty"`
	Status         content.ContentStatus `json:"status"`
	Category       string                `json:"category,omitempty"`
	Tags           []string              `json:"tags"`
	Series         string                `json:"series,omitempty"`
	SeriesOrder    *int                  `json:"seriesOrder,omitempty"`
	Lang           string                `json:"lang"`
	TranslationKey string                `json:"translationKey,omitempty"`
	PublishedAt    string                `json:"publishedAt,omitempty"`
	UpdatedAt      string                `json:"updatedAt"`
	Cover          string                `json:"cover,omitempty"`
	Featured       bool                  `json:"featured"`
	WordCount      int                   `json:"wordCount"`
	ReadingMinutes int                   `json:"readingMinutes"`
	URL            string                `json:"url"`
	MarkdownURL    string                `json:"markdownUrl"`
	ProjectStatus  content.ProjectStatus `json:"projectStatus,omitempty"`
	RepoURL        string                `json:"repoUrl,omitempty"`
	WebsiteURL     string                `json:"websiteUrl,omitempty"`
	TechStack      []string              `json:"stack,omitempty"`
}

// ContentDetail includes full rendered HTML, headings TOC, raw Markdown, and metadata.
type ContentDetail struct {
	ContentSummary
	RenderedHTML    string                 `json:"renderedHtml"`
	RawMarkdown     string                 `json:"rawMarkdown,omitempty"`
	Headings        []content.Heading      `json:"headings"`
	TOCEnabled      bool                   `json:"tocEnabled"`
	CommentsEnabled bool                   `json:"commentsEnabled"`
	SEO             content.SEOMetadata    `json:"seo"`
	OutgoingLinks   []content.OutgoingLink `json:"outgoingLinks"`
}

// ContentDetailBody bundles a document and its knowledge-graph context.
type ContentDetailBody struct {
	Document ContentDetail         `json:"document"`
	Context  graph.DocumentContext `json:"context"`
}

// TagSummary represents one tag bucket across published documents.
type TagSummary struct {
	Name  string `json:"name"`
	Slug  string `json:"slug"`
	Count int    `json:"count"`
}

// HomeCounts provides collection counts shown in home/hub hero widgets.
type HomeCounts struct {
	Posts    int `json:"posts"`
	Notes    int `json:"notes"`
	Projects int `json:"projects"`
	Tags     int `json:"tags"`
	Series   int `json:"series"`
}

// HomeBody powers the homepage Bento showcase and preloaded SSR shell.
type HomeBody struct {
	Site           SiteInfo         `json:"site"`
	FeaturedPost   *ContentSummary  `json:"featuredPost,omitempty"`
	RecentPosts    []ContentSummary `json:"recentPosts"`
	RecentNotes    []ContentSummary `json:"recentNotes"`
	ActiveProjects []ContentSummary `json:"activeProjects"`
	PopularTags    []TagSummary     `json:"popularTags"`
	Counts         HomeCounts       `json:"counts"`
}

// ContentListBody returns paginated public documents.
type ContentListBody struct {
	Total  int              `json:"total"`
	Limit  int              `json:"limit"`
	Offset int              `json:"offset"`
	Items  []ContentSummary `json:"items"`
}

// TagListBody returns aggregated tag counts.
type TagListBody struct {
	Items []TagSummary `json:"items"`
}

// SeriesSummary describes a multi-part series collection.
type SeriesSummary struct {
	Name     string              `json:"name"`
	Slug     string              `json:"slug"`
	Count    int                 `json:"count"`
	LatestAt string              `json:"latestAt,omitempty"`
	Items    []graph.SeriesEntry `json:"items"`
}

// SeriesListBody returns all published series sorted by freshness.
type SeriesListBody struct {
	Items []SeriesSummary `json:"items"`
}

// ArchiveYearGroup groups published posts & notes under a calendar year.
type ArchiveYearGroup struct {
	Year  int              `json:"year"`
	Items []ContentSummary `json:"items"`
}

// ArchiveBody returns chronological archive groups.
type ArchiveBody struct {
	Total int                `json:"total"`
	Years []ArchiveYearGroup `json:"years"`
}

type healthOut struct {
	Body HealthBody
}

type homeOut struct {
	Body HomeBody
}

type contentListInput struct {
	Type     string `query:"type" doc:"Filter by post, note, or project"`
	Tag      string `query:"tag" doc:"Filter by tag name or slug"`
	Category string `query:"category" doc:"Filter by category name"`
	Series   string `query:"series" doc:"Filter by series name or slug"`
	Lang     string `query:"lang" doc:"Filter by language code"`
	Featured string `query:"featured" doc:"Set true or false to filter featured items"`
	Limit    int    `query:"limit" doc:"Maximum items per page (1-100)"`
	Offset   int    `query:"offset" doc:"Zero-based pagination offset"`
}

type contentListOut struct {
	Body ContentListBody
}

type contentDetailInput struct {
	Type string `path:"type" doc:"Collection type (post/posts, note/notes, project/projects)"`
	Slug string `path:"slug" doc:"Document slug"`
}

type contentDetailOut struct {
	Body ContentDetailBody
}

type tagListOut struct {
	Body TagListBody
}

type seriesListOut struct {
	Body SeriesListBody
}

type seriesDetailInput struct {
	Series string `path:"series" doc:"Series slug or name"`
}

type seriesDetailOut struct {
	Body SeriesSummary
}

type archiveOut struct {
	Body ArchiveBody
}

type searchInput struct {
	Q        string `query:"q" doc:"Search query string (CJK + English)"`
	Type     string `query:"type" doc:"Optional collection filter"`
	Tag      string `query:"tag" doc:"Optional tag filter"`
	Category string `query:"category" doc:"Optional category filter"`
	Lang     string `query:"lang" doc:"Optional language filter"`
	Limit    int    `query:"limit" doc:"Max hits (1-100)"`
	Offset   int    `query:"offset" doc:"Pagination offset"`
}

type searchOut struct {
	Body search.Response
}

type graphInput struct {
	Type string `query:"type" doc:"Optional node type filter"`
	Tag  string `query:"tag" doc:"Optional tag filter"`
}

type graphOut struct {
	Body graph.GlobalGraph
}

func (s *Server) registerAPIRoutes() {
	healthHandler := func(ctx context.Context, _ *struct{}) (*healthOut, error) {
		return &healthOut{Body: s.buildHealthPayload(ctx)}, nil
	}

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-health",
		Method:      http.MethodGet,
		Path:        "/api/health",
		Summary:     "Service health check",
		Tags:        []string{"System"},
	}, healthHandler)

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-health",
		Method:      http.MethodGet,
		Path:        "/api/v1/health",
		Summary:     "Service health check (v1)",
		Tags:        []string{"System"},
	}, healthHandler)

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-home",
		Method:      http.MethodGet,
		Path:        "/api/v1/home",
		Summary:     "Homepage Bento & showcase payload",
		Tags:        []string{"Public"},
	}, func(_ context.Context, _ *struct{}) (*homeOut, error) {
		return &homeOut{Body: s.buildHomePayload()}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "list-v1-content",
		Method:      http.MethodGet,
		Path:        "/api/v1/content",
		Summary:     "List published documents with filters",
		Tags:        []string{"Public"},
	}, func(_ context.Context, in *contentListInput) (*contentListOut, error) {
		return &contentListOut{Body: s.queryContentList(in)}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-content-detail",
		Method:      http.MethodGet,
		Path:        "/api/v1/content/{type}/{slug}",
		Summary:     "Get full published document and knowledge graph context",
		Tags:        []string{"Public"},
	}, func(_ context.Context, in *contentDetailInput) (*contentDetailOut, error) {
		ct, ok := parseContentTypeFilter(in.Type)
		if !ok {
			return nil, huma.Error404NotFound("unsupported content type")
		}
		doc, found := s.store.GetPublished(ct, in.Slug)
		if !found {
			return nil, huma.Error404NotFound("content not found")
		}
		return &contentDetailOut{Body: s.buildDocumentDetailPayload(doc)}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "list-v1-tags",
		Method:      http.MethodGet,
		Path:        "/api/v1/tags",
		Summary:     "List aggregated tags across published documents",
		Tags:        []string{"Public"},
	}, func(_ context.Context, _ *struct{}) (*tagListOut, error) {
		return &tagListOut{Body: TagListBody{Items: s.collectTags()}}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "list-v1-series",
		Method:      http.MethodGet,
		Path:        "/api/v1/series",
		Summary:     "List series collections",
		Tags:        []string{"Public"},
	}, func(_ context.Context, _ *struct{}) (*seriesListOut, error) {
		return &seriesListOut{Body: SeriesListBody{Items: s.collectSeries()}}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-series-detail",
		Method:      http.MethodGet,
		Path:        "/api/v1/series/{series}",
		Summary:     "Get single series collection by slug or name",
		Tags:        []string{"Public"},
	}, func(_ context.Context, in *seriesDetailInput) (*seriesDetailOut, error) {
		seriesKey := strings.TrimSpace(in.Series)
		targetSlug := content.Slugify(seriesKey, "series")
		for _, item := range s.collectSeries() {
			if item.Slug == seriesKey || item.Slug == targetSlug || strings.EqualFold(item.Name, seriesKey) {
				return &seriesDetailOut{Body: item}, nil
			}
		}
		return nil, huma.Error404NotFound("series not found")
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-archive",
		Method:      http.MethodGet,
		Path:        "/api/v1/archive",
		Summary:     "Chronological archive grouped by year",
		Tags:        []string{"Public"},
	}, func(_ context.Context, _ *struct{}) (*archiveOut, error) {
		return &archiveOut{Body: s.buildArchivePayload()}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "search-v1-content",
		Method:      http.MethodGet,
		Path:        "/api/v1/search",
		Summary:     "BM25F CJK + Latin full-text search",
		Tags:        []string{"Public"},
	}, func(_ context.Context, in *searchInput) (*searchOut, error) {
		var ct content.ContentType
		if strings.TrimSpace(in.Type) != "" {
			parsed, ok := parseContentTypeFilter(in.Type)
			if !ok {
				return &searchOut{Body: search.Response{Query: strings.TrimSpace(in.Q), Total: 0, Hits: []search.Hit{}}}, nil
			}
			ct = parsed
		}
		res := search.Search(s.store.ListPublished(""), search.QueryOptions{
			Query:    in.Q,
			Type:     ct,
			Tag:      in.Tag,
			Category: in.Category,
			Lang:     in.Lang,
			Limit:    in.Limit,
			Offset:   in.Offset,
		})
		if res.Hits == nil {
			res.Hits = []search.Hit{}
		}
		for i := range res.Hits {
			if res.Hits[i].Tags == nil {
				res.Hits[i].Tags = []string{}
			}
		}
		return &searchOut{Body: res}, nil
	})

	huma.Register(s.humaAPI, huma.Operation{
		OperationID: "get-v1-graph",
		Method:      http.MethodGet,
		Path:        "/api/v1/graph",
		Summary:     "Knowledge graph nodes and weighted edges",
		Tags:        []string{"Public"},
	}, func(_ context.Context, in *graphInput) (*graphOut, error) {
		var ct content.ContentType
		if strings.TrimSpace(in.Type) != "" {
			parsed, ok := parseContentTypeFilter(in.Type)
			if !ok {
				return &graphOut{Body: graph.GlobalGraph{Nodes: []graph.GraphNode{}, Edges: []graph.GraphEdge{}}}, nil
			}
			ct = parsed
		}
		g := graph.BuildGlobalGraph(s.store.ListPublished(""), ct, strings.TrimSpace(in.Tag))
		normalizeGraph(&g)
		return &graphOut{Body: g}, nil
	})
}

func (s *Server) buildHealthPayload(ctx context.Context) HealthBody {
	scanned, published := s.store.Stats()
	valErrs := s.store.ValidationErrors()
	errMsgs := make([]string, 0, len(valErrs))
	for _, ve := range valErrs {
		errMsgs = append(errMsgs, ve.Error())
	}

	dbConfigured := s.pool != nil
	dbOK := false
	var dbLatency int64
	if dbConfigured {
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		dbOK, dbLatency, _ = db.Ping(pingCtx, s.pool)
		cancel()
	}

	status := "ok"
	if dbConfigured && !dbOK {
		status = "degraded"
	}

	return HealthBody{
		Status:  status,
		Version: s.version,
		Database: DatabaseHealth{
			Configured: dbConfigured,
			OK:         dbOK,
			LatencyMs:  dbLatency,
		},
		Content: ContentHealth{
			Scanned:          scanned,
			Published:        published,
			ValidationErrors: errMsgs,
		},
		StorageDriver: s.cfg.StorageDriver,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
	}
}

func (s *Server) buildHomePayload() HomeBody {
	posts := s.store.ListPublished(content.TypePost)
	notes := s.store.ListPublished(content.TypeNote)
	projects := s.store.ListPublished(content.TypeProject)
	tags := s.collectTags()
	series := s.collectSeries()

	var featuredPost *ContentSummary
	for _, p := range posts {
		if p.Featured {
			sum := toContentSummary(p)
			featuredPost = &sum
			break
		}
	}
	if featuredPost == nil && len(posts) > 0 {
		sum := toContentSummary(posts[0])
		featuredPost = &sum
	}

	recentPosts := make([]ContentSummary, 0, minInt(len(posts), 8))
	for i := 0; i < len(posts) && i < 8; i++ {
		recentPosts = append(recentPosts, toContentSummary(posts[i]))
	}

	recentNotes := make([]ContentSummary, 0, minInt(len(notes), 6))
	for i := 0; i < len(notes) && i < 6; i++ {
		recentNotes = append(recentNotes, toContentSummary(notes[i]))
	}

	sortedProjects := make([]*content.Document, len(projects))
	copy(sortedProjects, projects)
	sort.SliceStable(sortedProjects, func(i, j int) bool {
		return projectRank(sortedProjects[i].ProjectStatus) < projectRank(sortedProjects[j].ProjectStatus)
	})
	activeProjects := make([]ContentSummary, 0, minInt(len(sortedProjects), 6))
	for i := 0; i < len(sortedProjects) && i < 6; i++ {
		activeProjects = append(activeProjects, toContentSummary(sortedProjects[i]))
	}

	popularTags := make([]TagSummary, 0, minInt(len(tags), 16))
	for i := 0; i < len(tags) && i < 16; i++ {
		popularTags = append(popularTags, tags[i])
	}

	return HomeBody{
		Site: SiteInfo{
			Name:        s.cfg.SiteName,
			Description: s.cfg.SiteDescription,
			URL:         s.cfg.SiteURL,
		},
		FeaturedPost:   featuredPost,
		RecentPosts:    recentPosts,
		RecentNotes:    recentNotes,
		ActiveProjects: activeProjects,
		PopularTags:    popularTags,
		Counts: HomeCounts{
			Posts:    len(posts),
			Notes:    len(notes),
			Projects: len(projects),
			Tags:     len(tags),
			Series:   len(series),
		},
	}
}

func (s *Server) queryContentList(in *contentListInput) ContentListBody {
	limit := in.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	offset := in.Offset
	if offset < 0 {
		offset = 0
	}

	var docType content.ContentType
	if strings.TrimSpace(in.Type) != "" {
		parsed, ok := parseContentTypeFilter(in.Type)
		if !ok {
			return ContentListBody{Total: 0, Limit: limit, Offset: offset, Items: []ContentSummary{}}
		}
		docType = parsed
	}

	var wantFeatured *bool
	switch strings.ToLower(strings.TrimSpace(in.Featured)) {
	case "true", "1", "yes":
		b := true
		wantFeatured = &b
	case "false", "0", "no":
		b := false
		wantFeatured = &b
	}

	wantTag := strings.TrimSpace(in.Tag)
	wantCat := strings.TrimSpace(in.Category)
	wantSeries := strings.TrimSpace(in.Series)
	wantLang := strings.TrimSpace(in.Lang)

	docs := s.store.ListPublished(docType)
	var filtered []*content.Document
	for _, doc := range docs {
		if wantCat != "" && !strings.EqualFold(doc.Category, wantCat) && content.Slugify(doc.Category, "cat") != content.Slugify(wantCat, "cat") {
			continue
		}
		if wantSeries != "" && !strings.EqualFold(doc.Series, wantSeries) && content.Slugify(doc.Series, "series") != content.Slugify(wantSeries, "series") {
			continue
		}
		if wantLang != "" && !strings.EqualFold(doc.Lang, wantLang) {
			continue
		}
		if wantFeatured != nil && doc.Featured != *wantFeatured {
			continue
		}
		if wantTag != "" && !docHasTag(doc.Tags, wantTag) {
			continue
		}
		filtered = append(filtered, doc)
	}

	total := len(filtered)
	items := make([]ContentSummary, 0)
	if offset < total {
		end := offset + limit
		if end > total {
			end = total
		}
		for _, doc := range filtered[offset:end] {
			items = append(items, toContentSummary(doc))
		}
	}

	return ContentListBody{
		Total:  total,
		Limit:  limit,
		Offset: offset,
		Items:  items,
	}
}

func (s *Server) buildDocumentDetailPayload(doc *content.Document) ContentDetailBody {
	allPublished := s.store.ListPublished("")
	docCtx := graph.BuildDocumentContext(doc, allPublished)
	normalizeGraph(&docCtx.LocalGraph)
	if docCtx.Backlinks == nil {
		docCtx.Backlinks = []graph.BacklinkItem{}
	}
	if docCtx.Related == nil {
		docCtx.Related = []graph.RelatedItem{}
	}
	if docCtx.Translations == nil {
		docCtx.Translations = []graph.TranslationSibling{}
	}
	if docCtx.SeriesNav != nil && docCtx.SeriesNav.Items == nil {
		docCtx.SeriesNav.Items = []graph.SeriesEntry{}
	}

	headings := doc.Headings
	if headings == nil {
		headings = []content.Heading{}
	}
	links := doc.OutgoingLinks
	if links == nil {
		links = []content.OutgoingLink{}
	}

	return ContentDetailBody{
		Document: ContentDetail{
			ContentSummary:  toContentSummary(doc),
			RenderedHTML:    doc.RenderedHTML,
			RawMarkdown:     doc.Raw,
			Headings:        headings,
			TOCEnabled:      doc.TOCEnabled,
			CommentsEnabled: doc.Comments,
			SEO:             doc.SEO,
			OutgoingLinks:   links,
		},
		Context: docCtx,
	}
}

func (s *Server) collectTags() []TagSummary {
	docs := s.store.ListPublished("")
	counts := make(map[string]*TagSummary)
	for _, doc := range docs {
		seenDoc := make(map[string]struct{})
		for _, rawTag := range doc.Tags {
			slug := content.TagSlug(rawTag)
			if _, ok := seenDoc[slug]; ok {
				continue
			}
			seenDoc[slug] = struct{}{}
			if existing, ok := counts[slug]; ok {
				existing.Count++
			} else {
				counts[slug] = &TagSummary{
					Name:  rawTag,
					Slug:  slug,
					Count: 1,
				}
			}
		}
	}
	out := make([]TagSummary, 0, len(counts))
	for _, t := range counts {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

func (s *Server) collectSeries() []SeriesSummary {
	docs := s.store.ListPublished("")
	grouped := make(map[string][]*content.Document)
	displayName := make(map[string]string)

	for _, doc := range docs {
		if strings.TrimSpace(doc.Series) == "" {
			continue
		}
		slug := content.Slugify(doc.Series, "series")
		grouped[slug] = append(grouped[slug], doc)
		if displayName[slug] == "" {
			displayName[slug] = doc.Series
		}
	}

	out := make([]SeriesSummary, 0, len(grouped))
	for slug, members := range grouped {
		sort.Slice(members, func(i, j int) bool {
			oi := seriesOrderValue(members[i])
			oj := seriesOrderValue(members[j])
			if oi != oj {
				return oi < oj
			}
			ti := docEffectiveTime(members[i])
			tj := docEffectiveTime(members[j])
			if !ti.Equal(tj) {
				return ti.Before(tj)
			}
			return members[i].Slug < members[j].Slug
		})

		entries := make([]graph.SeriesEntry, 0, len(members))
		var latest time.Time
		for idx, m := range members {
			ord := idx + 1
			if m.SeriesOrder != nil {
				ord = *m.SeriesOrder
			}
			entries = append(entries, graph.SeriesEntry{
				Slug:           m.Slug,
				Type:           m.Type,
				Title:          m.Title,
				URL:            m.CanonicalURL(),
				Order:          ord,
				ReadingMinutes: m.ReadingMinutes,
			})
			if et := docEffectiveTime(m); et.After(latest) {
				latest = et
			}
		}

		latestStr := ""
		if !latest.IsZero() {
			latestStr = latest.Format(time.RFC3339)
		}
		out = append(out, SeriesSummary{
			Name:     displayName[slug],
			Slug:     slug,
			Count:    len(entries),
			LatestAt: latestStr,
			Items:    entries,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].LatestAt != out[j].LatestAt {
			return out[i].LatestAt > out[j].LatestAt
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (s *Server) buildArchivePayload() ArchiveBody {
	docs := s.store.ListPublished("")
	byYear := make(map[int][]ContentSummary)
	total := 0

	for _, doc := range docs {
		if doc.Type != content.TypePost && doc.Type != content.TypeNote {
			continue
		}
		y := docEffectiveTime(doc).Year()
		byYear[y] = append(byYear[y], toContentSummary(doc))
		total++
	}

	years := make([]int, 0, len(byYear))
	for y := range byYear {
		years = append(years, y)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(years)))

	groups := make([]ArchiveYearGroup, 0, len(years))
	for _, y := range years {
		groups = append(groups, ArchiveYearGroup{
			Year:  y,
			Items: byYear[y],
		})
	}
	return ArchiveBody{
		Total: total,
		Years: groups,
	}
}

func toContentSummary(doc *content.Document) ContentSummary {
	tags := doc.Tags
	if tags == nil {
		tags = []string{}
	}
	pub := ""
	if doc.PublishedAt != nil {
		pub = doc.PublishedAt.Format(time.RFC3339)
	}
	return ContentSummary{
		Type:           doc.Type,
		Slug:           doc.Slug,
		Title:          doc.Title,
		Description:    doc.Description,
		Summary:        doc.Summary,
		Status:         doc.Status,
		Category:       doc.Category,
		Tags:           tags,
		Series:         doc.Series,
		SeriesOrder:    doc.SeriesOrder,
		Lang:           doc.Lang,
		TranslationKey: doc.TranslationKey,
		PublishedAt:    pub,
		UpdatedAt:      doc.UpdatedAt.Format(time.RFC3339),
		Cover:          doc.Cover,
		Featured:       doc.Featured,
		WordCount:      doc.WordCount,
		ReadingMinutes: doc.ReadingMinutes,
		URL:            doc.CanonicalURL(),
		MarkdownURL:    doc.CanonicalURL() + ".md",
		ProjectStatus:  doc.ProjectStatus,
		RepoURL:        doc.RepoURL,
		WebsiteURL:     doc.WebsiteURL,
		TechStack:      doc.TechStack,
	}
}

func normalizeGraph(g *graph.GlobalGraph) {
	if g.Nodes == nil {
		g.Nodes = []graph.GraphNode{}
	}
	if g.Edges == nil {
		g.Edges = []graph.GraphEdge{}
	}
	for i := range g.Nodes {
		if g.Nodes[i].Tags == nil {
			g.Nodes[i].Tags = []string{}
		}
	}
}

func parseContentTypeFilter(raw string) (content.ContentType, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "post", "posts":
		return content.TypePost, true
	case "note", "notes":
		return content.TypeNote, true
	case "project", "projects":
		return content.TypeProject, true
	default:
		return "", false
	}
}

func docHasTag(tags []string, want string) bool {
	wantSlug := content.TagSlug(want)
	for _, t := range tags {
		if strings.EqualFold(t, want) || content.TagSlug(t) == wantSlug {
			return true
		}
	}
	return false
}

func projectRank(st content.ProjectStatus) int {
	switch st {
	case content.ProjectActive:
		return 0
	case content.ProjectMaintained:
		return 1
	case content.ProjectExperiment:
		return 2
	case content.ProjectArchived:
		return 3
	default:
		return 4
	}
}

func seriesOrderValue(doc *content.Document) int {
	if doc.SeriesOrder != nil {
		return *doc.SeriesOrder
	}
	return 1 << 30
}

func docEffectiveTime(doc *content.Document) time.Time {
	if doc.PublishedAt != nil {
		return *doc.PublishedAt
	}
	return doc.UpdatedAt
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
