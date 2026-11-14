package content

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// RenderHook is injected by the application layer to produce rendered HTML and extracted links
// without creating circular imports between content and markdown packages.
type RenderHook func(doc *Document, resolver LinkResolver) (renderedHTML string, links []OutgoingLink, err error)

// LinkResolver resolves wikilinks and internal content references against loaded documents.
type LinkResolver interface {
	ResolveTarget(rawTarget string) (docType ContentType, slug string, title string, href string, ok bool)
}

// Store holds all scanned documents in memory keyed by relative path and (type, slug).
type Store struct {
	contentDir string
	renderHook RenderHook

	mu         sync.RWMutex
	docsByPath map[string]*Document
	docsByKey  map[string]*Document // "<type>:<slug>"
	errors     []ValidationError
	loadedAt   time.Time
}

// NewStore creates a content Store rooted at contentDir.
func NewStore(contentDir string, renderHook RenderHook) *Store {
	return &Store{
		contentDir: contentDir,
		renderHook: renderHook,
		docsByPath: make(map[string]*Document),
		docsByKey:  make(map[string]*Document),
	}
}

func (s *Store) ContentDir() string {
	return s.contentDir
}

// LoadAll walks content/{posts,notes,projects}, validates and parses all Markdown files,
// performs optional Markdown rendering with link resolution, and atomically swaps the index.
func (s *Store) LoadAll() ([]*Document, []ValidationError, error) {
	docs, valErrs, err := ScanDirectory(s.contentDir)
	if err != nil {
		return nil, valErrs, err
	}

	nextByPath := make(map[string]*Document, len(docs))
	nextByKey := make(map[string]*Document, len(docs))
	seenKeys := make(map[string]string, len(docs))

	for _, doc := range docs {
		key := docKey(doc.Type, doc.Slug)
		if prevPath, exists := seenKeys[key]; exists {
			valErrs = append(valErrs, ValidationError{
				Path:    doc.RelativePath,
				Message: fmt.Sprintf("duplicate %s slug %q (already defined in %s)", doc.Type, doc.Slug, prevPath),
			})
			continue
		}
		seenKeys[key] = doc.RelativePath
		nextByPath[doc.RelativePath] = doc
		nextByKey[key] = doc
	}

	// Perform pass 2 (Markdown rendering + wikilink extraction) against complete target table
	// so forward/cross-type links like [[projects/myblog]] or [[why-not-catch]] resolve accurately.
	if s.renderHook != nil {
		tmpResolver := &mapResolver{byKey: nextByKey}
		for _, doc := range nextByPath {
			htmlOut, links, rErr := s.renderHook(doc, tmpResolver)
			if rErr != nil {
				valErrs = append(valErrs, ValidationError{
					Path:    doc.RelativePath,
					Message: fmt.Sprintf("render markdown: %v", rErr),
				})
				continue
			}
			doc.RenderedHTML = htmlOut
			doc.OutgoingLinks = links
		}
	}

	s.mu.Lock()
	s.docsByPath = nextByPath
	s.docsByKey = nextByKey
	s.errors = valErrs
	s.loadedAt = time.Now().UTC()
	s.mu.Unlock()

	return s.ListAll(), valErrs, nil
}

// ResolveTarget implements LinkResolver against the currently active in-memory store.
func (s *Store) ResolveTarget(rawTarget string) (ContentType, string, string, string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return (&mapResolver{byKey: s.docsByKey}).ResolveTarget(rawTarget)
}

func (s *Store) ListAll() []*Document {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Document, 0, len(s.docsByPath))
	for _, doc := range s.docsByPath {
		out = append(out, doc)
	}
	sortDocsNewestFirst(out)
	return out
}

func (s *Store) ListPublished(docType ContentType) []*Document {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Document, 0, len(s.docsByPath))
	for _, doc := range s.docsByPath {
		if !isPublicDocument(doc) {
			continue
		}
		if docType != "" && doc.Type != docType {
			continue
		}
		out = append(out, doc)
	}
	sortDocsNewestFirst(out)
	return out
}

func (s *Store) GetPublished(docType ContentType, slug string) (*Document, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	doc, ok := s.docsByKey[docKey(docType, strings.ToLower(strings.TrimSpace(slug)))]
	if !ok {
		doc, ok = s.docsByKey[docKey(docType, strings.TrimSpace(slug))]
	}
	if !ok || !isPublicDocument(doc) {
		return nil, false
	}
	return doc, true
}

func (s *Store) GetAny(docType ContentType, slug string) (*Document, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	trimmed := strings.TrimSpace(slug)
	doc, ok := s.docsByKey[docKey(docType, trimmed)]
	if !ok {
		doc, ok = s.docsByKey[docKey(docType, strings.ToLower(trimmed))]
	}
	return doc, ok
}

func (s *Store) GetByPath(relPath string) (*Document, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	doc, ok := s.docsByPath[filepath.ToSlash(relPath)]
	return doc, ok
}

func (s *Store) ValidationErrors() []ValidationError {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ValidationError, len(s.errors))
	copy(out, s.errors)
	return out
}

func (s *Store) Stats() (scanned int, published int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	scanned = len(s.docsByPath)
	for _, doc := range s.docsByPath {
		if isPublicDocument(doc) {
			published++
		}
	}
	return scanned, published
}

func isPublicDocument(doc *Document) bool {
	if doc == nil {
		return false
	}
	if doc.Status != StatusPublished {
		return false
	}
	if doc.PublishedAt != nil && doc.PublishedAt.After(time.Now().UTC()) {
		return false
	}
	return true
}

func docKey(docType ContentType, slug string) string {
	return string(docType) + ":" + slug
}

func sortDocsNewestFirst(docs []*Document) {
	sort.Slice(docs, func(i, j int) bool {
		ti := effectiveDate(docs[i])
		tj := effectiveDate(docs[j])
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return docs[i].Slug < docs[j].Slug
	})
}

func effectiveDate(d *Document) time.Time {
	if d.PublishedAt != nil {
		return *d.PublishedAt
	}
	return d.UpdatedAt
}

type mapResolver struct {
	byKey map[string]*Document
}

func (r *mapResolver) ResolveTarget(rawTarget string) (ContentType, string, string, string, bool) {
	clean := strings.TrimSpace(strings.TrimPrefix(rawTarget, "/"))
	if clean == "" {
		return "", "", "", "", false
	}
	// Strip optional #heading fragment for document resolution, preserve later if needed.
	baseTarget := clean
	fragment := ""
	if idx := strings.IndexByte(clean, '#'); idx >= 0 {
		baseTarget = clean[:idx]
		fragment = clean[idx:]
	}
	baseTarget = strings.TrimSuffix(baseTarget, ".md")

	if strings.Contains(baseTarget, "/") {
		parts := strings.SplitN(baseTarget, "/", 2)
		if t, ok := DirToType[strings.ToLower(parts[0])]; ok {
			slug := parts[1]
			if doc := r.lookup(t, slug); doc != nil && isPublicDocument(doc) {
				return doc.Type, doc.Slug, doc.Title, doc.CanonicalURL() + fragment, true
			}
		}
	}

	if strings.Contains(baseTarget, ":") {
		parts := strings.SplitN(baseTarget, ":", 2)
		t := ContentType(strings.ToLower(parts[0]))
		if t.Valid() {
			if doc := r.lookup(t, parts[1]); doc != nil && isPublicDocument(doc) {
				return doc.Type, doc.Slug, doc.Title, doc.CanonicalURL() + fragment, true
			}
		}
	}

	for _, t := range AllTypes {
		if doc := r.lookup(t, baseTarget); doc != nil && isPublicDocument(doc) {
			return doc.Type, doc.Slug, doc.Title, doc.CanonicalURL() + fragment, true
		}
	}
	return "", "", "", "", false
}

func (r *mapResolver) lookup(t ContentType, slug string) *Document {
	if doc, ok := r.byKey[docKey(t, slug)]; ok {
		return doc
	}
	if doc, ok := r.byKey[docKey(t, strings.ToLower(slug))]; ok {
		return doc
	}
	return nil
}

// ScanDirectory reads and validates every Markdown file under content/{posts,notes,projects}.
func ScanDirectory(contentDir string) ([]*Document, []ValidationError, error) {
	var docs []*Document
	var valErrs []ValidationError

	for _, docType := range AllTypes {
		subDir := filepath.Join(contentDir, docType.Dir())
		info, err := os.Stat(subDir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, nil, fmt.Errorf("stat %s: %w", subDir, err)
		}
		if !info.IsDir() {
			continue
		}

		err = filepath.WalkDir(subDir, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			name := d.Name()
			if d.IsDir() {
				if name == ".locks" || name == ".tmp" || name == ".recovery" || strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(strings.ToLower(name), ".md") && !strings.HasSuffix(strings.ToLower(name), ".markdown") {
				return nil
			}
			if strings.HasPrefix(name, ".") {
				return nil
			}

			relPath, err := filepath.Rel(contentDir, path)
			if err != nil {
				return err
			}
			relPOSIX := filepath.ToSlash(relPath)

			doc, err := ReadDocumentFile(contentDir, relPOSIX, docType)
			if err != nil {
				valErrs = append(valErrs, ValidationError{Path: relPOSIX, Message: err.Error()})
				return nil
			}
			docs = append(docs, doc)
			return nil
		})
		if err != nil {
			return nil, valErrs, fmt.Errorf("walk %s: %w", subDir, err)
		}
	}

	sortDocsNewestFirst(docs)
	return docs, valErrs, nil
}

// ReadDocumentFile parses a single Markdown file relative to contentDir.
func ReadDocumentFile(contentDir, relPOSIX string, docType ContentType) (*Document, error) {
	absPath := filepath.Join(contentDir, filepath.FromSlash(relPOSIX))
	st, err := os.Lstat(absPath)
	if err != nil {
		return nil, fmt.Errorf("stat file: %w", err)
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("symlinks are rejected for security")
	}

	rawBytes, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	raw := string(rawBytes)
	yamlPart, body, _, err := SplitFrontmatter(raw)
	if err != nil {
		return nil, err
	}

	fm, err := ParseFrontmatter(yamlPart, docType)
	if err != nil {
		return nil, err
	}

	filename := filepath.Base(relPOSIX)
	derived := DeriveDocumentMetadata(docType, filename, body, fm.Title, fm.Slug, fm.Description)

	updatedAt := st.ModTime().UTC()
	if fm.UpdatedAt != nil {
		updatedAt = *fm.UpdatedAt
	}

	return &Document{
		Type:           docType,
		RelativePath:   relPOSIX,
		AbsolutePath:   absPath,
		Filename:       filename,
		Slug:           derived.Slug,
		Title:          derived.Title,
		Description:    derived.Description,
		Summary:        fm.Summary,
		Status:         fm.Status,
		Category:       fm.Category,
		Tags:           fm.Tags,
		Series:         fm.Series,
		SeriesOrder:    fm.SeriesOrder,
		Lang:           fm.Lang,
		TranslationKey: fm.TranslationKey,
		PublishedAt:    fm.PublishedAt,
		ScheduledAt:    fm.ScheduledAt,
		UpdatedAt:      updatedAt,
		FileMtimeNs:    st.ModTime().UnixNano(),
		Cover:          fm.Cover,
		Featured:       fm.Featured,
		TOCEnabled:     fm.TOC,
		Comments:       fm.Comments,
		SEO:            fm.SEO,
		Headings:       derived.Headings,
		WordCount:      derived.WordCount,
		ReadingMinutes: derived.ReadingMinutes,
		ProjectStatus:  fm.ProjectStatus,
		StartedAt:      fm.StartedAt,
		RepoURL:        fm.RepoURL,
		WebsiteURL:     fm.WebsiteURL,
		TechStack:      fm.TechStack,
		Extra:          fm.Extra,
		Body:           body,
		Raw:            raw,
		PlainText:      derived.PlainText,
		Checksum:       SHA256Hex(rawBytes),
		ByteSize:       st.Size(),
	}, nil
}

// ValidateDirectory scans and validates all Markdown files without mutating any state.
func ValidateDirectory(contentDir string) (int, []ValidationError, error) {
	store := NewStore(contentDir, nil)
	docs, valErrs, err := store.LoadAll()
	if err != nil {
		return 0, valErrs, err
	}
	return len(docs), valErrs, nil
}
