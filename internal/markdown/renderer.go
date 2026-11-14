package markdown

import (
	"bytes"
	"container/list"
	"strings"
	"sync"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

const defaultRenderCacheSize = 512

// RenderedDoc contains all outputs generated from rendering a Markdown document.
type RenderedDoc struct {
	HTML     string
	Headings []content.Heading
	Links    []content.OutgoingLink
}

// Renderer compiles Markdown into sanitized semantic HTML with bounded SHA-256 LRU caching.
type Renderer struct {
	md       goldmark.Markdown
	subMD    goldmark.Markdown
	policy   *bluemonday.Policy
	maxCache int

	mu    sync.Mutex
	cache map[string]*list.Element
	lru   *list.List
}

type cacheEntry struct {
	key string
	val RenderedDoc
}

// NewRenderer constructs an Inkbranch Goldmark+Chroma+Bluemonday pipeline.
func NewRenderer() *Renderer {
	codeRenderer := newCodeBlockRenderer()

	inlineParsers := []util.PrioritizedValue{
		util.Prioritized(newWikiLinkParser(), 100),
		util.Prioritized(&inlineMathParser{}, 110),
		util.Prioritized(&textDirectiveParser{}, 120),
	}

	nodeRenderers := []util.PrioritizedValue{
		util.Prioritized(codeRenderer, 100),
		util.Prioritized(newWikiLinkRenderer(), 100),
		util.Prioritized(newDirectiveInlineRenderer(), 100),
	}

	buildMD := func(withHeadingTransformer bool) goldmark.Markdown {
		parserOpts := []parser.Option{
			parser.WithInlineParsers(inlineParsers...),
		}
		if withHeadingTransformer {
			parserOpts = append(parserOpts, parser.WithASTTransformers(
				util.Prioritized(newHeadingAndLinkTransformer(), 100),
			))
		}
		return goldmark.New(
			goldmark.WithExtensions(
				extension.GFM,
				extension.Footnote,
			),
			goldmark.WithParserOptions(parserOpts...),
			goldmark.WithRendererOptions(
				gmhtml.WithUnsafe(), // Output is explicitly scrubbed by bluemonday immediately after render.
				renderer.WithNodeRenderers(nodeRenderers...),
			),
		)
	}

	return &Renderer{
		md:       buildMD(true),
		subMD:    buildMD(false),
		policy:   newSanitizePolicy(),
		maxCache: defaultRenderCacheSize,
		cache:    make(map[string]*list.Element, 64),
		lru:      list.New(),
	}
}

// Render compiles a document body with optional SHA-256 cache lookup and link resolution.
func (r *Renderer) Render(cacheKey string, body string, resolver content.LinkResolver) (RenderedDoc, error) {
	if cacheKey != "" {
		if hit, ok := r.getCache(cacheKey); ok {
			return hit, nil
		}
	}

	state := &renderState{resolver: resolver}
	subRender := func(subSrc string) string {
		pc := parser.NewContext()
		pc.Set(renderStateContextKey, state)
		var buf bytes.Buffer
		_ = r.subMD.Convert([]byte(subSrc), &buf, parser.WithContext(pc))
		return buf.String()
	}

	preprocessed, placeholders := preprocessBlocks(body, subRender)

	pc := parser.NewContext()
	pc.Set(renderStateContextKey, state)
	var rawBuf bytes.Buffer
	if err := r.md.Convert([]byte(preprocessed), &rawBuf, parser.WithContext(pc)); err != nil {
		return RenderedDoc{}, err
	}

	combined := rawBuf.String()
	for _, ph := range placeholders {
		combined = strings.ReplaceAll(combined, "<p>"+ph.Token+"</p>", ph.HTML)
		combined = strings.ReplaceAll(combined, ph.Token, ph.HTML)
	}

	safeHTML := r.policy.Sanitize(combined)
	res := RenderedDoc{
		HTML:     safeHTML,
		Headings: state.headings,
		Links:    dedupeLinks(state.links),
	}

	if cacheKey != "" {
		r.putCache(cacheKey, res)
	}
	return res, nil
}

// InvalidateCache clears all cached renders (e.g. when filesystem watcher reloads linked slugs).
func (r *Renderer) InvalidateCache() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cache = make(map[string]*list.Element, 64)
	r.lru.Init()
}

func (r *Renderer) getCache(key string) (RenderedDoc, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if el, ok := r.cache[key]; ok {
		r.lru.MoveToFront(el)
		return el.Value.(*cacheEntry).val, true
	}
	return RenderedDoc{}, false
}

func (r *Renderer) putCache(key string, val RenderedDoc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if el, ok := r.cache[key]; ok {
		r.lru.MoveToFront(el)
		el.Value.(*cacheEntry).val = val
		return
	}
	if r.lru.Len() >= r.maxCache {
		if oldest := r.lru.Back(); oldest != nil {
			r.lru.Remove(oldest)
			delete(r.cache, oldest.Value.(*cacheEntry).key)
		}
	}
	el := r.lru.PushFront(&cacheEntry{key: key, val: val})
	r.cache[key] = el
}

// ChromaLightCSS exports the CSS rules for Chroma light-mode code syntax highlighting.
func ChromaLightCSS() string {
	var buf bytes.Buffer
	fmtErr := html.New(html.WithClasses(true)).WriteCSS(&buf, styles.Get("github"))
	if fmtErr != nil {
		return ""
	}
	return buf.String()
}

// ChromaDarkCSS exports scoped CSS rules for Chroma dark-mode code syntax highlighting.
func ChromaDarkCSS() string {
	var buf bytes.Buffer
	fmtErr := html.New(html.WithClasses(true), html.WithModeClasses(true)).WriteCSS(&buf, styles.Get("github-dark"))
	if fmtErr != nil {
		return ""
	}
	return buf.String()
}

func dedupeLinks(links []content.OutgoingLink) []content.OutgoingLink {
	if len(links) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(links))
	out := make([]content.OutgoingLink, 0, len(links))
	for _, l := range links {
		key := l.TargetType + ":" + strings.ToLower(l.TargetSlug)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, l)
	}
	return out
}
