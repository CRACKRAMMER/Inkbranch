import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/lib/markdown/renderer'

/** Collapse whitespace between tags so two renderings can be compared. */
function collapse(html: string): string {
  return html.replace(/>\s+</g, '><').trim()
}

/**
 * The renderer is the one place where untrusted-by-default input (Markdown,
 * including raw HTML) becomes markup injected with `dangerouslySetInnerHTML`.
 * These tests therefore check two things at once: that the features work, and
 * that the sanitiser is actually in the path.
 *
 * The default Shiki theme is loaded once per process, so the first test in this
 * file is slower than the rest.
 */

describe('renderMarkdown — features', () => {
  it('highlights code server-side with both themes present', async () => {
    const { html, features } = await renderMarkdown(
      '```ts title="src/db.ts" {2}\nconst a = 1\nconst b = 2\n```\n',
    )

    expect(features.code).toBe(true)
    // Shiki is configured with `defaultColor: false`, so both palettes ship as
    // CSS variables and switching themes costs no client work.
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
    expect(html).toContain('code-block__header')
    expect(html).toContain('src/db.ts')
    // Line 2 was marked with `{2}`.
    expect(html).toMatch(/data-line="2"[^>]*is-highlighted|is-highlighted[^>]*data-line="2"/)
  })

  it('renders KaTeX from both inline and display math', async () => {
    const { html, features } = await renderMarkdown(
      'Inline $a^2 + b^2 = c^2$ and display:\n\n$$\n\\int_0^1 x^2 dx\n$$\n',
    )

    expect(features.math).toBe(true)
    // MathML is emitted alongside the HTML spans for screen readers.
    expect(html).toContain('class="katex"')
    expect(html).toContain('<math')
    expect(html).toContain('katex-display')
    // The raw TeX must not leak through as text.
    expect(html).not.toContain('math-inline')
  })

  it('does not treat a dollar sign inside a code fence as math', async () => {
    const { html, features } = await renderMarkdown('```sh\ncost=$5\necho $HOME\n```\n')

    expect(features.math).toBe(false)
    expect(html).not.toContain('katex')
  })

  it('marks Mermaid blocks without highlighting them', async () => {
    const { html, features } = await renderMarkdown(
      '```mermaid\ngraph TD\n  A --> B\n```\n',
    )

    expect(features.mermaid).toBe(true)
    expect(features.code).toBe(false)
    expect(html).toContain('data-mermaid=')
    // Source is base64'd into the attribute, so the arrow never appears raw.
    expect(html).not.toContain('A --&gt; B')
    // Readers without JavaScript still get the source.
    expect(html).toContain('<noscript>')
    const encoded = /data-mermaid="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString()).toBe('graph TD\n  A --> B\n')
  })

  it('builds a tablist with roving tabindex', async () => {
    const { html, features } = await renderMarkdown(
      '::::tabs\n:::tab[Install]\nnpm i\n:::\n\n:::tab[Use]\nimport x\n:::\n::::\n',
    )

    expect(features.tabs).toBe(true)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-selected="false"')
    // Exactly one tab is reachable by Tab; the rest are arrow-key navigated.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1)
    expect(html).toContain('Install')
    expect(html).toContain('Use')
  })

  it('renders callouts from both directive and alert syntax', async () => {
    const block = await renderMarkdown(':::warning\nCareful.\n:::\n')
    const alert = await renderMarkdown('> [!WARNING]\n> Careful.\n')

    for (const { html } of [block, alert]) {
      expect(html).toContain('md-callout--warning')
      expect(html).toContain('role="note"')
      expect(html).toContain('Careful.')
    }
    // Both syntaxes must land on the same markup, or the CSS only covers one.
    // Compared with inter-tag whitespace collapsed: the alert path passes
    // through `rehype-raw` (which reformats) and the directive path does not.
    expect(collapse(block.html)).toBe(collapse(alert.html))
  })

  it('renders a GitHub alert with a custom title', async () => {
    const { html } = await renderMarkdown('> [!NOTE] Renamed in v2\n> The old field is gone.\n')
    expect(html).toContain('md-callout__title')
    expect(html).toContain('Renamed in v2')
    expect(html).toContain('The old field is gone.')
  })

  it('leaves an unknown alert marker as an ordinary blockquote', async () => {
    const { html } = await renderMarkdown('> [!SOMETHING]\n> text\n')
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('md-callout')
  })

  it('renders definition lists', async () => {
    const { html } = await renderMarkdown('Term\n: Definition\n')
    expect(html).toContain('<dl')
    expect(html).toContain('<dt')
    expect(html).toContain('<dd')
    expect(html).toContain('Definition')
  })

  it('renders footnotes and reports them', async () => {
    const { html, features } = await renderMarkdown('Text[^1]\n\n[^1]: The note.\n')
    expect(features.footnotes).toBe(true)
    expect(html).toContain('data-footnotes')
    expect(html).toContain('The note.')
    expect(html).toContain('Footnotes')
  })

  it('renders a file tree and inline kbd', async () => {
    const { html } = await renderMarkdown(':::file-tree\nsrc/index.ts\n:::\n\nPress :kbd[Ctrl].\n')
    expect(html).toContain('md-file-tree')
    expect(html).toContain('<kbd')
  })

  it('wraps tables so they can scroll, and marks headings', async () => {
    const { html } = await renderMarkdown('## Setup\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')

    expect(html).toContain('md-table-wrap')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('id="setup"')
    expect(html).toContain('data-heading="setup"')
    expect(html).toContain('md-heading__anchor')
  })

  it('opens external links safely and leaves internal ones alone', async () => {
    const { html } = await renderMarkdown('[out](https://example.com) and [in](/posts/hello)\n')

    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    // The internal link must not have picked up the external treatment.
    expect(html.match(/target="_blank"/g)).toHaveLength(1)
  })

  it('flags an internal link whose target is not in the index', async () => {
    const known = new Set(['posts/exists'])

    const missing = await renderMarkdown('[gone](/posts/nope)\n', { knownSlugs: known })
    expect(missing.html).toContain('md-link--broken')
    expect(missing.html).toContain('data-broken-target="posts/nope"')

    const present = await renderMarkdown('[here](/posts/exists)\n', { knownSlugs: known })
    expect(present.html).not.toContain('md-link--broken')

    // Without a set, nothing is flagged — absence is not the same as empty.
    const unchecked = await renderMarkdown('[gone](/posts/nope)\n')
    expect(unchecked.html).not.toContain('md-link--broken')
  })

  it('keeps an allowed embed and drops a disallowed one', async () => {
    const allowed = await renderMarkdown(
      '::embed{src="https://www.youtube.com/embed/abc" title="Talk"}\n',
    )
    expect(allowed.features.embeds).toBe(true)
    expect(allowed.html).toContain('youtube.com/embed/abc')

    const denied = await renderMarkdown('::embed{src="https://evil.example/steal"}\n')
    expect(denied.features.embeds).toBe(false)
    expect(denied.html).not.toContain('evil.example')
  })
})

describe('renderMarkdown — sanitisation', () => {
  it('drops script tags and their contents', async () => {
    const { html } = await renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter\n')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('before')
    expect(html).toContain('after')
  })

  it('strips event handlers from allowed elements', async () => {
    const { html } = await renderMarkdown('<a href="/x" onclick="alert(1)">link</a>\n')
    expect(html).toContain('href="/x"')
    expect(html).not.toContain('onclick')
  })

  it('rejects javascript: URLs', async () => {
    const { html } = await renderMarkdown('[click](javascript:alert(1))\n')
    expect(html).not.toContain('javascript:')
  })

  it('does not allow a data: URL to smuggle a document', async () => {
    const { html } = await renderMarkdown(
      '<a href="data:text/html,<script>alert(1)</script>">x</a>\n',
    )
    expect(html).not.toContain('data:text/html')
  })

  it('strips an iframe inside raw HTML that is not on the allow-list', async () => {
    const { html } = await renderMarkdown(
      '<iframe src="https://evil.example/x" title="x"></iframe>\n',
    )
    expect(html).not.toContain('evil.example')
  })

  it('neutralises an svg that carries a script', async () => {
    const { html } = await renderMarkdown(
      '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>\n',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('keeps a style attribute but not through a nested expression', async () => {
    // `style` is allowed (KaTeX and Shiki need it) and is not a scripting
    // vector in a modern browser; `on*` on the same element is not.
    const { html } = await renderMarkdown('<span style="color:red" onmouseover="x()">hi</span>\n')
    expect(html).toContain('color:red')
    expect(html).not.toContain('onmouseover')
  })
})

describe('renderMarkdown — structure', () => {
  it('detects no features in plain prose', async () => {
    const { features } = await renderMarkdown('Just a paragraph.\n')
    expect(features).toEqual({
      code: false,
      mermaid: false,
      math: false,
      tabs: false,
      footnotes: false,
      embeds: false,
    })
  })

  it('escapes a stray angle bracket in text', async () => {
    const { html } = await renderMarkdown('5 < 6 and 7 > 2\n')
    // `hast-util-to-html` writes `&#x3C;` rather than `&lt;`; both are the
    // same character, so the assertion is on the parsed result, not the entity.
    expect(html).not.toContain('<6')
    expect(html.replace(/&#x3C;|&lt;/g, '<')).toContain('5 < 6 and 7 > 2')
  })

  it('renders two documents independently', async () => {
    const first = await renderMarkdown('# One\n')
    const second = await renderMarkdown('# Two\n')
    expect(first.html).toContain('id="one"')
    expect(second.html).toContain('id="two"')
    expect(second.html).not.toContain('id="one"')
  })
})
