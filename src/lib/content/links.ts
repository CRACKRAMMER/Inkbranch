import { CONTENT_TYPE_DIRS } from './paths'
import type { ContentType } from './schema'
import type { Definition, ImageReference, LinkReference, PhrasingContent } from 'mdast'
import type { Root as HtmlRoot } from 'hast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkDirective from 'remark-directive'
import rehypeRaw from 'rehype-raw'
import { visit } from 'unist-util-visit'

/**
 * Link extraction.
 *
 * Pulls internal references and uploaded media out of raw Markdown. Used for
 * backlinks, broken-link reporting, and "which articles use this image".
 *
 * Written as a scanner rather than a regex sweep so that fenced code blocks and
 * inline code are skipped: `[not a link](/foo)` inside a snippet must not create
 * a phantom backlink.
 */

export type ExtractedLinkKind = 'internal' | 'wiki' | 'image' | 'anchor'

export interface ExtractedLink {
  kind: ExtractedLinkKind
  /** The href exactly as written. */
  href: string
  /**
   * Resolution key.
   *
   * - `internal` — `type/slug`, e.g. `posts/hello`.
   * - `wiki` — the target exactly as written, which may be a bare slug.
   *   See `wikiTargetCandidates` for why it is not normalised here.
   * - `image` — an uploaded image or media path, relative to the upload root.
   * - `anchor` — the fragment, or the site-relative path.
   */
  targetKey: string
  /** Link text, or the image alt text. */
  label: string | null
  /** 1-based source line, for reporting. */
  line: number
}

/**
 * The keys a wiki target could resolve to, most specific first.
 *
 * `[[posts/hello]]` names its type and resolves to exactly one key.
 * `[[hello]]` does not, and that ambiguity is genuinely in the source — the
 * same slug can exist as a post and as a note. This module cannot settle it,
 * because it never sees the content index. So it reports the *candidates* and
 * lets the resolver, which does have the index, pick the one that exists.
 *
 * The alternative — dropping the link because the type is unknown — was the
 * original behaviour and it is worse: the reference is real and the author
 * wrote it, so the reader sees those characters on the page whether or not
 * anything resolves them. Dropping it would lose the only record of a link
 * that is plainly there to be fixed.
 */
export function wikiTargetCandidates(targetKey: string): string[] {
  const trimmed = targetKey.trim().replace(/^\/+/, '')
  if (!trimmed) return []
  if (trimmed.includes('/')) return [trimmed]

  const slug = trimmed.toLowerCase()
  // Directory order, not preference: `CONTENT_TYPE_DIRS` is the one place the
  // type-to-directory mapping lives, and a slug present under more than one
  // type is reported by the link checker rather than guessed at silently.
  return Object.values(CONTENT_TYPE_DIRS).map((dir) => `${dir}/${slug}`)
}

/**
 * What one scan found.
 *
 * `links` holds only what the index can act on. A reference it cannot resolve —
 * an off-site URL, a `mailto:`, an external `<img>` — is absent rather than
 * reported beside it.
 */
export interface LinkExtractionResult {
  links: ExtractedLink[]
}

/* -------------------------------------------------------------------------- */
/*  URL analysis                                                               */
/* -------------------------------------------------------------------------- */

/** Route prefixes that identify an internal content link. */
const TYPE_BY_PREFIX: Record<string, ContentType> = {
  posts: 'post',
  notes: 'note',
  projects: 'project',
}

export interface InternalTarget {
  type: ContentType
  slug: string
  /** Trailing `#heading`, if any. */
  hash: string | null
}

/**
 * Recognise a site-relative URL that points at a document.
 * Absolute URLs on the configured site origin are handled by the caller, which
 * passes only the path component here.
 */
export function parseInternalTarget(href: string): InternalTarget | null {
  const [beforeHash = '', hashPart] = splitHash(href)
  // The query is dropped before the path is split. `/posts/foo?utm_source=x`
  // is a link to `foo`, and leaving the query attached produces the slug
  // `foo?utm_source=x`, which matches no document and reads in the broken-link
  // report as though the author had mistyped the slug.
  const pathPart = beforeHash.split('?')[0] ?? ''
  const segments = pathPart
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)

  if (segments.length === 0) return null

  const [prefix, slug] = segments
  if (!prefix || !slug) return null

  const type = TYPE_BY_PREFIX[prefix]
  if (!type) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(slug)
  } catch {
    // Malformed percent-encoding: fall back to the raw text.
    decoded = slug
  }

  return { type, slug: decoded, hash: hashPart ?? null }
}

function splitHash(href: string): [string, string | undefined] {
  const index = href.indexOf('#')
  if (index === -1) return [href, undefined]
  return [href.slice(0, index), href.slice(index + 1)]
}

/**
 * Normalise an uploaded image or media reference to a storage key.
 * Returns null for external URLs, which nothing here can resolve.
 */
export function normalizeImageKey(href: string, urlPrefix: string): string | null {
  const [pathPart] = splitHash(href)
  if (!pathPart) return null

  // Strip the query string; it does not change which file this is.
  const withoutQuery = pathPart.split('?')[0] ?? ''
  if ((!withoutQuery.startsWith('/') && !withoutQuery.startsWith('uploads/')) || withoutQuery.startsWith('//')) return null
  try {
    // Browsers resolve dot segments before requesting a URL; the catch-all
    // asset route then decodes path segments once. Both aliases must identify
    // the same storage key, including `/uploads/a%2Esvg`.
    const pathname = decodeURIComponent(new URL(withoutQuery, 'https://asset.invalid/').pathname)
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return null
    if (pathname.startsWith(`${urlPrefix}/`)) return pathname.slice(urlPrefix.length + 1)
    // The conventional alias is always served, even after the configured URL
    // prefix changes. Existing Markdown can keep its older upload URLs.
    if (pathname.startsWith('/uploads/')) return pathname.slice('/uploads/'.length)
    if (pathname.startsWith('/api/assets/')) return pathname.slice('/api/assets/'.length)
  } catch {
    // An invalid URL or invalid encoding cannot name a served local asset.
    return null
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*  Scanner                                                                    */
/* -------------------------------------------------------------------------- */

interface FenceState {
  marker: string
  length: number
}

/**
 * Collect Markdown links, wiki-links, and uploaded media from a document.
 *
 * Which lines are prose at all is `proseLines`' question, and it answers it for
 * the renderer too — see the wiki-link section below for why that matters.
 */
export function extractLinks(
  markdown: string,
  options: { uploadUrlPrefix?: string; siteUrl?: string } = {},
): LinkExtractionResult {
  const uploadPrefix = options.uploadUrlPrefix ?? '/uploads'
  const siteHost = options.siteUrl ? safeHost(options.siteUrl) : null

  const links: ExtractedLink[] = []

  // Reference destinations can be defined later, on another line. Parse these
  // with the same CommonMark grammar the renderer uses rather than guessing
  // whether a bracket pair is a link or an example inside code.
  const tree = unified().use(remarkParse).use(remarkDirective).parse(markdown)
  const definitions = new Map<string, Definition>()
  const referenceKey = (identifier: string) => identifier.toUpperCase()
  visit(tree, 'definition', (node) => {
    const key = referenceKey(node.identifier)
    if (!definitions.has(key)) definitions.set(key, node)
  })
  visit(tree, (node) => {
    if (node.type === 'html' || node.type === 'text') {
      // Keep the accepted unquoted-attribute form, which CommonMark can leave
      // as text. Code and HTML comments have distinct nodes and stay excluded.
      // A text value has already decoded Markdown escapes and HTML entities:
      // `\<img>` and `&lt;img&gt;` must remain examples, not asset references.
      const source = node.type === 'html' ? node.value : markdown.slice(
        node.position?.start.offset, node.position?.end.offset,
      ).replace(/(\\+)</g, (match: string, escapes: string) =>
        escapes.length % 2 === 1 ? `${escapes}&lt;` : match,
      )
      for (const ref of scanHtmlAssets(source)) {
        const classified = classifyRef(ref.src, ref.alt, uploadPrefix, siteHost)
        if (classified?.kind === 'image') {
          links.push({ ...classified, line: (node.position?.start.line ?? 1) + ref.lineOffset })
        }
      }
      return
    }
    if (node.type === 'leafDirective') {
      const name = node.name.toLowerCase()
      if (!['video', 'audio', 'embed', 'iframe'].includes(name) || !node.attributes?.src) return
      const sources = [node.attributes.src, ...(name === 'video' && node.attributes.poster ? [node.attributes.poster] : [])]
      for (const source of sources) {
        const classified = classifyRef(source, node.attributes.title ?? '', uploadPrefix, siteHost)
        if (classified?.kind === 'image') links.push({ ...classified, line: node.position?.start.line ?? 1 })
      }
      return
    }
    if (node.type !== 'linkReference' && node.type !== 'imageReference') return
    const reference = node as LinkReference | ImageReference
    const definition = definitions.get(referenceKey(reference.identifier))
    if (!definition) return
    const label = reference.type === 'imageReference' ? (reference.alt ?? '') : phrasingText(reference.children)
    const classified = classifyRef(definition.url, label, uploadPrefix, siteHost)
    if (classified) links.push({ ...classified, line: reference.position?.start.line ?? 1 })
  })

  for (const { text, line } of proseLines(markdown)) {
    for (const ref of scanMarkdownLinks(text)) {
      const classified = classifyRef(ref.href, ref.label, uploadPrefix, siteHost)
      if (classified) links.push({ ...classified, line })
    }

    for (const ref of matchWikiLinks(text)) {
      const classified = classifyWikiRef(ref.target, ref.label)
      if (classified) links.push({ ...classified, line })
    }

  }

  links.sort((a, b) => a.line - b.line)
  return { links }
}

function phrasingText(nodes: PhrasingContent[]): string {
  return nodes.map((node) => {
    if ('value' in node) return node.value
    if ('alt' in node) return node.alt
    if ('children' in node) return phrasingText(node.children)
    return ''
  }).join('')
}

interface ProseLine {
  /** The line with inline code blanked out, ready to scan. */
  text: string
  /** 1-based line number. */
  line: number
  /** Offset of the line's first character in the document. */
  start: number
}

/**
 * Yield the lines of a document that are prose, with inline code blanked out.
 *
 * The one place that decides what a scanner is allowed to see: a fenced block,
 * and the interior of a `` `…` `` run, are not prose and nothing inside them is
 * a link. Two callers share it — `extractLinks` for the index, `scanWikiLinks`
 * for the page — and they have to agree, because a `[[…]]` that one calls a link
 * and the other calls an example is a backlink to nothing or a link the database
 * has never heard of.
 *
 * `start` is an offset into the string as it was handed in, which is what lets
 * `rewriteWikiLinks` splice a link back into the document it came from.
 * Splitting on `\n` and dropping a trailing `\r` — rather than normalising
 * `\r\n` first — is what keeps those offsets honest.
 */
function* proseLines(markdown: string): Generator<ProseLine> {
  let fence: FenceState | null = null
  let start = 0
  let line = 0

  for (const raw of markdown.split('\n')) {
    const lineStart = start
    start += raw.length + 1
    line += 1

    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(text)
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '`'
      const length = fenceMatch[1]?.length ?? 3
      if (!fence) fence = { marker, length }
      else if (marker === fence.marker && length >= fence.length) fence = null
      continue
    }
    if (fence) continue

    // Blank out inline code so `[x](/y)` inside backticks is ignored.
    yield { text: stripInlineCode(text), line, start: lineStart }
  }
}

/**
 * Overwrite the interior of matched `` `…` `` runs with spaces, preserving
 * offsets so every reported line number still points at the source.
 *
 * Only runs that actually *close* are blanked. CommonMark treats an unpaired
 * backtick as ordinary punctuation, so in ``a ` b [x](/y)`` the link is real;
 * blanking from the backtick to the end of the line would silently drop it and
 * it would be missing from the backlink index with nothing to show why.
 */
function stripInlineCode(line: string): string {
  const masked = new Array<boolean>(line.length).fill(false)
  let openAt = -1
  let openTicks = 0

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char !== '`') continue

    let run = 0
    while (line[i + run] === '`') run += 1

    if (openAt === -1) {
      openAt = i
      openTicks = run
    } else if (run === openTicks) {
      for (let j = openAt; j < i + run; j += 1) masked[j] = true
      openAt = -1
      openTicks = 0
    }
    i += run - 1
  }

  if (!masked.some(Boolean)) return line

  let out = ''
  for (let i = 0; i < line.length; i += 1) {
    out += masked[i] ? ' ' : (line[i] ?? '')
  }
  return out
}

/**
 * Find `[label](href)` and `![alt](href)`, handling one level of nested
 * brackets in the label and an optional `"title"` after the href.
 */
function scanMarkdownLinks(line: string): { href: string; label: string; isImage: boolean }[] {
  const results: { href: string; label: string; isImage: boolean }[] = []
  let i = 0

  while (i < line.length) {
    const char = line[i]
    if (char === '\\') {
      // A backslash escapes the next character, so `\[x](y)` is literal text —
      // the renderer agrees, and a phantom backlink here would be invisible on
      // the page but recorded in the database.
      i += 2
      continue
    }
    if (char !== '[' && !(char === '!' && line[i + 1] === '[')) {
      i += 1
      continue
    }

    const isImage = char === '!'
    const labelStart = isImage ? i + 2 : i + 1
    const labelEnd = findClosingBracket(line, labelStart)
    if (labelEnd === -1) {
      i += 1
      continue
    }
    if (line[labelEnd + 1] !== '(') {
      i = labelEnd + 1
      continue
    }

    // One past the `(`: like `findClosingBracket`, the helper expects the index
    // *after* the opening delimiter, or the open paren itself reads as depth 1.
    const hrefEnd = findClosingParen(line, labelEnd + 2)
    if (hrefEnd === -1) {
      i = labelEnd + 1
      continue
    }

    const rawHref = line.slice(labelEnd + 2, hrefEnd).trim()
    // Drop an optional title: `(href "Title")`.
    const href = rawHref.split(/\s+(?=["'(])/)[0] ?? rawHref

    results.push({
      href: href.replace(/^<|>$/g, ''),
      label: line.slice(labelStart, labelEnd),
      isImage,
    })

    i = hrefEnd + 1
  }

  return results
}

function findClosingBracket(line: string, start: number): number {
  let depth = 0
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1
      continue
    }
    if (line[i] === '[') depth += 1
    else if (line[i] === ']') {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return -1
}

function findClosingParen(line: string, start: number): number {
  let depth = 0
  for (let i = start; i < line.length; i += 1) {
    const char = line[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return -1
}

interface LineWikiLink {
  /** Offsets of the whole `[[…]]` within the line. */
  start: number
  end: number
  target: string
  /** The `|label`, or an empty string when the target is its own label. */
  label: string
}

/** Obsidian-style `[[slug]]` and `[[slug|label]]`, within one line. */
function matchWikiLinks(line: string): LineWikiLink[] {
  const results: LineWikiLink[] = []
  const pattern = /\[\[([^\]\n]+)\]\]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line)) !== null) {
    const inner = match[1] ?? ''
    const [target = '', label = ''] = inner.split('|')
    results.push({
      start: match.index,
      end: match.index + match[0].length,
      target: target.trim(),
      label: label.trim(),
    })
  }

  return results
}

const htmlParser = unified().use(rehypeRaw)

/** Parse media attributes with the same HTML grammar as the renderer. */
function scanHtmlAssets(html: string): { src: string; alt: string; lineOffset: number }[] {
  if (!/<(?:img|video|audio|source|iframe)\b/i.test(html)) return []
  const lines = html.split('\n')
  const tree: HtmlRoot = { type: 'root', children: [{
    type: 'raw', value: html,
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1, offset: html.length },
    },
  }] }
  const results: { src: string; alt: string; lineOffset: number }[] = []
  visit(htmlParser.runSync(tree), 'element', (node) => {
    if (!['img', 'video', 'audio', 'source', 'iframe'].includes(node.tagName)) return
    const properties = node.properties
    const sources = typeof properties.src === 'string' ? [properties.src] : []
    if (node.tagName === 'video' && typeof properties.poster === 'string') sources.push(properties.poster)
    if (node.tagName === 'img' || node.tagName === 'source') {
      const sourceSet = Array.isArray(properties.srcSet) ? properties.srcSet.join(',') : properties.srcSet
      if (typeof sourceSet === 'string') {
        for (const candidate of sourceSet.split(',')) {
          const url = candidate.trim().split(/\s+/)[0]
          if (url) sources.push(url)
        }
      }
    }
    for (const src of sources) results.push({
      src, alt: typeof properties.alt === 'string' ? properties.alt : '',
      lineOffset: (node.position?.start.line ?? 1) - 1,
    })
  })
  return results
}

/* -------------------------------------------------------------------------- */
/*  Wiki links                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `[[target]]`, `[[target|label]]` and `[[target#heading]]`.
 *
 * The scanner above decides *where* a wiki link is; this section decides what
 * one is, and — for the page — what it becomes. They are deliberately the same
 * scanner. The index records the wiki links `extractLinks` finds and the page
 * rewrites the wiki links `scanWikiLinks` finds, so the two cannot disagree
 * about whether a `[[…]]` inside a code fence is a link or an example of one.
 * `content/projects/wikilink-parser.md` is a document about exactly that
 * distinction, and it is in this repository's own corpus.
 */

export interface WikiTarget {
  /**
   * The part that names a document, as written.
   *
   * Not normalised: `wikiTargetCandidates` is where a bare slug becomes the
   * keys it could be, and it needs the caller's index to do it.
   */
  key: string
  /** The `#heading` on the end, if there was one. */
  hash: string | null
}

/**
 * Split a wiki target into the document it names and the place inside it.
 *
 * Returns null when there is no document part at all: `[[#heading]]` points
 * into the note it is written in, which is not a reference to anything the
 * content index could resolve.
 *
 * A query string is dropped for the same reason `parseInternalTarget` drops one:
 * `[[hello?utm_source=x]]` names `hello`, and keeping the query would produce a
 * target that matches no document and reads as a typo in the broken-link report.
 */
export function parseWikiTarget(target: string): WikiTarget | null {
  const [beforeHash = '', hashPart] = splitHash(target)
  const key = (beforeHash.split('?')[0] ?? '').trim()
  if (!key) return null
  return { key, hash: hashPart ?? null }
}

/**
 * A wiki link in a document, with the offsets needed to rewrite it.
 *
 * Document order, which is what `rewriteWikiLinks` relies on.
 */
export interface WikiLinkRef extends WikiTarget {
  /** Offsets of the whole `[[…]]` in the document, as written. */
  start: number
  end: number
  /** 1-based source line, for reporting. */
  line: number
  /** The target exactly as written, before any `|label`. */
  target: string
  /** What to display: the `|label` if there was one, else the target. */
  label: string
}

/**
 * The wiki links in a document, in the order they are written.
 *
 * The renderer's half of the scanner: it sees the same prose `extractLinks`
 * sees, so the wiki links it returns are the wiki links the index holds a row
 * for — nothing more and nothing less.
 */
export function scanWikiLinks(markdown: string): WikiLinkRef[] {
  const refs: WikiLinkRef[] = []

  for (const { text, line, start } of proseLines(markdown)) {
    for (const match of matchWikiLinks(text)) {
      const target = parseWikiTarget(match.target)
      // Nothing to resolve: `[[#heading]]`. Left as written on the page, which
      // is also what the index records it as — an anchor rather than a link.
      if (!target) continue
      refs.push({
        ...target,
        start: start + match.start,
        end: start + match.end,
        line,
        target: match.target,
        label: match.label || match.target,
      })
    }
  }

  return refs
}

/**
 * Replace the wiki links a resolver answered with ordinary Markdown links.
 *
 * A rewrite of the source, done before it is parsed: `[[why-not-catch]]`
 * becomes `[why-not-catch](/notes/…)` and the renderer downstream sees a link
 * like any other, carrying the author's own words — the target, or the `|label`
 * they wrote instead.
 *
 * A target the resolver declines is left exactly as written, and that is the
 * whole failure policy: an unresolved `[[…]]` reads as the literal text it looks
 * like, which is what the author typed and what the link checker reports. A
 * link to nothing would be a claim about the corpus that is not true.
 *
 * `refs` must be in document order, as `scanWikiLinks` returns them, because
 * each splice changes the length of the line it is on — so they are applied
 * from the end backwards, where no earlier edit can move a later offset.
 */
export function rewriteWikiLinks(
  markdown: string,
  refs: readonly WikiLinkRef[],
  urlFor: (ref: WikiLinkRef) => string | null,
): string {
  let out = markdown

  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index]
    if (!ref) continue
    const url = urlFor(ref)
    if (!url) continue

    const link = `[${escapeLabel(ref.label)}](${escapeDestination(url)})`
    out = `${out.slice(0, ref.start)}${link}${out.slice(ref.end)}`
  }

  return out
}

/**
 * Make a target safe to display inside `[…]`.
 *
 * A `[` in the label opens a second bracket and the link stops parsing, which
 * would leave the reader looking at `[a[b](…)` — worse than the literal text
 * this rewrite replaced. The scanner admits a `[` in a target, so this is
 * reachable; a backslash is escaped with it because it is what escapes a
 * bracket in the first place.
 */
function escapeLabel(label: string): string {
  return label.replace(/[[\\]/g, '\\$&')
}

/**
 * Make a URL safe inside `(…)`.
 *
 * Parentheses have to be balanced in a Markdown destination and a slug may
 * contain one — `encodeURIComponent` leaves `(` and `)` alone — so a target like
 * `a(b` would end the link early and swallow the rest of the line into it.
 */
function escapeDestination(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/* -------------------------------------------------------------------------- */
/*  Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A link the index can act on, or nothing at all.
 *
 * `null` is both "not a link" and "a link that leaves the site": this function
 * is only ever asked what to record, and the answer to each is nothing. See
 * `LinkExtractionResult`.
 */
type Classification = ExtractedLink | null

function classifyRef(
  href: string,
  label: string,
  uploadPrefix: string,
  siteHost: string | null,
): Classification {
  const trimmed = href.trim()
  if (!trimmed) return null

  // Anchors first: they never leave the page.
  if (trimmed.startsWith('#')) {
    const fragment = trimmed.slice(1)
    if (!fragment) return null
    return {
      kind: 'anchor',
      href: trimmed,
      targetKey: fragment,
      label: label || null,
      line: 0,
    }
  }

  if (/^(mailto|tel|sms|data|javascript|vbscript):/i.test(trimmed)) {
    // None of these names a document or an asset, so there is nothing to
    // resolve them to. `data:` and `javascript:` are additionally neutralised
    // by the renderer's sanitiser.
    return null
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // Same-origin absolute URLs are internal links in disguise.
    if (siteHost) {
      try {
        const url = new URL(trimmed)
        if (url.host === siteHost) {
          return classifyRef(
            `${url.pathname}${url.search}${url.hash}`,
            label,
            uploadPrefix,
            siteHost,
          )
        }
      } catch {
        // Unparseable, so it cannot be shown to be one of ours.
        return null
      }
    }
    return null
  }

  // Scheme-relative: the scheme is whoever is reading's choice, and the host is
  // not ours.
  if (trimmed.startsWith('//')) return null

  // Query-only references.
  if (trimmed.startsWith('?')) return null

  // Image by extension, even when written as a normal Markdown link.
  const imageKey = normalizeImageKey(trimmed, uploadPrefix)
  if (imageKey) {
    return {
      kind: 'image',
      href: trimmed,
      targetKey: imageKey,
      label: label || null,
      line: 0,
    }
  }

  const internal = parseInternalTarget(trimmed)
  if (internal) {
    return {
      kind: 'internal',
      href: trimmed,
      targetKey: `${internal.type}s/${internal.slug}`,
      label: label || null,
      line: 0,
    }
  }

  // Site-relative but not a document: `/tags/linux`, `/archive`, `/rss.xml`.
  if (trimmed.startsWith('/')) {
    return {
      kind: 'anchor',
      href: trimmed,
      targetKey: trimmed,
      label: label || null,
      line: 0,
    }
  }

  // A bare relative path with no scheme. Treat as internal-ish for reporting.
  return null
}

/**
 * Classify an Obsidian-style `[[target]]`.
 *
 * Wiki targets are *not* URLs and must not go through `classifyRef`: that
 * function decides what a string means from its shape, and `[[hello]]` has no
 * shape to read — no leading slash, no extension, no site. What it has is a
 * slug, which is a thing only the content index can resolve.
 */
function classifyWikiRef(target: string, label: string): ExtractedLink | null {
  const parsed = parseWikiTarget(target)
  if (!parsed) {
    // `[[#heading]]` is a link into the document it is written in. The fragment
    // is the whole of the target, so it is recorded as an anchor — the kind that
    // never resolves to anything and therefore cannot be broken.
    const hash = splitHash(target)[1]
    return hash
      ? { kind: 'anchor', href: target, targetKey: hash, label: label || null, line: 0 }
      : null
  }

  return {
    kind: 'wiki',
    href: target,
    targetKey: parsed.key,
    label: label || null,
    line: 0,
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
