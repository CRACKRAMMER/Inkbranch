import type { Metadata } from 'next'
import { siteOrigin } from '@/env'
import { documentUrl } from '@/lib/content/paths'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import type { Settings } from '@/lib/settings'
import { charWidth, displayWidth, stripMarkdown, truncate } from '@/lib/utils/text'

/**
 * Page metadata.
 *
 * Every route's `generateMetadata` ends up here, so the rules a crawler sees —
 * one canonical form per URL, absolute URLs everywhere, one `noindex` flag that
 * also removes the document from the sitemap and the feeds — are decided once
 * rather than per route. The sitemap, feed and JSON-LD modules read the same
 * helpers (`absoluteUrl`, `isPublic`, `effectivePublishedAt`, `SeoDocument`) so
 * the three cannot drift apart: a flag honoured in four places by four
 * different pieces of code is a flag that will eventually be honoured in three.
 *
 * `isPublic` is the same rule `visibleFilter()` applies in
 * `src/lib/content/queries.ts`, so what a crawler is offered and what a reader
 * is shown are one decision with two readers rather than two decisions that
 * happen to agree today.
 */

/* -------------------------------------------------------------------------- */
/*  Site identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The site's own name and defaults.
 *
 * Supplied by the caller rather than read from a module, because the values
 * live in the `site_settings` row and reaching for them here would make every
 * metadata call asynchronous and every unit test need a database. `getSettings`
 * is called by the route that renders the page, and `siteIdentityFromSettings`
 * below is the one place the row's field names meet this interface — so a
 * renamed column is a compile error here rather than a title that quietly
 * falls back to the site name.
 */
export interface SiteIdentity {
  /** Site name. Title suffix, `og:site_name`, feed title. */
  name: string
  /** One-line site description, used when a page has none of its own. */
  description?: string | null
  /** Author name, for Open Graph article attribution and JSON-LD. */
  authorName?: string | null
  /** BCP-47 tag, e.g. `zh-CN`. */
  locale?: string | null
  /** Twitter/X handle, with or without the leading `@`. */
  twitterHandle?: string | null
  /**
   * Title template, `%s` standing in for the page title. Defaults to
   * `%s · {name}`. The settings row stores this, so a site that wants bare
   * titles sets it to `%s`.
   */
  titleTemplate?: string | null
}

/**
 * The `Settings` row as this directory reads it.
 *
 * A type-only import: the settings module is guarded with `server-only` and
 * opens a database connection, and this one is imported by code that must run
 * without either. Nothing here calls `getSettings`.
 */
export function siteIdentityFromSettings(settings: Settings): SiteIdentity {
  return {
    name: settings.siteName,
    // `seoDefaultDescription` exists for this fallback; the site description is
    // the copy on the page, which is what a snippet should say when the SEO one
    // is unset.
    description: settings.seoDefaultDescription || settings.siteDescription,
    authorName: settings.authorName,
    locale: settings.locale,
    twitterHandle: settings.twitterHandle,
    titleTemplate: settings.seoTitleTemplate,
  }
}

/* -------------------------------------------------------------------------- */
/*  Documents                                                                  */
/* -------------------------------------------------------------------------- */

/** The `seo` block as the frontmatter schema defines it. */
export interface SeoFields {
  title?: string | null
  description?: string | null
  canonical?: string | null
  ogImage?: string | null
  noindex?: boolean
}

/**
 * A tag, in either of the two shapes the codebase carries.
 *
 * The content layer hands out `TagRef` — `{ name, slug, color }` — because a
 * page needs the slug to link and the colour to draw. Everything here needs
 * only the *name*: `keywords`, `article:tag`, and the label on a generated
 * card. Rather than make every caller map before calling, the two shapes are
 * accepted and flattened by `tagNames` below.
 *
 * A string stays the common case, which is what a `content_index` row and a
 * `ContentDocument` both have.
 */
export type TagInput = string | { name: string }

/** Tag names from either shape, in order, with empties dropped. */
export function tagNames(tags: readonly TagInput[] | null | undefined): string[] {
  if (!tags || tags.length === 0) return []
  return tags
    .map((tag) => (typeof tag === 'string' ? tag : tag.name))
    .filter((name) => name.length > 0)
}

/**
 * The subset of a document that every SEO surface reads.
 *
 * Structural rather than nominal, so a `ContentDocument` read from a file, a
 * `content_index` row, a `ContentDetail` from the query layer, and a literal
 * written in a test all satisfy it without adaptation. A database row is
 * flatter — the `content_index` columns are `seo_title`, `canonical_url` and
 * friends — so those spellings are accepted too, and the nested block wins
 * when both are present.
 */
export interface SeoDocument {
  type: ContentType
  slug: string
  title: string
  /** Frontmatter description. Absent or empty means "derive one from `body`". */
  description?: string | null
  /** Markdown source or plain text; only read when a description is missing. */
  body?: string | null
  status?: ContentStatus
  publishedAt?: Date | null
  /** Frontmatter `publishAt`, the moment a `scheduled` document goes live. */
  scheduledAt?: Date | null
  updatedAt?: Date | null
  tags?: readonly TagInput[]
  category?: string | null
  series?: string | null
  /** Frontmatter cover, used as the feed enclosure. */
  cover?: string | null
  seo?: SeoFields | null

  /** `content_index` column spellings, for callers reading rows. */
  seoTitle?: string | null
  seoDescription?: string | null
  canonicalUrl?: string | null
  ogImage?: string | null
  noindex?: boolean

  /** Project-only, used by JSON-LD. */
  repoUrl?: string | null
  websiteUrl?: string | null
}

/** The frontmatter `seo` block, falling back to the flat column spelling. */
export function resolveSeoFields(doc: SeoDocument): SeoFields {
  return {
    title: doc.seo?.title ?? doc.seoTitle ?? null,
    description: doc.seo?.description ?? doc.seoDescription ?? null,
    canonical: doc.seo?.canonical ?? doc.canonicalUrl ?? null,
    ogImage: doc.seo?.ogImage ?? doc.ogImage ?? null,
    noindex: doc.seo?.noindex ?? doc.noindex ?? false,
  }
}

/**
 * The moment a document became public, or the moment it will.
 *
 * A published document carries its date; a scheduled one carries the schedule
 * (`publishAt` in frontmatter, `scheduled_at` in the index), which is also the
 * date a reader will see on it once it is live. They are two columns, and a
 * scheduled document usually has no `publishedAt` at all.
 */
export function effectivePublishedAt(doc: SeoDocument): Date | undefined {
  const status = doc.status ?? (doc.publishedAt ? 'published' : 'draft')
  const live =
    status === 'scheduled' ? (doc.scheduledAt ?? doc.publishedAt) : doc.publishedAt
  return live instanceof Date ? live : undefined
}

/**
 * True when a document may be listed publicly: live now, and not opted out.
 *
 * This is the site's definition of public, and it is deliberately the same
 * predicate `visibleFilter()` applies to every list in `src/lib/content/queries.ts`
 * — published, or scheduled with the moment already passed. A page that is
 * listed on the site but missing from its sitemap is an indexing incident, and
 * so is the reverse. `draft` and `archived` are not public; a scheduled
 * document goes live on its schedule even if the worker that flips the row has
 * not run, because "publish at 09:00" is a promise about the site rather than
 * about a background process. Any status added later fails closed.
 *
 * `status` is optional on the structural type, so an absent one resolves the way
 * the frontmatter schema resolves it: a dated file is published, an undated one
 * is a draft. The date test is what keeps a document dated in the future out.
 */
export function isPublic(doc: SeoDocument, now: Date = new Date()): boolean {
  if (resolveSeoFields(doc).noindex) return false

  const status: ContentStatus =
    doc.status ?? (doc.publishedAt ? 'published' : 'draft')
  if (status !== 'published' && status !== 'scheduled') return false

  const liveAt = effectivePublishedAt(doc)
  return liveAt !== undefined && liveAt.getTime() <= now.getTime()
}

/* -------------------------------------------------------------------------- */
/*  URLs                                                                       */
/* -------------------------------------------------------------------------- */

const ABSOLUTE_URL = /^https?:\/\//i

/**
 * Absolute form of a site-relative path.
 *
 * Every URL that leaves this directory is absolute, because a relative
 * `og:image` or feed link is dropped by crawlers and readers rather than
 * resolved — the failure is silent and only visible in someone else's logs.
 *
 * A leading `//` — which a browser would read as protocol-relative, i.e. a link
 * to another host — is treated as a site path instead. Nothing that reaches
 * this function is trusted to be a URL; some of it comes from frontmatter.
 */
export function absoluteUrl(input: string, origin: string = siteOrigin): string {
  const trimmed = input.trim()
  if (ABSOLUTE_URL.test(trimmed)) return trimmed

  const withoutLeadingSlashes = trimmed.replace(/^\/+/, '')
  if (!withoutLeadingSlashes) return `${origin}/`

  const hashAt = withoutLeadingSlashes.indexOf('#')
  const hash = hashAt === -1 ? '' : withoutLeadingSlashes.slice(hashAt)
  const beforeHash =
    hashAt === -1 ? withoutLeadingSlashes : withoutLeadingSlashes.slice(0, hashAt)

  const queryAt = beforeHash.indexOf('?')
  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt)
  const pathname = (queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt))
    // Collapse repeated separators. `/a//b` and `/a/b` are one resource; a
    // canonical that differs from the URL in the address bar is a canonical
    // that gets ignored.
    .replace(/\/{2,}/g, '/')

  return `${origin}/${pathname}${query}${hash}`
}

/** Canonical URL of a document, from its type and slug. */
export function documentCanonicalUrl(doc: SeoDocument): string {
  return absoluteUrl(documentUrl(doc.type, doc.slug))
}

/* -------------------------------------------------------------------------- */
/*  Titles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Roughly where a search result stops showing a title: about 600px, which is
 * about sixty Latin characters or thirty Chinese ones. Past that the engine
 * truncates, and it truncates from the right — which is where the site name
 * sits.
 *
 * Counted in half-width units for the same reason descriptions are: a title of
 * sixty Chinese characters is twice as wide as sixty Latin ones, and a budget
 * counted per character would let every Chinese title run to twice the length
 * the title tag has room for.
 */
const MAX_TITLE_WIDTH = 60

const TITLE_SEPARATOR = ' · '

/**
 * Page title plus site suffix.
 *
 * The suffix is dropped rather than allowed to push the title past
 * `MAX_TITLE_WIDTH`: truncating the combined string would cut the site name off
 * mid-word, and truncating the page title first would leave the reader with two
 * half-things. When something has to give, it is the suffix — the page title is
 * what someone scanning results is reading for.
 */
export function resolveTitle(
  pageTitle: string | null | undefined,
  site: SiteIdentity,
): string {
  const raw = (pageTitle ?? '').replace(/\s+/g, ' ').trim() || site.name
  if (raw.toLowerCase() === site.name.toLowerCase()) return raw

  const template =
    site.titleTemplate && site.titleTemplate.includes('%s')
      ? site.titleTemplate
      : `%s${TITLE_SEPARATOR}${site.name}`
  const templated = template.replaceAll('%s', raw)

  if (displayWidth(templated) <= MAX_TITLE_WIDTH) return templated
  return truncateDescription(raw, MAX_TITLE_WIDTH)
}

/* -------------------------------------------------------------------------- */
/*  Descriptions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Description budget in half-width units: about 160 Latin characters, or about
 * 80 Chinese ones, which is where Google stops rendering a snippet.
 */
export const MAX_DESCRIPTION_WIDTH = 320

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '…', '.', '!', '?'])

/** Index just past the last sentence ending in `points`, or 0 for none. */
function lastSentenceEnd(points: readonly string[], limit: number): number {
  for (let i = Math.min(limit, points.length) - 1; i > 0; i -= 1) {
    const char = points[i]
    if (char === undefined || !SENTENCE_ENDINGS.has(char)) continue

    // A Latin full stop only ends a sentence at the end of the cut or before a
    // space. `Node.js` and `v1.2` are not sentences, and cutting after them
    // produces a snippet that reads as a typo.
    const next = points[i + 1]
    const wide = charWidth(char) === 2 || char === '…'
    if (wide || next === undefined || next === ' ') return i + 1
  }
  return 0
}

/** Index just past the last space in `points`, or 0 for none. */
function lastSpace(points: readonly string[], limit: number): number {
  for (let i = Math.min(limit, points.length) - 1; i > 0; i -= 1) {
    if (points[i] === ' ') return i
  }
  return 0
}

/** How many code points fit in `maxWidth` half-width units. */
function fitWidth(points: readonly string[], maxWidth: number): number {
  let width = 0
  let count = 0
  for (const point of points) {
    const next = width + charWidth(point)
    if (next > maxWidth) break
    width = next
    count += 1
  }
  return count
}

/**
 * Cut a description to the budget, on a character boundary.
 *
 * Not a byte boundary: `Buffer`-based truncation is how a Chinese description
 * ends up with a broken character in the search result, because a Chinese
 * character is three bytes and half of one is not a character. Not a UTF-16
 * index either — that splits surrogate pairs, which arrive here as emoji in a
 * title and leave the re-encoded string with U+FFFD in it.
 *
 * Sentence boundary first, then a word boundary, then a plain cut: a snippet
 * beginning mid-sentence is what a description looks like when nobody chose
 * where it ends.
 */
export function truncateDescription(
  input: string,
  maxWidth: number = MAX_DESCRIPTION_WIDTH,
): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (displayWidth(text) <= maxWidth) return text

  const points = Array.from(text)
  // The ellipsis occupies room on the last line too, and in a Chinese font it
  // is a full square rather than a narrow one.
  let end = fitWidth(points, maxWidth - 2)

  const sentence = lastSentenceEnd(points, end)
  if (sentence > 0 && displayWidth(points.slice(0, sentence).join('')) >= maxWidth * 0.5) {
    end = sentence
  } else {
    const space = lastSpace(points, end)
    if (space > 0 && displayWidth(points.slice(0, space).join('')) >= maxWidth * 0.6) {
      end = space
    }
  }

  const kept = points.slice(0, end).join('').trimEnd()
  // A dangling separator before an ellipsis reads as a mistake.
  const trimmed = kept.replace(/[,;:，、；：]+$/, '')
  return `${trimmed || kept}…`
}

/** Frontmatter description, else one derived from the body, else the site's. */
export function resolveDescription(
  doc: SeoDocument,
  site: SiteIdentity,
  maxWidth: number = MAX_DESCRIPTION_WIDTH,
): string {
  const explicit = (doc.seo?.description ?? doc.seoDescription ?? doc.description)
  if (explicit && explicit.trim()) return truncateDescription(explicit, maxWidth)

  if (doc.body) {
    const derived = truncateDescription(stripMarkdown(doc.body), maxWidth)
    if (derived) return derived
  }

  return truncateDescription(site.description ?? '', maxWidth)
}

/* -------------------------------------------------------------------------- */
/*  Generated Open Graph cards                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Route that renders a generated card. The handler lives in the app directory;
 * this constant exists so metadata and the renderer name the same path.
 */
export const OG_IMAGE_ROUTE = '/api/og'

/** Card dimensions, fixed by every social platform's large-image format. */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const

/**
 * How much of the title travels in the card URL. The card itself lays out the
 * title it is given and clips what will not fit, but a query string is not a
 * payload: past this the URL stops being cache-friendly and starts being a
 * liability in someone's proxy log.
 */
const OG_URL_TITLE_LIMIT = 120

/**
 * URL of the generated card for a page.
 *
 * The title travels in the query so the card is a pure function of its URL.
 * Cards are the most expensive thing here — a font parse and a wasm render —
 * and a deterministic URL is what lets the CDN answer the second request
 * without touching the renderer.
 */
export function defaultOgImageUrl(input: {
  title: string
  type?: ContentType | 'page'
  publishedAt?: Date | null
  tags?: readonly TagInput[]
}): string {
  const params = new URLSearchParams()
  params.set('title', truncate(input.title, OG_URL_TITLE_LIMIT))
  if (input.type) params.set('type', input.type)
  if (input.publishedAt) params.set('date', input.publishedAt.toISOString().slice(0, 10))
  const keywords = tagNames(input.tags)
  if (keywords.length > 0) {
    params.set('tags', keywords.slice(0, 4).join(','))
  }
  return `${siteOrigin}${OG_IMAGE_ROUTE}?${params.toString()}`
}

/* -------------------------------------------------------------------------- */
/*  Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export interface PageMetadataInput {
  site: SiteIdentity
  /** Page title as written, before any site suffix. */
  title: string
  description?: string | null
  /** Site-relative path of the page, e.g. `/posts/hello`. */
  path: string
  /** Frontmatter override. Always wins over `path`. */
  canonical?: string | null
  /** Absolute or site-relative image. Defaults to the generated card. */
  ogImage?: string | null
  ogImageAlt?: string | null
  noindex?: boolean
  type?: 'website' | 'article'
  publishedTime?: Date | null
  modifiedTime?: Date | null
  tags?: readonly TagInput[]
  authors?: readonly string[]
}

export function buildPageMetadata(input: PageMetadataInput): Metadata {
  const { site } = input
  const isArticle = (input.type ?? 'website') === 'article'
  const title = resolveTitle(input.title, site)
  const description = truncateDescription(
    input.description?.trim() || site.description || '',
  )
  const canonical = input.canonical
    ? absoluteUrl(input.canonical)
    : absoluteUrl(input.path)
  const noindex = input.noindex ?? false
  // Flattened once. Callers pass whatever tag shape they hold — a bare string
  // from a database row, a `TagRef` from the content layer — and both
  // `article:tag` and `keywords` want the same list of plain names.
  const keywords = tagNames(input.tags)

  const image = input.ogImage ?? defaultOgImageUrl({ title: input.title })
  const imageUrl = absoluteUrl(image)
  // Only the generated card has known dimensions — it is the only image whose
  // size this site controls. A hand-supplied cover is whatever shape it is, and
  // a wrong `og:image:width` is worse than none.
  const alt = input.ogImageAlt ?? title
  const imageEntry = imageUrl.startsWith(`${siteOrigin}${OG_IMAGE_ROUTE}`)
    ? { ...OG_IMAGE_SIZE, url: imageUrl, alt }
    : { url: imageUrl, alt }

  const shared = {
    url: canonical,
    title,
    description,
    siteName: site.name,
    locale: site.locale ?? undefined,
    images: [imageEntry],
  }

  const openGraph: NonNullable<Metadata['openGraph']> = isArticle
    ? {
        ...shared,
        type: 'article',
        publishedTime: input.publishedTime?.toISOString(),
        modifiedTime: input.modifiedTime?.toISOString(),
        authors:
          input.authors && input.authors.length > 0 ? [...input.authors] : undefined,
        tags: keywords.length > 0 ? keywords : undefined,
      }
    : { ...shared, type: 'website' }

  const twitterHandle = site.twitterHandle
    ? `@${site.twitterHandle.replace(/^@/, '')}`
    : undefined

  const metadata: Metadata = {
    // `absolute` on purpose. The root layout carries a title template, and a
    // plain string here would be run through it — putting the site name on the
    // end of a title this function already suffixed.
    title: { absolute: title },
    description,
    alternates: { canonical },
    openGraph,
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [imageUrl],
      site: twitterHandle,
    },
    keywords: keywords.length > 0 ? keywords : undefined,
  }

  // Emitted only when it is false. A `robots: { index: true }` on every page
  // would override a site-wide policy set in the layout, for no gain.
  if (noindex) {
    metadata.robots = { index: false, follow: false }
  }

  return metadata
}

/** Metadata for a document, honouring the frontmatter `seo` overrides. */
export function buildContentMetadata(
  site: SiteIdentity,
  doc: SeoDocument,
): Metadata {
  const seo = resolveSeoFields(doc)
  const title = seo.title?.trim() || doc.title
  const authors = site.authorName ? [site.authorName] : undefined

  return buildPageMetadata({
    site,
    title,
    description: resolveDescription(doc, site),
    path: documentUrl(doc.type, doc.slug),
    canonical: seo.canonical,
    ogImage:
      seo.ogImage ??
      defaultOgImageUrl({
        title,
        type: doc.type,
        publishedAt: doc.publishedAt ?? null,
        tags: doc.tags,
      }),
    ogImageAlt: doc.title,
    noindex: seo.noindex ?? false,
    type: 'article',
    publishedTime: doc.publishedAt ?? null,
    modifiedTime: doc.updatedAt ?? null,
    tags: doc.tags,
    authors,
  })
}
