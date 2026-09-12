import 'server-only'

import { inArray } from 'drizzle-orm'

import { env } from '@/env'
import type { AssetVariant } from '@/lib/assets/storage'
import { db } from '@/lib/db'
import { assets } from '@/lib/db/schema'
import type { DocumentImage, ImageSource } from '@/lib/markdown/rehype-enhance'
import { renderMarkdown, type RenderOptions, type RenderResult } from '@/lib/markdown/renderer'

import { extractLinks, normalizeImageKey, rewriteWikiLinks, scanWikiLinks } from './links'
import { resolveWikiTargets } from './resolve'

/**
 * Rendering a document's body: its images described, its wiki links resolved.
 *
 * ## Why this is a module and not one line in each page
 *
 * `renderMarkdown` is a pure function of the Markdown it is handed, and that is
 * worth keeping: the search index, the feeds, the OG images and a file of unit
 * tests all depend on rendering being predictable and callable without a
 * database. But an image rendered without its intrinsic size makes the page
 * jump as it loads, and one rendered without the formats it is also stored in
 * downloads a PNG where the browser would have taken an AVIF — so the *page*
 * needs the database, and the joining of the two has to live somewhere.
 *
 * Here, rather than in the three pages that need it. A rule written three times
 * is a rule that will differ in three places, and the one that differs will be
 * the one nobody looks at.
 *
 * The second reason is the same argument with a sharper edge. `[[why-not-catch]]`
 * is how an author names a document they have no URL for, and only the content
 * index knows what it names — so a wiki link that stays a wiki link on the page
 * is a link the backlink graph counts and the reader cannot click. Four calling
 * pages plus two previews is six chances to forget; there is one funnel instead.
 *
 * ## What it costs
 *
 * One indexed query per kind of thing a document actually uses — by storage path
 * for its images, by slug and path for its wiki links — and nothing at all for a
 * body that has neither, because the scanners run first and a document that
 * needs nothing from the database never reaches it. That is the price of the
 * alternative being a full-size download and a dead link.
 */

/**
 * Preference order for the `<source>` list: the better codec first.
 *
 * Not the order `DERIVATIVE_FORMATS` is written in, which is the order the
 * encoders are *tried* in. Here it is the order a browser should consider them,
 * and a browser takes the first `<source>` whose type it understands — so AVIF,
 * which is the smaller of the two at equal quality, has to come first.
 */
const SOURCE_ORDER = ['avif', 'webp']

/**
 * Render a document body, with whatever the database knows about its images.
 */
export async function renderDocument(
  body: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  // Independent of each other, so they are asked at the same time rather than
  // one after the other — a document with both images and wiki links used to be
  // two round trips of latency on every request that renders it.
  const [images, body2] = await Promise.all([documentImages(body), linkifyWikiLinks(body)])

  return renderMarkdown(body2, images.size > 0 ? { ...options, images } : options)
}

/**
 * Turn the document's wiki links into ordinary Markdown links.
 *
 * `[[why-not-catch]]` is how an author names a document they have no URL for,
 * and until this ran it reached the reader as those fifteen characters: the
 * index held an edge, the page held punctuation. Both halves now come from the
 * same scanner and the same resolver, so a wiki link the backlink graph counts
 * is a wiki link the reader can click.
 *
 * A target the index does not know is left exactly as written. There is nothing
 * to point at, so a link would be a claim about the corpus that is not true —
 * and the literal text is also what the author typed, which is the thing they
 * can act on. `pnpm content:links` lists those same targets.
 *
 * One query, and only for a body that contains a wiki link at all: the scanner
 * runs first, and a document with no `[[…]]` in it never reaches the database.
 */
async function linkifyWikiLinks(body: string): Promise<string> {
  const refs = scanWikiLinks(body)
  if (refs.length === 0) return body

  const resolved = await resolveWikiTargets(refs.map((ref) => ref.key))
  if (resolved.size === 0) return body

  return rewriteWikiLinks(body, refs, (ref) => {
    const target = resolved.get(ref.key)
    if (!target) return null
    // The fragment is kept and encoded the way `enhanceHeading` encodes the id
    // it points at, so `[[note#Some Heading]]` lands on the heading a reader
    // would have reached from the table of contents.
    return ref.hash ? `${target.url}#${encodeURIComponent(ref.hash)}` : target.url
  })
}

/**
 * The site's own images in a document, keyed by the `src` as written.
 *
 * Two steps, because the two halves know different things. `extractLinks` knows
 * which references are images and how each one was written — it is the same
 * scanner the sync engine uses, so the images found here are exactly the images
 * the "which articles use this image" screen knows about. The database knows
 * what each one *is*: its size, the formats it was also stored in, and the
 * placeholder the pipeline wrote for it at ingest.
 *
 * The key is the spelling from the document rather than the storage path,
 * because the spelling is what the renderer sees when it arrives at the image.
 * One asset can be written two ways in one document — the public URL and the
 * older `/uploads/…` prefix are both accepted on the way in — and both
 * spellings map to the same description.
 *
 * A reference the scanner could not turn into a storage path is simply absent
 * from the result: an external image, a data URI, or a file uploaded under a
 * different URL prefix than the one this deployment is configured with. Absent
 * means rendered as written, which is the correct outcome for all three.
 */
export async function documentImages(body: string): Promise<Map<string, DocumentImage>> {
  const { links } = extractLinks(body, {
    uploadUrlPrefix: env.UPLOAD_URL_PREFIX,
    siteUrl: env.SITE_URL,
  })

  /** Storage path → every spelling of it this document uses. */
  const spellings = new Map<string, string[]>()
  for (const link of links) {
    if (link.kind !== 'image') continue
    const written = spellings.get(link.targetKey)
    if (written) written.push(link.href)
    else spellings.set(link.targetKey, [link.href])
  }

  return describe(spellings)
}

/**
 * One image the site stores, described from the URL as it was written.
 *
 * A document's cover is an image reference that is not in its body, so
 * `documentImages` cannot find it — but it is the same kind of reference,
 * resolved by the same `normalizeImageKey` and answered by the same row. Left
 * to its own path it would be a bare `<img>`: no intrinsic size, so the page
 * shifts as it loads; no offer of the formats the asset is also stored in, so a
 * browser downloads a PNG where it could have had an AVIF; and no placeholder,
 * so the largest thing on the page arrives out of an empty box. Two behaviours
 * for one idea is how the two drift.
 *
 * Null for anything not stored here — an external URL, or a path that does not
 * resolve under the upload root. The caller renders those exactly as written,
 * which is the right outcome for both.
 */
export async function describeImage(
  href: string | null | undefined,
): Promise<DocumentImage | null> {
  if (!href) return null

  const key = normalizeImageKey(href, env.UPLOAD_URL_PREFIX)
  if (!key) return null

  const described = await describe(new Map([[key, [href]]]))
  return described.get(href) ?? null
}

/**
 * The database half: storage paths in, descriptions out, keyed by every
 * spelling the caller supplied.
 *
 * Split out because the two callers above disagree about where the references
 * come from — a scanned body, or one frontmatter field — and agree about
 * everything after that.
 */
async function describe(
  spellings: Map<string, string[]>,
): Promise<Map<string, DocumentImage>> {
  if (spellings.size === 0) return new Map()

  const rows = await db
    .select({
      path: assets.path,
      width: assets.width,
      height: assets.height,
      variants: assets.variants,
      blurDataUrl: assets.blurDataUrl,
    })
    .from(assets)
    .where(inArray(assets.path, [...spellings.keys()]))

  const images = new Map<string, DocumentImage>()
  for (const row of rows) {
    const described: DocumentImage = {
      width: row.width,
      height: row.height,
      sources: sourceList(row.variants),
      blurDataUrl: row.blurDataUrl,
    }
    for (const written of spellings.get(row.path) ?? []) {
      images.set(written, described)
    }
  }

  return images
}

/** The stored variants as a `<source>` list, best codec first. */
function sourceList(variants: readonly AssetVariant[]): ImageSource[] {
  return [...variants]
    .sort((a, b) => preference(a.format) - preference(b.format))
    .map((variant) => ({ type: `image/${variant.format}`, url: variant.url }))
}

/**
 * A format's place in the preference order.
 *
 * A format this build did not produce — one added later, or written by hand
 * into a row — sorts last rather than being dropped: it is still the same
 * picture at the same size, and the only thing lost by putting it last is that
 * a browser meets it after the formats known to be better.
 */
function preference(format: string): number {
  const index = SOURCE_ORDER.indexOf(format)
  return index === -1 ? SOURCE_ORDER.length : index
}
