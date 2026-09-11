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
 * original behaviour and it is worse: the link renders fine in the reader's
 * browser, so the author never learns that it produced no backlink.
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
 * Walk the document line by line, tracking fenced-code and inline-code state,
 * and collect Markdown links, wiki-links, and raw `<img>` tags.
 */
export function extractLinks(
  markdown: string,
  options: { uploadUrlPrefix?: string; siteUrl?: string } = {},
): LinkExtractionResult {
  const uploadPrefix = options.uploadUrlPrefix ?? '/uploads'
  const siteHost = options.siteUrl ? safeHost(options.siteUrl) : null

  const links: ExtractedLink[] = []
  let externalCount = 0
  let fence: FenceState | null = null

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '`'
      const length = fenceMatch[1]?.length ?? 3
      if (!fence) fence = { marker, length }
      else if (marker === fence.marker && length >= fence.length) fence = null
      continue
    }
    if (fence) continue

    // Blank out inline code so `[x](/y)` inside backticks is ignored.
    const scanned = stripInlineCode(line)

    for (const ref of scanMarkdownLinks(scanned)) {
      const classified = classifyRef(ref.href, ref.label, uploadPrefix, siteHost)
      if (classified === 'external') {
        externalCount += 1
        continue
      }
      if (classified) links.push({ ...classified, line: lineNumber })
    }

    for (const ref of scanWikiLinks(scanned)) {
      const classified = classifyWikiRef(ref.href, ref.label)
      if (classified) links.push({ ...classified, line: lineNumber })
    }

    for (const ref of scanHtmlImages(scanned)) {
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
        line: lineNumber,
      })
    }
  }

  return { links, externalCount }
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

interface RawRef {
  href: string
  label: string
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

/** Obsidian-style `[[slug]]` and `[[slug|label]]`. */
function scanWikiLinks(line: string): RawRef[] {
  const results: RawRef[] = []
  const pattern = /\[\[([^\]\n]+)\]\]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line)) !== null) {
    const inner = match[1] ?? ''
    const [target = '', label = ''] = inner.split('|')
    results.push({ href: target.trim(), label: label.trim() })
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
function classifyWikiRef(href: string, label: string): ExtractedLink | null {
  const target = href.trim()
  if (!target) return null

  // `[[#heading]]` and `[[hello#heading]]` are links into a document, and the
  // fragment is part of the target rather than a separate concern.
  const [beforeHash = '', hashPart] = splitHash(target)
  const slugPart = (beforeHash.split('?')[0] ?? '').trim()
  if (!slugPart) {
    return hashPart
      ? { kind: 'anchor', href: target, targetKey: hashPart, label: label || null, line: 0 }
      : null
  }

  return {
    kind: 'wiki',
    href: target,
    targetKey: slugPart,
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
