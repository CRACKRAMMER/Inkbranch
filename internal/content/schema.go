package content

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ContentType identifies one of the three Inkbranch content collections.
type ContentType string

const (
	TypePost    ContentType = "post"
	TypeNote    ContentType = "note"
	TypeProject ContentType = "project"
)

// AllTypes defines the canonical search/resolution priority order.
var AllTypes = []ContentType{TypePost, TypeNote, TypeProject}

var TypeToDir = map[ContentType]string{
	TypePost:    "posts",
	TypeNote:    "notes",
	TypeProject: "projects",
}

var DirToType = map[string]ContentType{
	"posts":    TypePost,
	"notes":    TypeNote,
	"projects": TypeProject,
}

func (t ContentType) Valid() bool {
	_, ok := TypeToDir[t]
	return ok
}

func (t ContentType) Dir() string {
	return TypeToDir[t]
}

// ContentStatus represents the publishing lifecycle of a document.
type ContentStatus string

const (
	StatusDraft     ContentStatus = "draft"
	StatusScheduled ContentStatus = "scheduled"
	StatusPublished ContentStatus = "published"
	StatusArchived  ContentStatus = "archived"
	StatusUnlisted  ContentStatus = "unlisted"
)

func IsValidStatus(s string) bool {
	switch ContentStatus(s) {
	case StatusDraft, StatusScheduled, StatusPublished, StatusArchived, StatusUnlisted:
		return true
	default:
		return false
	}
}

// ProjectStatus tracks lifecycle for project showcase items.
type ProjectStatus string

const (
	ProjectActive     ProjectStatus = "active"
	ProjectMaintained ProjectStatus = "maintained"
	ProjectExperiment ProjectStatus = "experiment"
	ProjectArchived   ProjectStatus = "archived"
)

func IsValidProjectStatus(s string) bool {
	switch ProjectStatus(s) {
	case ProjectActive, ProjectMaintained, ProjectExperiment, ProjectArchived:
		return true
	default:
		return false
	}
}

// SEOMetadata holds per-document SEO overrides from YAML frontmatter.
type SEOMetadata struct {
	Title       string `json:"title,omitempty" yaml:"title,omitempty"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`
	Canonical   string `json:"canonical,omitempty" yaml:"canonical,omitempty"`
	OGImage     string `json:"ogImage,omitempty" yaml:"ogImage,omitempty"`
	NoIndex     bool   `json:"noindex,omitempty" yaml:"noindex,omitempty"`
}

// Heading represents an extracted article heading for TOC and search.
type Heading struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Level int    `json:"level"`
}

// OutgoingLink captures an internal or wikilink reference found inside Markdown body.
type OutgoingLink struct {
	TargetType     string `json:"targetType,omitempty"`
	TargetSlug     string `json:"targetSlug"`
	LinkText       string `json:"linkText"`
	ContextSnippet string `json:"contextSnippet"`
	Href           string `json:"href"`
}

// Document is the complete in-memory representation of a parsed Markdown file.
type Document struct {
	Type           ContentType    `json:"type"`
	RelativePath   string         `json:"path"`
	AbsolutePath   string         `json:"-"`
	Filename       string         `json:"filename"`
	Slug           string         `json:"slug"`
	Title          string         `json:"title"`
	Description    string         `json:"description"`
	Summary        string         `json:"summary,omitempty"`
	Status         ContentStatus  `json:"status"`
	Category       string         `json:"category,omitempty"`
	Tags           []string       `json:"tags"`
	Series         string         `json:"series,omitempty"`
	SeriesOrder    *int           `json:"seriesOrder,omitempty"`
	Lang           string         `json:"lang"`
	TranslationKey string         `json:"translationKey,omitempty"`
	PublishedAt    *time.Time     `json:"publishedAt,omitempty"`
	ScheduledAt    *time.Time     `json:"scheduledAt,omitempty"`
	UpdatedAt      time.Time      `json:"updatedAt"`
	FileMtimeNs    int64          `json:"mtimeNs"`
	Cover          string         `json:"cover,omitempty"`
	Featured       bool           `json:"featured"`
	TOCEnabled     bool           `json:"tocEnabled"`
	Comments       bool           `json:"commentsEnabled"`
	SEO            SEOMetadata    `json:"seo"`
	Headings       []Heading      `json:"headings"`
	WordCount      int            `json:"wordCount"`
	ReadingMinutes int            `json:"readingMinutes"`
	ProjectStatus  ProjectStatus  `json:"projectStatus,omitempty"`
	StartedAt      *time.Time     `json:"startedAt,omitempty"`
	RepoURL        string         `json:"repoUrl,omitempty"`
	WebsiteURL     string         `json:"websiteUrl,omitempty"`
	TechStack      []string       `json:"stack,omitempty"`
	Extra          map[string]any `json:"extra,omitempty"`
	Body           string         `json:"-"`
	Raw            string         `json:"-"`
	PlainText      string         `json:"-"`
	RenderedHTML   string         `json:"renderedHtml,omitempty"`
	OutgoingLinks  []OutgoingLink `json:"outgoingLinks,omitempty"`
	Checksum       string         `json:"checksum"`
	ByteSize       int64          `json:"byteSize"`
}

// CanonicalURL returns the public path for this document.
func (d *Document) CanonicalURL() string {
	return "/" + d.Type.Dir() + "/" + d.Slug
}

var (
	datePrefixRegex = regexp.MustCompile(`^\d{4}[-_]\d{2}[-_]\d{2}[-_\s]+`)
	multiDashRegex  = regexp.MustCompile(`-{2,}`)
)

// Slugify converts Latin + CJK titles cleanly into URL-safe segments matching v1 behavior.
func Slugify(input string, fallback string) string {
	if fallback == "" {
		fallback = "untitled"
	}
	normalized := norm.NFKC.String(strings.TrimSpace(input))
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(normalized) {
		if isSlugChar(r) {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	out = multiDashRegex.ReplaceAllString(out, "-")
	if out == "" {
		return fallback
	}
	return truncateSlug(out)
}

// TagSlug produces a clean lowercase slug for tags while retaining CJK characters.
func TagSlug(name string) string {
	s := Slugify(name, "tag")
	if len([]rune(s)) > 100 {
		s = string([]rune(s)[:100])
		s = strings.Trim(s, "-")
	}
	if s == "" {
		return "tag"
	}
	return s
}

// SlugFromFilename derives a fallback slug from a Markdown filename (dropping YYYY-MM-DD prefixes).
func SlugFromFilename(filename string) string {
	base := filepath.Base(filename)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	withoutDate := datePrefixRegex.ReplaceAllString(stem, "")
	return Slugify(withoutDate, Slugify(stem, "untitled"))
}

func truncateSlug(slug string) string {
	runes := []rune(slug)
	if len(runes) > 120 {
		runes = runes[:120]
	}
	for len(string(runes)) > 180 && len(runes) > 1 {
		runes = runes[:len(runes)-1]
	}
	out := strings.Trim(string(runes), "-")
	if out == "" {
		return "untitled"
	}
	return out
}

func isSlugChar(r rune) bool {
	if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
		return true
	}
	return IsCJK(r) || (r >= 0x3040 && r <= 0x30FF) || (r >= 0xAC00 && r <= 0xD7AF)
}

// IsCJK identifies CJK ideographs across standard Unicode blocks used in Inkbranch content.
func IsCJK(r rune) bool {
	return unicode.In(r, unicode.Han) ||
		(r >= 0x3400 && r <= 0x4DBF) ||
		(r >= 0x4E00 && r <= 0x9FFF) ||
		(r >= 0xF900 && r <= 0xFAFF)
}

// IsSafeURL enforces relative paths or http/https URLs while blocking javascript:/data: payloads.
func IsSafeURL(raw string) bool {
	u := strings.TrimSpace(raw)
	if u == "" {
		return true
	}
	if strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//") {
		return true
	}
	lower := strings.ToLower(u)
	return strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://")
}

// ValidationError describes a frontmatter or file-level validation problem.
type ValidationError struct {
	Path    string
	Message string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Message)
}
