package markdown

import (
	"bytes"
	"fmt"
	stdhtml "html"
	"strings"
	"sync/atomic"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/util"
)

const collapsibleLineThreshold = 30

// codeBlockRenderer renders fenced and indented code blocks using Chroma v2 server-side
// syntax highlighting wrapped in accessible <figure>/<figcaption>/<pre role="region"> markup.
type codeBlockRenderer struct {
	seq atomic.Uint64
}

func newCodeBlockRenderer() *codeBlockRenderer {
	return &codeBlockRenderer{}
}

func (r *codeBlockRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindFencedCodeBlock, r.renderFencedCodeBlock)
	reg.Register(ast.KindCodeBlock, r.renderIndentedCodeBlock)
}

func (r *codeBlockRenderer) renderFencedCodeBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.FencedCodeBlock)
	var info string
	if n.Info != nil {
		info = string(n.Info.Value(source))
	}
	meta := ParseCodeFenceMeta(info)
	rawCode := extractNodeLines(n, source)
	r.writeCodeFigure(w, rawCode, meta)
	return ast.WalkSkipChildren, nil
}

func (r *codeBlockRenderer) renderIndentedCodeBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.CodeBlock)
	rawCode := extractNodeLines(n, source)
	r.writeCodeFigure(w, rawCode, ParseCodeFenceMeta(""))
	return ast.WalkSkipChildren, nil
}

func (r *codeBlockRenderer) writeCodeFigure(w util.BufWriter, rawCode string, meta FenceMeta) {
	trimmed := strings.TrimSuffix(rawCode, "\n")

	if meta.IsMermaid {
		escaped := stdhtml.EscapeString(trimmed)
		_, _ = fmt.Fprintf(w, `<div class="md-mermaid" data-mermaid="%s"><pre class="md-mermaid-source"><code>%s</code></pre></div>`+"\n", escaped, escaped)
		return
	}

	id := r.seq.Add(1)
	captionID := fmt.Sprintf("code-block-%d", id)

	lexerLang := meta.Language
	if meta.IsTerminal && (lexerLang == "terminal" || lexerLang == "console" || lexerLang == "shellsession") {
		lexerLang = "bash"
	}

	lexer := lexers.Get(lexerLang)
	if lexer == nil {
		lexer = lexers.Fallback
	}
	lexer = chroma.Coalesce(lexer)

	var lineTokens [][]chroma.Token
	if iter, err := lexer.Tokenise(nil, trimmed); err == nil {
		lineTokens = chroma.SplitTokensIntoLines(iter.Tokens())
	} else {
		for _, line := range strings.Split(trimmed, "\n") {
			lineTokens = append(lineTokens, []chroma.Token{{Type: chroma.None, Value: line}})
		}
	}

	totalLines := len(lineTokens)
	if totalLines == 0 {
		lineTokens = [][]chroma.Token{{}}
		totalLines = 1
	}

	_, _ = w.WriteString(`<figure class="md-code-block"`)
	if meta.Language != "" {
		_, _ = fmt.Fprintf(w, ` data-lang="%s"`, stdhtml.EscapeString(meta.Language))
	}
	if meta.IsTerminal {
		_, _ = w.WriteString(` data-terminal="true"`)
	}
	if totalLines > collapsibleLineThreshold {
		_, _ = w.WriteString(` data-collapsible="true"`)
	}
	_, _ = w.WriteString(">\n")

	labelText := meta.Title
	if labelText == "" {
		if meta.IsTerminal {
			labelText = "Terminal"
		} else if meta.Badge != "" {
			labelText = strings.ToUpper(meta.Badge)
		} else {
			labelText = "Code"
		}
	}

	_, _ = fmt.Fprintf(w, `  <figcaption id="%s" class="md-code-header">`, captionID)
	_, _ = fmt.Fprintf(w, `<span class="md-code-title">%s</span>`, stdhtml.EscapeString(labelText))
	if meta.Badge != "" && meta.Title != "" {
		_, _ = fmt.Fprintf(w, `<span class="md-code-badge">%s</span>`, stdhtml.EscapeString(meta.Badge))
	}
	_, _ = w.WriteString(`<button type="button" class="md-code-copy" data-copy-code="true" aria-label="Copy code">Copy</button>`)
	_, _ = w.WriteString("</figcaption>\n")

	_, _ = fmt.Fprintf(w, `  <pre role="region" aria-labelledby="%s" tabindex="0"><code class="chroma`, captionID)
	if meta.Language != "" {
		_, _ = fmt.Fprintf(w, ` language-%s`, stdhtml.EscapeString(meta.Language))
	}
	_, _ = w.WriteString(`">`)

	for i, toks := range lineTokens {
		lineNum := meta.StartLine + i
		plainLine := tokensPlainText(toks)
		trimmedNoCR := strings.TrimSuffix(plainLine, "\n")

		var classes []string
		classes = append(classes, "md-code-line")
		if meta.HighlightLines[lineNum] {
			classes = append(classes, "is-highlighted")
		}
		if meta.IsDiff {
			if strings.HasPrefix(trimmedNoCR, "+") && !strings.HasPrefix(trimmedNoCR, "+++") {
				classes = append(classes, "is-diff-add")
			} else if strings.HasPrefix(trimmedNoCR, "-") && !strings.HasPrefix(trimmedNoCR, "---") {
				classes = append(classes, "is-diff-del")
			}
		}

		_, _ = fmt.Fprintf(w, `<span class="%s" data-line="%d">`, strings.Join(classes, " "), lineNum)
		if meta.ShowLineNumbers {
			_, _ = fmt.Fprintf(w, `<span class="md-ln" aria-hidden="true">%d</span>`, lineNum)
		}
		_, _ = w.WriteString(`<span class="md-cl">`)

		var lineHTML bytes.Buffer
		for _, tok := range toks {
			val := strings.TrimSuffix(tok.Value, "\n")
			if val == "" {
				continue
			}
			escaped := stdhtml.EscapeString(val)
			cls := chroma.StandardTypes[tok.Type]
			if cls != "" && cls != "x" {
				lineHTML.WriteString(`<span class="`)
				lineHTML.WriteString(cls)
				lineHTML.WriteString(`">`)
				lineHTML.WriteString(escaped)
				lineHTML.WriteString(`</span>`)
			} else {
				lineHTML.WriteString(escaped)
			}
		}

		rendered := lineHTML.String()
		if len(meta.HighlightWords) > 0 {
			for _, word := range meta.HighlightWords {
				escWord := stdhtml.EscapeString(word)
				if escWord != "" {
					rendered = strings.ReplaceAll(rendered, escWord, `<mark class="md-code-word">`+escWord+`</mark>`)
				}
			}
		}
		_, _ = w.WriteString(rendered)
		_, _ = w.WriteString("</span>\n</span>")
	}

	_, _ = w.WriteString("</code></pre>\n</figure>\n")
}

func extractNodeLines(n ast.Node, source []byte) string {
	var buf bytes.Buffer
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		buf.Write(seg.Value(source))
	}
	return buf.String()
}

func tokensPlainText(toks []chroma.Token) string {
	var b strings.Builder
	for _, t := range toks {
		b.WriteString(t.Value)
	}
	return b.String()
}
