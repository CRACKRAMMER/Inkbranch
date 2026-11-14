package markdown

import (
	"fmt"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// headingTransformer assigns deterministic CJK+Latin heading IDs matching content.ExtractHeadings
// and also collects standard Markdown internal links into renderState.links.
type headingAndLinkTransformer struct{}

func newHeadingAndLinkTransformer() parser.ASTTransformer {
	return &headingAndLinkTransformer{}
}

func (t *headingAndLinkTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	source := reader.Source()
	state, _ := pc.Get(renderStateContextKey).(*renderState)
	usedIDs := make(map[string]int)

	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		if h, ok := n.(*ast.Heading); ok {
			title := strings.TrimSpace(collectPlainText(h, source))
			if title != "" {
				base := content.Slugify(title, "section")
				id := base
				if count := usedIDs[base]; count > 0 {
					id = fmt.Sprintf("%s-%d", base, count+1)
				}
				usedIDs[base]++
				h.SetAttributeString("id", []byte(id))
				if state != nil {
					state.headings = append(state.headings, content.Heading{
						ID:    id,
						Text:  title,
						Level: h.Level,
					})
				}
			}
			return ast.WalkContinue, nil
		}

		if link, ok := n.(*ast.Link); ok && state != nil && state.resolver != nil {
			dest := string(link.Destination)
			if strings.HasPrefix(dest, "/posts/") || strings.HasPrefix(dest, "/notes/") || strings.HasPrefix(dest, "/projects/") {
				if ct, slug, _, href, ok := state.resolver.ResolveTarget(dest); ok {
					state.links = append(state.links, content.OutgoingLink{
						TargetType:     string(ct),
						TargetSlug:     slug,
						LinkText:       strings.TrimSpace(collectPlainText(link, source)),
						ContextSnippet: strings.TrimSpace(collectPlainText(link, source)),
						Href:           href,
					})
				}
			}
		}

		return ast.WalkContinue, nil
	})
}

func collectPlainText(n ast.Node, source []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch c := child.(type) {
		case *ast.Text:
			b.Write(c.Segment.Value(source))
			if c.SoftLineBreak() {
				b.WriteByte(' ')
			}
		case *ast.CodeSpan:
			b.Write(c.Text(source))
			return ast.WalkSkipChildren, nil
		case *WikiLinkNode:
			b.WriteString(c.Label)
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}
