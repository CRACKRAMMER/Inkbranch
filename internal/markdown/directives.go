package markdown

import (
	"bytes"
	"fmt"
	stdhtml "html"
	"regexp"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var (
	kindInlineMath     = ast.NewNodeKind("InlineMath")
	kindTextDirective  = ast.NewNodeKind("TextDirective")
	containerOpenRegex = regexp.MustCompile(`^(:{3,})\s*([a-zA-Z][a-zA-Z0-9_-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$`)
	leafDirectiveRegex = regexp.MustCompile(`^::\s*(video|audio|embed|iframe)(?:\{([^}]*)\})?\s*$`)
	ghAlertOpenRegex   = regexp.MustCompile(`^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$`)
	attrPairRegex      = regexp.MustCompile(`([a-zA-Z0-9_-]+)=("([^"]*)"|'([^']*)'|(\S+))`)
)

type calloutSpec struct {
	Tone  string
	Label string
}

var calloutKinds = map[string]calloutSpec{
	"note":      {Tone: "note", Label: "Note"},
	"info":      {Tone: "note", Label: "Info"},
	"tip":       {Tone: "tip", Label: "Tip"},
	"success":   {Tone: "tip", Label: "Success"},
	"warning":   {Tone: "warning", Label: "Warning"},
	"caution":   {Tone: "warning", Label: "Caution"},
	"danger":    {Tone: "danger", Label: "Danger"},
	"error":     {Tone: "danger", Label: "Error"},
	"important": {Tone: "danger", Label: "Important"},
	"callout":   {Tone: "note", Label: "Callout"},
	"details":   {Tone: "details", Label: "Details"},
}

type blockPlaceholder struct {
	Token string
	HTML  string
}

// preprocessBlocks transforms container directives, GitHub alerts, leaf media directives,
// and display $$...$$ math blocks outside fenced code blocks into Goldmark-safe HTML tokens.
func preprocessBlocks(src string, renderSub func(md string) string) (string, []blockPlaceholder) {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	var out []string
	var placeholders []blockPlaceholder
	addPlaceholder := func(htmlSnippet string) string {
		tok := fmt.Sprintf("INKBRANCHBLOCKPLACEHOLDER%06dEND", len(placeholders))
		placeholders = append(placeholders, blockPlaceholder{Token: tok, HTML: htmlSnippet})
		return "\n" + tok + "\n"
	}

	inFence := false
	fenceChar := byte(0)
	fenceLen := 0

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)

		if ch, flen := detectCodeFence(trimmed); flen > 0 {
			if !inFence {
				inFence = true
				fenceChar = ch
				fenceLen = flen
			} else if ch == fenceChar && flen >= fenceLen && strings.TrimSpace(strings.TrimLeft(trimmed, string(ch))) == "" {
				inFence = false
			}
			out = append(out, line)
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}

		// Display math block: $$ ... $$ (single-line or multi-line).
		if strings.HasPrefix(trimmed, "$$") {
			if len(trimmed) > 4 && strings.HasSuffix(trimmed, "$$") {
				expr := strings.TrimSpace(trimmed[2 : len(trimmed)-2])
				out = append(out, addPlaceholder(`<div class="math-display" data-math="display">`+stdhtml.EscapeString(expr)+`</div>`))
				continue
			}
			var mathLines []string
			restFirst := strings.TrimSpace(strings.TrimPrefix(trimmed, "$$"))
			if restFirst != "" {
				mathLines = append(mathLines, restFirst)
			}
			closed := false
			j := i + 1
			for ; j < len(lines); j++ {
				t2 := strings.TrimSpace(lines[j])
				if strings.HasSuffix(t2, "$$") {
					before := strings.TrimSpace(strings.TrimSuffix(t2, "$$"))
					if before != "" {
						mathLines = append(mathLines, before)
					}
					closed = true
					break
				}
				mathLines = append(mathLines, lines[j])
			}
			if closed {
				out = append(out, addPlaceholder(`<div class="math-display" data-math="display">`+stdhtml.EscapeString(strings.Join(mathLines, "\n"))+`</div>`))
				i = j
				continue
			}
		}

		// Leaf directives: ::video{src="..."} / ::audio{src="..."} / ::embed{src="..."}
		if m := leafDirectiveRegex.FindStringSubmatch(trimmed); m != nil {
			if htmlStr := renderLeafDirective(m[1], parseDirectiveAttrs(m[2])); htmlStr != "" {
				out = append(out, addPlaceholder(htmlStr))
			}
			continue
		}

		// Container directives: :::note[...] / ::::warning[...] / ::::tabs / :::file-tree
		if m := containerOpenRegex.FindStringSubmatch(trimmed); m != nil {
			colons := len(m[1])
			name := strings.ToLower(m[2])
			bracketLabel := strings.TrimSpace(m[3])
			attrs := parseDirectiveAttrs(m[4])

			closeIdx := findDirectiveClose(lines, i+1, colons)
			if closeIdx > i {
				inner := strings.Join(lines[i+1:closeIdx], "\n")
				rendered := renderContainerDirective(name, bracketLabel, attrs, inner, renderSub)
				if rendered != "" {
					out = append(out, addPlaceholder(rendered))
					i = closeIdx
					continue
				}
			}
		}

		// GitHub alerts: > [!NOTE]
		if m := ghAlertOpenRegex.FindStringSubmatch(trimmed); m != nil {
			kind := strings.ToLower(m[1])
			var bodyLines []string
			if first := strings.TrimSpace(m[2]); first != "" {
				bodyLines = append(bodyLines, first)
			}
			j := i + 1
			for ; j < len(lines); j++ {
				t2 := strings.TrimSpace(lines[j])
				if !strings.HasPrefix(t2, ">") {
					break
				}
				bodyLines = append(bodyLines, strings.TrimSpace(strings.TrimPrefix(t2, ">")))
			}
			innerHTML := renderSub(strings.Join(bodyLines, "\n"))
			spec := calloutKinds[kind]
			htmlStr := fmt.Sprintf(
				`<aside class="md-callout md-callout-%s"><div class="md-callout-title">%s</div><div class="md-callout-body">%s</div></aside>`,
				spec.Tone, stdhtml.EscapeString(spec.Label), innerHTML,
			)
			out = append(out, addPlaceholder(htmlStr))
			i = j - 1
			continue
		}

		out = append(out, line)
	}

	return strings.Join(out, "\n"), placeholders
}

func detectCodeFence(trimmed string) (byte, int) {
	if len(trimmed) < 3 {
		return 0, 0
	}
	ch := trimmed[0]
	if ch != '`' && ch != '~' {
		return 0, 0
	}
	n := 0
	for n < len(trimmed) && trimmed[n] == ch {
		n++
	}
	if n >= 3 {
		return ch, n
	}
	return 0, 0
}

func findDirectiveClose(lines []string, start int, outerColons int) int {
	inFence := false
	fenceChar := byte(0)
	fenceLen := 0
	nestedDepth := 0

	for i := start; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if ch, flen := detectCodeFence(trimmed); flen > 0 {
			if !inFence {
				inFence = true
				fenceChar = ch
				fenceLen = flen
			} else if ch == fenceChar && flen >= fenceLen {
				inFence = false
			}
			continue
		}
		if inFence {
			continue
		}
		if m := containerOpenRegex.FindStringSubmatch(trimmed); m != nil {
			nestedDepth++
			continue
		}
		if isPureColonFence(trimmed) {
			n := len(trimmed)
			if nestedDepth > 0 && n < outerColons {
				nestedDepth--
				continue
			}
			if n >= outerColons {
				return i
			}
			if nestedDepth > 0 {
				nestedDepth--
			}
		}
	}
	return -1
}

func isPureColonFence(trimmed string) bool {
	if len(trimmed) < 3 {
		return false
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] != ':' {
			return false
		}
	}
	return true
}

func renderContainerDirective(name, bracketLabel string, attrs map[string]string, inner string, renderSub func(string) string) string {
	if name == "file-tree" {
		return `<pre class="md-file-tree" role="region" aria-label="File tree" tabindex="0"><code>` + stdhtml.EscapeString(strings.Trim(inner, "\n")) + `</code></pre>`
	}
	if name == "tabs" {
		return renderTabsDirective(inner, renderSub)
	}
	spec, ok := calloutKinds[name]
	if !ok {
		return ""
	}
	title := bracketLabel
	if t := attrs["title"]; t != "" {
		title = t
	}
	if title == "" {
		title = spec.Label
	}
	innerHTML := renderSub(inner)
	if name == "details" {
		return fmt.Sprintf(
			`<details class="md-details"><summary class="md-details-summary">%s</summary><div class="md-details-body">%s</div></details>`,
			stdhtml.EscapeString(title), innerHTML,
		)
	}
	return fmt.Sprintf(
		`<aside class="md-callout md-callout-%s"><div class="md-callout-title">%s</div><div class="md-callout-body">%s</div></aside>`,
		spec.Tone, stdhtml.EscapeString(title), innerHTML,
	)
}

func renderTabsDirective(inner string, renderSub func(string) string) string {
	type tabItem struct {
		Label string
		Body  string
	}
	lines := strings.Split(inner, "\n")
	var tabs []tabItem
	for i := 0; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		m := containerOpenRegex.FindStringSubmatch(trimmed)
		if m != nil && strings.ToLower(m[2]) == "tab" {
			colons := len(m[1])
			attrs := parseDirectiveAttrs(m[4])
			label := strings.TrimSpace(m[3])
			if attrs["label"] != "" {
				label = attrs["label"]
			}
			if label == "" {
				label = "Tab"
			}
			closeIdx := findDirectiveClose(lines, i+1, colons)
			if closeIdx > i {
				tabs = append(tabs, tabItem{
					Label: label,
					Body:  strings.Join(lines[i+1:closeIdx], "\n"),
				})
				i = closeIdx
			}
		}
	}
	if len(tabs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(`<div class="md-tabs" data-tabs="true">`)
	b.WriteString(`<div class="md-tab-list" role="tablist">`)
	for idx, tab := range tabs {
		active := ""
		selected := "false"
		if idx == 0 {
			active = " is-active"
			selected = "true"
		}
		_, _ = fmt.Fprintf(&b, `<button type="button" role="tab" aria-selected="%s" class="md-tab-button%s" data-tab-index="%d">%s</button>`,
			selected, active, idx, stdhtml.EscapeString(tab.Label))
	}
	b.WriteString(`</div>`)
	for idx, tab := range tabs {
		hidden := ""
		if idx > 0 {
			hidden = ` hidden`
		}
		_, _ = fmt.Fprintf(&b, `<div role="tabpanel" class="md-tab-panel" data-tab-panel="%d"%s>%s</div>`,
			idx, hidden, renderSub(tab.Body))
	}
	b.WriteString(`</div>`)
	return b.String()
}

func renderLeafDirective(kind string, attrs map[string]string) string {
	src := strings.TrimSpace(attrs["src"])
	if src == "" || !content.IsSafeURL(src) {
		return ""
	}
	switch kind {
	case "video":
		posterAttr := ""
		if p := strings.TrimSpace(attrs["poster"]); p != "" && content.IsSafeURL(p) {
			posterAttr = fmt.Sprintf(` poster="%s"`, stdhtml.EscapeString(p))
		}
		return fmt.Sprintf(`<video class="md-video" src="%s"%s controls preload="metadata"></video>`, stdhtml.EscapeString(src), posterAttr)
	case "audio":
		return fmt.Sprintf(`<audio class="md-audio" src="%s" controls preload="metadata"></audio>`, stdhtml.EscapeString(src))
	case "embed", "iframe":
		if !isAllowedEmbedOrigin(src) {
			return ""
		}
		title := attrs["title"]
		if title == "" {
			title = "Embedded content"
		}
		return fmt.Sprintf(
			`<iframe class="md-embed" src="%s" title="%s" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`,
			stdhtml.EscapeString(src), stdhtml.EscapeString(title),
		)
	default:
		return ""
	}
}

func parseDirectiveAttrs(raw string) map[string]string {
	attrs := make(map[string]string)
	for _, m := range attrPairRegex.FindAllStringSubmatch(raw, -1) {
		key := strings.ToLower(m[1])
		val := m[3]
		if val == "" {
			val = m[4]
		}
		if val == "" {
			val = m[5]
		}
		attrs[key] = val
	}
	return attrs
}

// inlineMathParser protects `$...$` expressions inside Goldmark so emphasis/underscore never mangles LaTeX.
type inlineMathNode struct {
	ast.BaseInline
	Expr string
}

func (n *inlineMathNode) Kind() ast.NodeKind { return kindInlineMath }
func (n *inlineMathNode) Dump(src []byte, level int) {
	ast.DumpHelper(n, src, level, map[string]string{"Expr": n.Expr}, nil)
}

type inlineMathParser struct{}

func (p *inlineMathParser) Trigger() []byte { return []byte{'$'} }

func (p *inlineMathParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, _ := block.PeekLine()
	if len(line) < 3 || line[0] != '$' || line[1] == '$' || line[1] == ' ' || line[1] == '\t' {
		return nil
	}
	for i := 1; i < len(line); i++ {
		if line[i] == '\n' {
			return nil
		}
		if line[i] == '$' && line[i-1] != '\\' && line[i-1] != ' ' && line[i-1] != '\t' {
			// Avoid matching paired currency values like `$5 and $10`.
			if i+1 < len(line) && line[i+1] >= '0' && line[i+1] <= '9' {
				return nil
			}
			expr := string(line[1:i])
			if strings.TrimSpace(expr) == "" {
				return nil
			}
			block.Advance(i + 1)
			return &inlineMathNode{Expr: expr}
		}
	}
	return nil
}

type textDirectiveNode struct {
	ast.BaseInline
	Tag   string
	Label string
}

func (n *textDirectiveNode) Kind() ast.NodeKind { return kindTextDirective }
func (n *textDirectiveNode) Dump(src []byte, level int) {
	ast.DumpHelper(n, src, level, map[string]string{"Tag": n.Tag, "Label": n.Label}, nil)
}

type textDirectiveParser struct{}

func (p *textDirectiveParser) Trigger() []byte { return []byte{':'} }

func (p *textDirectiveParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, _ := block.PeekLine()
	if !bytes.HasPrefix(line, []byte(":")) {
		return nil
	}
	for _, prefix := range []string{":kbd[", ":key[", ":mark[", ":abbr[", ":sup[", ":sub["} {
		if bytes.HasPrefix(line, []byte(prefix)) {
			rest := line[len(prefix):]
			closeIdx := bytes.IndexByte(rest, ']')
			if closeIdx > 0 {
				if bytes.IndexByte(rest[:closeIdx], '\n') >= 0 {
					return nil
				}
				tag := strings.TrimSuffix(strings.TrimPrefix(prefix, ":"), "[")
				if tag == "key" {
					tag = "kbd"
				}
				contentText := string(rest[:closeIdx])
				block.Advance(len(prefix) + closeIdx + 1)
				return &textDirectiveNode{Tag: tag, Label: contentText}
			}
		}
	}
	return nil
}

type directiveInlineRenderer struct{}

func newDirectiveInlineRenderer() renderer.NodeRenderer {
	return &directiveInlineRenderer{}
}

func (r *directiveInlineRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(kindInlineMath, r.renderMath)
	reg.Register(kindTextDirective, r.renderTextDirective)
}

func (r *directiveInlineRenderer) renderMath(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*inlineMathNode)
	_, _ = w.WriteString(`<span class="math-inline" data-math="inline">`)
	_, _ = w.WriteString(stdhtml.EscapeString(n.Expr))
	_, _ = w.WriteString(`</span>`)
	return ast.WalkSkipChildren, nil
}

func (r *directiveInlineRenderer) renderTextDirective(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*textDirectiveNode)
	cls := ""
	if n.Tag == "kbd" {
		cls = ` class="md-kbd"`
	}
	_, _ = fmt.Fprintf(w, `<%s%s>%s</%s>`, n.Tag, cls, stdhtml.EscapeString(n.Label), n.Tag)
	return ast.WalkSkipChildren, nil
}
