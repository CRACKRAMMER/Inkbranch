package markdown_test

import (
	"strings"
	"testing"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/markdown"
)

type stubResolver struct{}

func (stubResolver) ResolveTarget(rawTarget string) (content.ContentType, string, string, string, bool) {
	switch rawTarget {
	case "projects/myblog", "myblog":
		return content.TypeProject, "myblog", "Inkbranch", "/projects/myblog", true
	case "why-not-catch":
		return content.TypeNote, "why-not-catch", "Why Not Catch", "/notes/why-not-catch", true
	default:
		return "", "", "", "", false
	}
}

func TestDirectivesPlaceholdersCodeBlocksMathWikilinksAndSanitize(t *testing.T) {
	r := markdown.NewRenderer()
	src := `# Section _Alpha_

:::note[Architecture Note]
Inside **note** with :kbd[Cmd+K] and inline math $k_1 = 1.2$.
:::

::::warning[Nested Callout]
Watch ` + "`_underscores_`" + ` carefully.
::::

::::tabs
:::tab[Go]
` + "```go title=\"main.go\" showLineNumbers {2}\npackage main\nfunc main() {}\n```" + `
:::
:::tab[Mermaid]
` + "```mermaid\ngraph LR\n  A --> B\n```" + `
:::
::::

:::file-tree
cmd/
  inkbranch/main.go
:::

> [!TIP]
> Useful GitHub alert.

$$
score = \sum_{i=1}^n a_i \cdot b_i
$$

Links: [[projects/myblog|Inkbranch]], [[why-not-catch]], [[missing-target]], and inline code ` + "`[[Target]]`" + `.

` + "```diff\n- oldLine\n+ newLine\n```" + `

<script>alert('xss')</script>
<a href="javascript:alert(1)">bad</a>
::iframe{src="https://evil.example/embed"}
::iframe{src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Demo"}
`

	res, err := r.Render("test-key-1", src, stubResolver{})
	if err != nil {
		t.Fatalf("Render failed: %v", err)
	}

	checks := []struct {
		name   string
		substr string
		want   bool
	}{
		{"no placeholder leaks", "INKBRANCHBLOCKPLACEHOLDER", false},
		{"no broken em placeholder", "<em>", true}, // Section _Alpha_ uses valid <em>
		{"note callout", `<aside class="md-callout md-callout-note">`, true},
		{"warning callout", `<aside class="md-callout md-callout-warning">`, true},
		{"tip gh alert", `<aside class="md-callout md-callout-tip">`, true},
		{"tabs container", `<div class="md-tabs" data-tabs="true">`, true},
		{"file tree", `<pre class="md-file-tree" role="region" aria-label="File tree" tabindex="0">`, true},
		{"kbd directive", `<kbd class="md-kbd">Cmd+K</kbd>`, true},
		{"inline math preserved", `<span class="math-inline" data-math="inline">k_1 = 1.2</span>`, true},
		{"display math preserved", `<div class="math-display" data-math="display">`, true},
		{"code header title", `<span class="md-code-title">main.go</span>`, true},
		{"line numbers keep aria-hidden", `<span class="md-ln" aria-hidden="true">1</span>`, true},
		{"highlighted line", `class="md-code-line is-highlighted" data-line="2"`, true},
		{"mermaid preserved", `data-mermaid=`, true},
		{"diff add line", `is-diff-add`, true},
		{"diff del line", `is-diff-del`, true},
		{"resolved project wikilink", `href="/projects/myblog"`, true},
		{"resolved note wikilink", `href="/notes/why-not-catch"`, true},
		{"broken wikilink span", `class="md-wikilink md-wikilink-broken" data-wikilink-target="missing-target"`, true},
		{"inline code wikilink untouched", `<code>[[Target]]</code>`, true},
		{"script tag scrubbed", `<script>`, false},
		{"javascript href scrubbed", `javascript:alert`, false},
		{"disallowed iframe scrubbed", `evil.example`, false},
		{"allowed youtube iframe kept", `https://www.youtube.com/embed/dQw4w9WgXcQ`, true},
	}

	for _, c := range checks {
		got := strings.Contains(res.HTML, c.substr)
		if got != c.want {
			t.Errorf("%s: Contains(%q) = %v, want %v\nHTML:\n%s", c.name, c.substr, got, c.want, res.HTML)
		}
	}

	// Inline code `[[Target]]` must NOT appear in extracted OutgoingLinks.
	for _, l := range res.Links {
		if l.TargetSlug == "Target" || strings.Contains(l.LinkText, "Target") {
			t.Fatalf("inline code wikilink leaked into OutgoingLinks: %+v", l)
		}
	}
	if len(res.Links) != 3 {
		t.Fatalf("expected 3 unique outgoing links, got %d: %+v", len(res.Links), res.Links)
	}
}
