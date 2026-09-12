import 'server-only'

import { inArray } from 'drizzle-orm'

import { env } from '@/env'
import type { AssetVariant } from '@/lib/assets/storage'
import { db } from '@/lib/db'
import { assets } from '@/lib/db/schema'
import type { DocumentImage, ImageSource } from '@/lib/markdown/rehype-enhance'
import { renderMarkdown, type RenderOptions, type RenderResult } from '@/lib/markdown/renderer'

import { extractLinks } from './links'

/**
 * Rendering a document's body, with its images described.
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
 * ## What it costs
 *
 * One indexed query, by storage path, for a document that has images — and
 * nothing at all for one that does not, because the extractor runs first and a
 * body with no image references never reaches the database. That is the price
 * of the alternative being a full-size download.
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
  const images = await documentImages(body)

  return renderMarkdown(body, images.size > 0 ? { ...options, images } : options)
}

/**
 * The site's own images in a document, keyed by the `src` as written.
 *
 * Two steps, because the two halves know different things. `extractLinks` knows
 * which references are images and how each one was written — it is the same
 * scanner the sync engine uses, so the images found here are exactly the images
 * the "which articles use this image" screen knows about. The database knows
 * what each one *is*: its size, and the formats it was also stored in.
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
  if (spellings.size === 0) return new Map()

  const rows = await db
    .select({
      path: assets.path,
      width: assets.width,
      height: assets.height,
      variants: assets.variants,
    })
    .from(assets)
    .where(inArray(assets.path, [...spellings.keys()]))

  const images = new Map<string, DocumentImage>()
  for (const row of rows) {
    const described: DocumentImage = {
      width: row.width,
      height: row.height,
      sources: sourceList(row.variants),
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
