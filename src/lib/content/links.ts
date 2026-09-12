import { CONTENT_TYPE_DIRS } from './paths'
import type { ContentType } from './schema'

/**
 * Link extraction.
 *
 * Pulls internal references and image references out of raw Markdown. Used for
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
   * - `image` — the path relative to the upload root.
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

export interface LinkExtractionResult {
  links: ExtractedLink[]
  /** Links whose target URL is external or otherwise not our business. */
  externalCount: number
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
 * Normalise an image reference to a key relative to the upload root.
 * Returns null for external images, which are tracked but not resolvable.
 */
export function normalizeImageKey(href: string, urlPrefix: string): string | null {
  const [pathPart] = splitHash(href)
  if (!pathPart) return null

  // Strip the query string; it does not change which file this is.
  const withoutQuery = pathPart.split('?')[0] ?? ''

  if (withoutQuery.startsWith(`${urlPrefix}/`)) {
    return withoutQuery.slice(urlPrefix.length + 1)
  }
  if (withoutQuery.startsWith('uploads/')) {
    return withoutQuery.slice('uploads/'.length)
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
 * Collect Markdown links, wiki-links, and raw `<img>` tags from a document.
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
  let externalCount = 0

  for (const { text, line } of proseLines(markdown)) {
    for (const ref of scanMarkdownLinks(text)) {
      const classified = classifyRef(ref.href, ref.label, uploadPrefix, siteHost)
      if (classified === 'external') {
        externalCount += 1
        continue
      }
      if (classified) links.push({ ...classified, line })
    }

    for (const ref of matchWikiLinks(text)) {
      const classified = classifyWikiRef(ref.target, ref.label)
      if (classified) links.push({ ...classified, line })
    }

    for (const ref of scanHtmlImages(text)) {
      const key = normalizeImageKey(ref.src, uploadPrefix)
      if (!key) {
        if (/^https?:\/\//i.test(ref.src)) externalCount += 1
        continue
      }
      links.push({
        kind: 'image',
        href: ref.src,
        targetKey: key,
        label: ref.alt || null,
        line,
      })
    }
  }

  return { links, externalCount }
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

/** Raw `<img src="…" alt="…">` markup, which Markdown permits pass-through. */
function scanHtmlImages(line: string): { src: string; alt: string }[] {
  const results: { src: string; alt: string }[] = []
  const pattern = /<img\b[^>]*>/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line)) !== null) {
    const tag = match[0]
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const srcValue = src?.[1] ?? src?.[2] ?? src?.[3]
    if (!srcValue) continue
    results.push({ src: srcValue, alt: alt?.[1] ?? alt?.[2] ?? '' })
  }

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

type Classification = ExtractedLink | 'external' | null

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
    // `data:` and `javascript:` are neutralised by the renderer's sanitiser;
    // they are not our links to track.
    return 'external'
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
        return 'external'
      }
    }
    return 'external'
  }

  if (trimmed.startsWith('//')) return 'external'

  // Protocol-relative or query-only references.
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

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/** Distinct image keys referenced by a document. */
export function referencedImageKeys(links: ExtractedLink[]): string[] {
  const keys = new Set<string>()
  for (const link of links) {
    if (link.kind === 'image') keys.add(link.targetKey)
  }
  return [...keys]
}

/**
 * Distinct internal targets referenced by a document, wiki links included.
 *
 * A wiki link is an internal reference that has not been narrowed to a type
 * yet, so leaving it out here would put the backlink index out of step with
 * what the reader sees on the page.
 */
export function referencedTargets(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Map<string, ExtractedLink>()
  for (const link of links) {
    if (link.kind !== 'internal' && link.kind !== 'wiki') continue
    // Keyed by kind as well as target: `[[hello]]` and `/posts/hello` may name
    // the same document, but they resolve differently and collapsing them would
    // keep whichever the scanner happened to reach first.
    const key = `${link.kind}:${link.targetKey}`
    if (!seen.has(key)) seen.set(key, link)
  }
  return [...seen.values()]
}

/**
 * Map a `type/slug` key back to a route. Used by the link checker to render
 * a clickable suggestion.
 */
export function targetKeyToUrl(targetKey: string): string | null {
  const [prefix, slug] = targetKey.split('/')
  if (!prefix || !slug) return null
  // Keys are built as `${type}s/${slug}` (see `classifyRef`), so the prefix is
  // the *directory* name — the values of CONTENT_TYPE_DIRS, not its keys.
  if (!Object.values(CONTENT_TYPE_DIRS).includes(prefix)) return null
  return `/${prefix}/${encodeURIComponent(slug)}`
}
