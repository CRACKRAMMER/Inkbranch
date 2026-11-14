package content

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/goccy/go-yaml"
)

var frontmatterAliases = map[string]string{
	"summary":        "description",
	"excerpt":        "description",
	"tags_string":    "tags",
	"pubDate":        "date",
	"publish_date":   "date",
	"created":        "date",
	"modified":       "updated",
	"image":          "cover",
	"thumbnail":      "cover",
	"categories":     "category",
	"project_status": "projectStatus",
	"github":         "repo",
	"homepage":       "website",
	"tech":           "stack",
	"techStack":      "stack",
}

var legacySEOKeys = map[string]struct{}{
	"canonical":      {},
	"ogImage":        {},
	"noindex":        {},
	"seoTitle":       {},
	"seoDescription": {},
}

var knownFrontmatterKeys = func() map[string]struct{} {
	keys := []string{
		"title", "slug", "description", "date", "publishedAt", "updated",
		"category", "tags", "cover", "featured", "toc", "comments", "lang",
		"translationKey", "series", "seriesOrder", "seo", "status", "draft",
		"publishAt", "projectStatus", "started", "repo", "website", "stack",
		"importedFrom", "originalPath",
	}
	m := make(map[string]struct{}, len(keys)+len(frontmatterAliases)+len(legacySEOKeys))
	for _, k := range keys {
		m[k] = struct{}{}
	}
	for k := range frontmatterAliases {
		m[k] = struct{}{}
	}
	for k := range legacySEOKeys {
		m[k] = struct{}{}
	}
	return m
}()

// ParsedFrontmatter holds typed normalized frontmatter values plus preserved unknown fields.
type ParsedFrontmatter struct {
	Title          string
	Slug           string
	Description    string
	Summary        string
	Status         ContentStatus
	Category       string
	Tags           []string
	Cover          string
	Featured       bool
	TOC            bool
	Comments       bool
	Lang           string
	TranslationKey string
	Series         string
	SeriesOrder    *int
	PublishedAt    *time.Time
	ScheduledAt    *time.Time
	UpdatedAt      *time.Time
	SEO            SEOMetadata
	ProjectStatus  ProjectStatus
	StartedAt      *time.Time
	RepoURL        string
	WebsiteURL     string
	TechStack      []string
	Extra          map[string]any
}

// SplitFrontmatter extracts YAML frontmatter text and Markdown body while tolerating CRLF.
func SplitFrontmatter(raw string) (yamlText string, body string, hasFM bool, err error) {
	norm := strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasPrefix(norm, "---\n") && norm != "---" {
		return "", norm, false, nil
	}
	rest := strings.TrimPrefix(norm, "---\n")
	lines := strings.Split(rest, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" || trimmed == "..." {
			yamlPart := strings.Join(lines[:i], "\n")
			bodyPart := strings.Join(lines[i+1:], "\n")
			bodyPart = strings.TrimLeft(bodyPart, "\n")
			return yamlPart, bodyPart, true, nil
		}
	}
	return "", norm, false, fmt.Errorf("unterminated YAML frontmatter fence")
}

// ParseFrontmatter parses, normalizes, and validates YAML frontmatter for the given content type.
func ParseFrontmatter(yamlText string, docType ContentType) (*ParsedFrontmatter, error) {
	rawMap := make(map[string]any)
	if strings.TrimSpace(yamlText) != "" {
		if err := yaml.Unmarshal([]byte(yamlText), &rawMap); err != nil {
			return nil, fmt.Errorf("invalid YAML frontmatter: %w", err)
		}
	}

	extra := make(map[string]any)
	known := make(map[string]any)
	for k, v := range rawMap {
		if _, ok := knownFrontmatterKeys[k]; ok {
			known[k] = v
		} else {
			extra[k] = v
		}
	}

	normalized := normalizeFrontmatterMap(known)
	out := &ParsedFrontmatter{
		Lang:     "en",
		TOC:      true,
		Comments: true,
		Extra:    extra,
	}

	out.Title = asString(normalized["title"])
	out.Slug = asString(normalized["slug"])
	out.Description = asString(normalized["description"])
	out.Summary = asString(known["summary"])
	out.Category = asString(normalized["category"])
	out.Cover = asString(normalized["cover"])
	if !IsSafeURL(out.Cover) {
		return nil, fmt.Errorf("cover URL is unsafe: %q", out.Cover)
	}
	out.Lang = asString(normalized["lang"])
	if out.Lang == "" {
		out.Lang = "en"
	}
	out.TranslationKey = asString(normalized["translationKey"])
	out.Series = asString(normalized["series"])
	if v, ok := normalized["seriesOrder"]; ok {
		if n, err := asInt(v); err == nil {
			out.SeriesOrder = &n
		} else {
			return nil, fmt.Errorf("invalid seriesOrder: %v", v)
		}
	}

	out.Featured = asBool(normalized["featured"], false)
	out.TOC = asBool(normalized["toc"], true)
	out.Comments = asBool(normalized["comments"], true)

	tags, err := asStringSlice(normalized["tags"], 30, 80)
	if err != nil {
		return nil, fmt.Errorf("invalid tags: %w", err)
	}
	out.Tags = dedupeStrings(tags)

	var dateVal *time.Time
	if v, ok := normalized["date"]; ok && v != nil {
		t, err := parseFlexibleDate(v)
		if err != nil {
			return nil, fmt.Errorf("invalid date: %w", err)
		}
		dateVal = t
	}
	if v, ok := normalized["publishedAt"]; ok && v != nil {
		t, err := parseFlexibleDate(v)
		if err != nil {
			return nil, fmt.Errorf("invalid publishedAt: %w", err)
		}
		out.PublishedAt = t
	}
	if out.PublishedAt == nil {
		out.PublishedAt = dateVal
	}
	if v, ok := normalized["updated"]; ok && v != nil {
		t, err := parseFlexibleDate(v)
		if err != nil {
			return nil, fmt.Errorf("invalid updated date: %w", err)
		}
		out.UpdatedAt = t
	}
	if v, ok := normalized["publishAt"]; ok && v != nil {
		t, err := parseFlexibleDate(v)
		if err != nil {
			return nil, fmt.Errorf("invalid publishAt: %w", err)
		}
		out.ScheduledAt = t
	}

	if rawStatus := asString(normalized["status"]); rawStatus != "" {
		if !IsValidStatus(rawStatus) {
			return nil, fmt.Errorf("unsupported status %q", rawStatus)
		}
		out.Status = ContentStatus(rawStatus)
	} else if out.PublishedAt != nil {
		out.Status = StatusPublished
	} else {
		out.Status = StatusDraft
	}

	if seoMap, ok := asStringAnyMap(normalized["seo"]); ok {
		out.SEO = SEOMetadata{
			Title:       asString(seoMap["title"]),
			Description: asString(seoMap["description"]),
			Canonical:   asString(seoMap["canonical"]),
			OGImage:     asString(seoMap["ogImage"]),
			NoIndex:     asBool(seoMap["noindex"], false),
		}
		if !IsSafeURL(out.SEO.Canonical) || !IsSafeURL(out.SEO.OGImage) {
			return nil, fmt.Errorf("unsafe SEO URL")
		}
	}

	if docType == TypePost && out.Title == "" {
		return nil, fmt.Errorf("a post requires a non-empty title")
	}
	if docType == TypeProject {
		if out.Title == "" {
			return nil, fmt.Errorf("a project requires a non-empty title")
		}
		ps := asString(normalized["projectStatus"])
		if ps == "" {
			ps = string(ProjectActive)
		}
		if !IsValidProjectStatus(ps) {
			return nil, fmt.Errorf("invalid projectStatus %q", ps)
		}
		out.ProjectStatus = ProjectStatus(ps)
		if v, ok := normalized["started"]; ok && v != nil {
			t, err := parseFlexibleDate(v)
			if err != nil {
				return nil, fmt.Errorf("invalid started date: %w", err)
			}
			out.StartedAt = t
		}
		out.RepoURL = asString(normalized["repo"])
		out.WebsiteURL = asString(normalized["website"])
		if !IsSafeURL(out.RepoURL) || !IsSafeURL(out.WebsiteURL) {
			return nil, fmt.Errorf("unsafe project repo/website URL")
		}
		stack, err := asStringSlice(normalized["stack"], 30, 60)
		if err != nil {
			return nil, fmt.Errorf("invalid stack: %w", err)
		}
		out.TechStack = dedupeStrings(stack)
	}

	if out.Status == StatusScheduled && out.ScheduledAt == nil {
		return nil, fmt.Errorf(`status "scheduled" requires a publishAt timestamp`)
	}
	if (docType == TypePost || docType == TypeProject) && out.Status == StatusPublished && out.PublishedAt == nil {
		return nil, fmt.Errorf(`status "published" requires a date`)
	}

	return out, nil
}

// RenderMarkdownFile serializes frontmatter + preserved unknown extra keys + body into clean Markdown.
func RenderMarkdownFile(fm map[string]any, extra map[string]any, body string) (string, error) {
	merged := make(map[string]any, len(extra)+len(fm))
	for k, v := range extra {
		merged[k] = v
	}
	for k, v := range fm {
		merged[k] = v
	}

	yamlBytes, err := yaml.Marshal(merged)
	if err != nil {
		return "", fmt.Errorf("marshal frontmatter: %w", err)
	}

	normBody := strings.ReplaceAll(body, "\r\n", "\n")
	normBody = strings.TrimLeft(normBody, "\n")
	if !strings.HasSuffix(normBody, "\n") && normBody != "" {
		normBody += "\n"
	}

	var b strings.Builder
	b.WriteString("---\n")
	b.Write(yamlBytes)
	if !strings.HasSuffix(string(yamlBytes), "\n") {
		b.WriteByte('\n')
	}
	b.WriteString("---\n\n")
	b.WriteString(normBody)
	return b.String(), nil
}

func normalizeFrontmatterMap(raw map[string]any) map[string]any {
	out := make(map[string]any, len(raw))
	for k, v := range raw {
		out[k] = v
	}
	if out["description"] == nil {
		if s := asString(out["summary"]); s != "" {
			out["description"] = s
		} else if e := asString(out["excerpt"]); e != "" {
			out["description"] = e
		}
	}
	for from, to := range frontmatterAliases {
		if from == "summary" || from == "excerpt" {
			continue
		}
		if out[from] == nil || out[to] != nil {
			continue
		}
		if from == "categories" {
			if slice, err := asStringSlice(out[from], 10, 80); err == nil && len(slice) > 0 {
				out[to] = slice[0]
				continue
			}
		}
		out[to] = out[from]
	}

	if out["draft"] != nil && out["status"] == nil && asBool(out["draft"], false) {
		out["status"] = string(StatusDraft)
	}

	seo, _ := asStringAnyMap(out["seo"])
	if seo == nil {
		seo = make(map[string]any)
	}
	lift := func(topKey, seoKey string) {
		if s := asString(out[topKey]); s != "" && seo[seoKey] == nil {
			seo[seoKey] = s
		}
	}
	lift("canonical", "canonical")
	lift("ogImage", "ogImage")
	lift("seoTitle", "title")
	lift("seoDescription", "description")
	if out["noindex"] != nil && seo["noindex"] == nil {
		seo["noindex"] = asBool(out["noindex"], false)
	}
	if len(seo) > 0 {
		out["seo"] = seo
	}
	return out
}

var dateOnlyRegex = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

func parseFlexibleDate(val any) (*time.Time, error) {
	switch v := val.(type) {
	case time.Time:
		if v.IsZero() {
			return nil, nil
		}
		u := v.UTC()
		// Anchor midnight UTC dates produced from bare YYYY-MM-DD YAML scalars to noon UTC,
		// matching v1 so readers west of Greenwich never see the previous day.
		if u.Hour() == 0 && u.Minute() == 0 && u.Second() == 0 && u.Nanosecond() == 0 {
			u = time.Date(u.Year(), u.Month(), u.Day(), 12, 0, 0, 0, time.UTC)
		}
		return &u, nil
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return nil, nil
		}
		if m := dateOnlyRegex.FindStringSubmatch(trimmed); m != nil {
			t, err := time.Parse("2006-01-02", trimmed)
			if err != nil {
				return nil, err
			}
			noon := time.Date(t.Year(), t.Month(), t.Day(), 12, 0, 0, 0, time.UTC)
			return &noon, nil
		}
		layouts := []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02 15:04:05",
			"2006-01-02 15:04",
			"2006-01-02T15:04:05",
			"2006-01-02T15:04",
		}
		for _, layout := range layouts {
			if t, err := time.Parse(layout, trimmed); err == nil {
				u := t.UTC()
				return &u, nil
			}
		}
		return nil, fmt.Errorf("unrecognized date %q", trimmed)
	default:
		return nil, fmt.Errorf("unsupported date value %T", val)
	}
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

func asBool(v any, fallback bool) bool {
	if v == nil {
		return fallback
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		default:
			return fallback
		}
	case int, int64, uint64:
		return fmt.Sprint(x) == "1"
	default:
		return fallback
	}
}

func asInt(v any) (int, error) {
	switch x := v.(type) {
	case int:
		return x, nil
	case int64:
		return int(x), nil
	case uint64:
		return int(x), nil
	case float64:
		return int(x), nil
	case string:
		return strconv.Atoi(strings.TrimSpace(x))
	default:
		return 0, fmt.Errorf("not an integer: %T", v)
	}
}

func asStringSlice(v any, maxItems, maxItemLen int) ([]string, error) {
	if v == nil {
		return nil, nil
	}
	var raw []string
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			s := asString(item)
			if s != "" {
				raw = append(raw, s)
			}
		}
	case []string:
		for _, item := range x {
			s := strings.TrimSpace(item)
			if s != "" {
				raw = append(raw, s)
			}
		}
	case string:
		for _, part := range strings.Split(x, ",") {
			s := strings.TrimSpace(part)
			if s != "" {
				raw = append(raw, s)
			}
		}
	default:
		s := asString(x)
		if s != "" {
			raw = append(raw, s)
		}
	}
	if len(raw) > maxItems {
		return nil, fmt.Errorf("at most %d items allowed, got %d", maxItems, len(raw))
	}
	for _, item := range raw {
		if len([]rune(item)) > maxItemLen {
			return nil, fmt.Errorf("item %q exceeds %d characters", item, maxItemLen)
		}
	}
	return raw, nil
}

func asStringAnyMap(v any) (map[string]any, bool) {
	if v == nil {
		return nil, false
	}
	switch x := v.(type) {
	case map[string]any:
		return x, true
	case map[any]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[fmt.Sprint(k)] = val
		}
		return out, true
	default:
		return nil, false
	}
}

func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, item := range in {
		key := strings.ToLower(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}
