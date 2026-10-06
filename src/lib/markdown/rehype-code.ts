import { toString as hastToString } from 'hast-util-to-string'
import type { Element, ElementContent, Parent, Root, RootContent } from 'hast'
import type { ShikiTransformer } from 'shiki'
import { visit } from 'unist-util-visit'
import { parseCodeFenceMeta } from './code-meta'
import {
  TOKENIZE_TIME_LIMIT,
  getHighlighter,
  getThemes,
  resolveLanguage,
} from './shiki'

/**
 * Rehype plugin: render every fenced code block with Shiki on the server.
 *
 * Produces a `<figure>` with a header (filename + copy button) and a `<pre>`
 * carrying both colour palettes as CSS custom properties. The copy button is
 * inert markup here; a single delegated client component wires up every one of
 * them on the page, so an article with twenty snippets still ships one
 * hydration boundary.
 *
 * Mermaid blocks are an exception: they are not highlighted, only marked, and
 * the diagram is rendered by a lazily imported client module.
 */

/** Raw source text is base64'd into a data attribute for the Mermaid renderer. */
function encodeSource(source: string): string {
  return Buffer.from(source, 'utf8').toString('base64')
}

export function rehypeCode() {
  return async (tree: Root): Promise<void> => {
    // Collect first: `visit` is synchronous and the work below is not.
    const targets: { parent: Parent; index: number; node: Element }[] = []

    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre') return
      if (!parent || index === undefined) return
      targets.push({ parent, index, node })
    })

    if (targets.length === 0) return

    const [highlighter, themes] = await Promise.all([getHighlighter(), getThemes()])

    // Process in reverse so earlier indices stay valid as nodes are replaced.
    for (const target of targets.reverse()) {
      const codeElement = target.node.children.find(
        (child): child is Element =>
          child.type === 'element' && child.tagName === 'code',
      )
      if (!codeElement) continue

      const source = hastToString(codeElement)
      const languageClass = extractLanguageClass(codeElement)
      const rawMeta = extractMeta(codeElement)
      const meta = parseCodeFenceMeta(rawMeta, languageClass)

      let replacement: ElementContent

      if (meta.isMermaid) {
        replacement = buildMermaidBlock(source)
      } else {
        const language = await resolveLanguage(languageClass)
        replacement = await buildCodeFigure({
          highlighter,
          themes,
          source,
          language,
          languageLabel: languageClass,
          meta,
        })
      }

      target.parent.children[target.index] = replacement
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                 */
/* -------------------------------------------------------------------------- */

function extractLanguageClass(codeElement: Element): string | undefined {
  const className = codeElement.properties.className
  if (!Array.isArray(className)) return undefined
  for (const value of className) {
    if (typeof value === 'string' && value.startsWith('language-')) {
      return value.slice('language-'.length)
    }
  }
  return undefined
}

/**
 * Attribute the fence meta travels on between the two passes.
 *
 * `remark-rehype` parks it on `element.data.meta`, and `rehype-raw` cannot
 * carry a node's `data` field — raw HTML has no representation for it, and the
 * whole tree is round-tripped through parse5. Moving it onto a real attribute
 * first is what lets it survive to here. It never reaches the page: the whole
 * `<pre>` is replaced by a `<figure>` below.
 */
const META_PROPERTY = 'dataCodeMeta'

/**
 * Copy each code fence's meta string onto an attribute.
 *
 * Runs immediately after the mdast→hast conversion and before `rehype-raw`,
 * for the reason above. Without it every `title=`, line-highlight and diff
 * annotation in the site's Markdown is silently dropped.
 */
export function rehypeCaptureCodeMeta() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'code') return
      const data = node.data as { meta?: unknown } | undefined
      if (typeof data?.meta !== 'string' || data.meta === '') return
      node.properties[META_PROPERTY] = data.meta
    })
  }
}

function extractMeta(codeElement: Element): string | undefined {
  const meta = codeElement.properties[META_PROPERTY]
  return typeof meta === 'string' && meta !== '' ? meta : undefined
}

/* -------------------------------------------------------------------------- */
/*  Code figure                                                                */
/* -------------------------------------------------------------------------- */

interface BuildCodeInput {
  highlighter: Awaited<ReturnType<typeof getHighlighter>>
  themes: Awaited<ReturnType<typeof getThemes>>
  source: string
  language: string | null
  languageLabel: string | undefined
  meta: ReturnType<typeof parseCodeFenceMeta>
}

async function buildCodeFigure(input: BuildCodeInput): Promise<Element> {
  const { highlighter, themes, source, language, languageLabel, meta } = input

  const highlightSet = new Set(meta.highlightLines)

  const transformer: ShikiTransformer = {
    line(node, lineNumber) {
      const displayNumber = meta.startLine + lineNumber - 1
      node.properties.dataLine = String(displayNumber)

      const classes = new Set<string>(['code-line'])
      if (highlightSet.has(displayNumber) || highlightSet.has(lineNumber)) {
        classes.add('is-highlighted')
      }

      if (meta.isDiff) {
        // A changed hunk's marker is the first character of the rendered line.
        const text = hastToString(node)
        if (text.startsWith('+')) classes.add('is-diff-add')
        else if (text.startsWith('-')) classes.add('is-diff-remove')
      }

      node.properties.class = [...classes].join(' ')
    },
  }

  const root: Root = language
    ? highlighter.codeToHast(source, {
        lang: language,
        themes,
        // Emit only the CSS variables; the palette is chosen in CSS so that
        // theme switching costs nothing.
        defaultColor: false,
        // Shiki's 500 ms default is a cliff, not a margin, for the first
        // tokenisation after a restart — and the render that falls off it is
        // wrong rather than slow. `TOKENIZE_TIME_LIMIT` has the measurements.
        tokenizeTimeLimit: TOKENIZE_TIME_LIMIT,
        transformers: [transformer],
      })
    : plainTextHast(source, meta)

  const pre = root.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'pre',
  )
  if (!pre) throw new Error('Shiki did not produce a <pre> element')

  // Shiki already sets `tabindex="0"` on the `<pre>` so a horizontally
  // scrolling region is reachable by keyboard. Setting `tabIndex` here as well
  // would add a *second* key that serialises to the same attribute, producing
  // `<pre tabindex="0" tabindex="0">`.
  pre.properties.dataLanguage = language ?? 'text'

  const classes = new Set<string>(
    String(pre.properties.class ?? '')
      .split(/\s+/)
      .filter(Boolean),
  )
  classes.add('code-block__pre')
  if (meta.showLineNumbers) classes.add('has-line-numbers')
  if (meta.isDiff) classes.add('is-diff')
  if (meta.isTerminal) classes.add('is-terminal')
  pre.properties.class = [...classes].join(' ')

  if (meta.highlightWords.length > 0) {
    applyWordHighlights(pre, meta.highlightWords)
  }

  const children: ElementContent[] = []

  const header = buildHeader(meta, languageLabel, language)
  if (header) children.push(header)

  children.push(pre)

  return element(
    'figure',
    {
      className: ['code-block'],
      dataLanguage: language ?? 'text',
      ...(meta.title ? { dataTitle: meta.title } : {}),
    },
    children,
  )
}

/** Fallback for an unknown language: still styled, just not tokenised. */
function plainTextHast(source: string, meta: ReturnType<typeof parseCodeFenceMeta>): Root {
  const lines = source.replace(/\n$/, '').split('\n')
  const children: ElementContent[] = lines.flatMap((line, index): ElementContent[] => {
    const displayNumber = meta.startLine + index
    const classes = new Set<string>(['code-line'])
    if (meta.highlightLines.includes(displayNumber)) classes.add('is-highlighted')
    if (meta.isDiff && line.startsWith('+')) classes.add('is-diff-add')
    else if (meta.isDiff && line.startsWith('-')) classes.add('is-diff-remove')

    const span = element(
      'span',
      {
        className: [...classes].join(' '),
        dataLine: String(displayNumber),
      },
      line ? [{ type: 'text', value: line }] : [],
    )
    // Copy reads textContent, so the visual line boxes also need real newline
    // text, including the source's trailing newline, just as Shiki emits it.
    return [span, ...(index < lines.length - 1 || source.endsWith('\n')
      ? [{ type: 'text' as const, value: '\n' }]
      : [])]
  })

  return {
    type: 'root',
    children: [
      element(
        'pre',
        {
          className: ['shiki'],
          style: 'background-color:var(--shiki-bg);color:var(--shiki-fg)',
          // Matches what Shiki sets on the highlighted path, so an unknown
          // language still yields a keyboard-reachable scroll region.
          tabindex: '0',
        },
        [element('code', {}, children)],
      ),
    ],
  }
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                     */
/* -------------------------------------------------------------------------- */

function buildHeader(
  meta: ReturnType<typeof parseCodeFenceMeta>,
  languageLabel: string | undefined,
  resolvedLanguage: string | null,
): Element | null {
  const label = meta.badge ?? meta.title ?? (languageLabel || resolvedLanguage)

  // A bare block with no name and no language gets no chrome at all.
  if (!label && !meta.isTerminal) return null

  const children: ElementContent[] = []

  if (meta.title) {
    children.push(
      element('span', { className: ['code-block__title'] }, [
        { type: 'text', value: meta.title },
      ]),
    )
  }

  const badgeText = meta.badge ?? languageLabel ?? resolvedLanguage
  if (badgeText && !meta.isTerminal) {
    children.push(
      element('span', { className: ['code-block__badge'] }, [
        { type: 'text', value: badgeText },
      ]),
    )
  }

  children.push(
    element(
      'button',
      {
        type: 'button',
        className: ['code-block__copy'],
        dataCodeCopy: '',
        ariaLabel: meta.title ? `Copy ${meta.title}` : 'Copy code',
      },
      // Inline icons keep the block a single server-rendered unit; the client
      // component only toggles which one is visible.
      [
        copyIcon(),
        element(
          'svg',
          {
            className: ['code-block__copy-done'],
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '2',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            ariaHidden: 'true',
          },
          [element('path', { d: 'M20 6 9 17l-5-5' })],
        ),
      ],
    ),
  )

  return element(
    'figcaption',
    { className: ['code-block__header'] },
    children,
  )
}

function copyIcon(): Element {
  return element(
    'svg',
    {
      className: ['code-block__copy-idle'],
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      ariaHidden: 'true',
    },
    [
      element('rect', { width: '14', height: '14', x: '8', y: '8', rx: '2' }),
      element('path', {
        d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
      }),
    ],
  )
}

/* -------------------------------------------------------------------------- */
/*  Word highlighting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Wrap occurrences of each term in `<mark>`.
 *
 * Runs on the hast tree rather than on the HTML string so that a term is never
 * injected across a tag boundary — which is what a naive string replace would
 * do, producing broken markup.
 */
function applyWordHighlights(root: Element, words: string[]): void {
  const matcher = buildWordMatcher(words)
  if (!matcher) return

  const textNodes: { parent: Parent; index: number; node: { value: string } }[] = []

  visit(root, 'text', (node, index, parent) => {
    if (!parent || index === undefined) return
    if (matcher.test(node.value)) {
      textNodes.push({ parent, index, node })
    }
    // Reset `lastIndex`: the regex is global and stateful between calls.
    matcher.lastIndex = 0
  })

  for (const target of textNodes.reverse()) {
    const parts = splitOnMatches(target.node.value, matcher)
    // Shiki commonly emits an identifier as its own text node. A single part
    // can therefore be the entire highlighted token, rather than no match.
    if (!parts.some((part) => part.highlighted)) continue

    const replacement: ElementContent[] = parts.map((part) =>
      part.highlighted
        ? element('mark', { className: ['code-word-highlight'] }, [
            { type: 'text', value: part.text },
          ])
        : { type: 'text', value: part.text },
    )

    target.parent.children.splice(target.index, 1, ...replacement)
  }
}

function buildWordMatcher(words: string[]): RegExp | null {
  const escaped = words
    .map((word) => word.trim())
    .filter(Boolean)
    .map(escapeRegExp)
  if (escaped.length === 0) return null
  // Longest first, so `retryCount` wins over `retry`.
  escaped.sort((a, b) => b.length - a.length)
  return new RegExp(`(${escaped.join('|')})`, 'g')
}

interface TextPart {
  text: string
  highlighted: boolean
}

function splitOnMatches(value: string, matcher: RegExp): TextPart[] {
  const parts: TextPart[] = []
  let lastIndex = 0
  matcher.lastIndex = 0

  for (const match of value.matchAll(matcher)) {
    const index = match.index
    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), highlighted: false })
    }
    parts.push({ text: match[0], highlighted: true })
    lastIndex = index + match[0].length
  }

  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex), highlighted: false })
  }

  return parts.length === 0 ? [{ text: value, highlighted: false }] : parts
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* -------------------------------------------------------------------------- */
/*  Mermaid                                                                    */
/* -------------------------------------------------------------------------- */

function buildMermaidBlock(source: string): Element {
  // The source is base64'd so that braces, quotes and `<` survive the round
  // trip through an HTML attribute untouched.
  return element(
    'div',
    {
      className: ['mermaid-block'],
      dataMermaid: encodeSource(source),
      role: 'img',
      ariaLabel: 'Diagram',
    },
    // Visible fallback for readers without JavaScript: the source, in a block
    // a human can still read.
    [
      element('noscript', {}, [
        element('pre', { className: ['mermaid-block__source'] }, [
          { type: 'text', value: source },
        ]),
      ]),
    ],
  )
}

/* -------------------------------------------------------------------------- */
/*  Element helper                                                             */
/* -------------------------------------------------------------------------- */

function element(
  tagName: string,
  properties: Record<string, string | number | (string | number)[] | boolean>,
  children: ElementContent[] = [],
): Element {
  return {
    type: 'element',
    tagName,
    properties: properties as Element['properties'],
    children,
  }
}

export type { RootContent }
