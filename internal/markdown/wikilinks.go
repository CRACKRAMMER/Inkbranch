package markdown

import (
	"bytes"
	stdhtml "html"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var (
	renderStateContextKey = parser.NewContextKey()
	kindWikiLink          = ast.NewNodeKind("WikiLink")
)

type renderState struct {
	resolver content.LinkResolver
	headings []content.Heading
	links    []content.OutgoingLink
}

// WikiLinkNode represents an AST inline node parsed from [[target|label]].
type WikiLinkNode struct {
	ast.BaseInline
	Target    string
	Label     string
	Fragment  string
	DocType   string
	Slug      string
	Href      string
	Resolved  bool
}

func (n *WikiLinkNode) Kind() ast.NodeKind {
	return kindWikiLink
}

func (n *WikiLinkNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{
		"Target": n.Target,
		"Label":  n.Label,
		"Href":   n.Href,
	}, nil)
}

type wikiLinkParser struct{}

func newWikiLinkParser() parser.InlineParser {
	return &wikiLinkParser{}
}

func (p *wikiLinkParser) Trigger() []byte {
	return []byte{'['}
}

func (p *wikiLinkParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, seg := block.PeekLine()
	if !bytes.HasPrefix(line, []byte("[[")) {
		return nil
	}

	// Only accept valid non-nested wikilinks on a single line before `]]`.
	rest := line[2:]
	closeIdx := bytes.Index(rest, []byte("]]"))
	if closeIdx <= 0 {
		return nil
	}
	if newlineIdx := bytes.IndexByte(rest[:closeIdx], '\n'); newlineIdx >= 0 {
		return nil
	}
	inner := string(rest[:closeIdx])
	if strings.Contains(inner, "[[") || strings.Contains(inner, "[") {
		return nil
	}

	rawTarget := strings.TrimSpace(inner)
	explicitLabel := ""
	if pipeIdx := strings.IndexByte(inner, '|'); pipeIdx >= 0 {
		rawTarget = strings.TrimSpace(inner[:pipeIdx])
		explicitLabel = strings.TrimSpace(inner[pipeIdx+1:])
	}
	if rawTarget == "" {
		return nil
	}

	block.Advance(2 + closeIdx + 2)

	node := &WikiLinkNode{
		Target: rawTarget,
		Label:  explicitLabel,
	}

	targetSlug := rawTarget
	if idx := strings.IndexByte(targetSlug, '#'); idx >= 0 {
		node.Fragment = targetSlug[idx:]
		targetSlug = targetSlug[:idx]
	}

	state, _ := pc.Get(renderStateContextKey).(*renderState)
	if state != nil && state.resolver != nil {
		if t, slug, resolvedTitle, href, ok := state.resolver.ResolveTarget(rawTarget); ok {
			node.Resolved = true
			node.DocType = string(t)
			node.Slug = slug
			node.Href = href
			if node.Label == "" {
				node.Label = resolvedTitle
			}
		}
	}

	if !node.Resolved {
		clean := strings.TrimSuffix(strings.TrimPrefix(targetSlug, "/"), ".md")
		if strings.Contains(clean, "/") {
			parts := strings.SplitN(clean, "/", 2)
			if t, ok := content.DirToType[strings.ToLower(parts[0])]; ok {
				node.DocType = string(t)
				node.Slug = parts[1]
			} else {
				node.Slug = clean
			}
		} else if strings.Contains(clean, ":") {
			parts := strings.SplitN(clean, ":", 2)
			node.DocType = strings.ToLower(parts[0])
			node.Slug = parts[1]
		} else {
			node.Slug = clean
		}
		if node.Label == "" {
			node.Label = node.Slug
		}
	}

	if state != nil {
		snippet := strings.TrimSpace(string(bytes.TrimRight(line, "\r\n")))
		if len([]rune(snippet)) > 160 {
			snippet = string([]rune(snippet)[:157]) + "…"
		}
		state.links = append(state.links, content.OutgoingLink{
			TargetType:     node.DocType,
			TargetSlug:     node.Slug,
			LinkText:       node.Label,
			ContextSnippet: snippet,
			Href:           node.Href,
		})
	}
	_ = seg
	return node
}

type wikiLinkRenderer struct{}

func newWikiLinkRenderer() renderer.NodeRenderer {
	return &wikiLinkRenderer{}
}

func (r *wikiLinkRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(kindWikiLink, r.render)
}

func (r *wikiLinkRenderer) render(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*WikiLinkNode)
	if n.Resolved && n.Href != "" {
		_, _ = w.WriteString(`<a class="md-wikilink" href="`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.Href))
		_, _ = w.WriteString(`" data-wikilink-type="`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.DocType))
		_, _ = w.WriteString(`" data-wikilink-slug="`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.Slug))
		_, _ = w.WriteString(`">`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.Label))
		_, _ = w.WriteString(`</a>`)
	} else {
		_, _ = w.WriteString(`<span class="md-wikilink md-wikilink-broken" data-wikilink-target="`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.Target))
		_, _ = w.WriteString(`">`)
		_, _ = w.WriteString(stdhtml.EscapeString(n.Label))
		_, _ = w.WriteString(`</span>`)
	}
	return ast.WalkSkipChildren, nil
}
