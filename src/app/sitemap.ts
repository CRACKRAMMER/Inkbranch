import { asc, eq } from 'drizzle-orm'
import type { MetadataRoute } from 'next'

import { listTags } from '@/lib/content/queries'
import { db } from '@/lib/db'
import { contentIndex, contentTags, tags } from '@/lib/db/schema'
import type { SeoDocument } from '@/lib/seo/metadata'
import { buildSitemapEntries } from '@/lib/seo/sitemap'

/**
 * The sitemap, and the document list every SEO surface reads.
 *
 * ## Why the loader lives here
 *
 * The feeds import `loadSeoDocuments` from this module rather than querying the
 * index themselves. `buildSitemapEntries` and `buildRssFeed` both decide what is
 * public with the same predicate — `isPublic` — and that decision is only worth
 * anything if the two are handed the same candidates: a document that reaches
 * the feed but not the sitemap is an indexing incident, and the reverse is a
 * page nobody can find. One list, read once, is what makes the shared predicate
 * mean what it says.
 *
 * There is no `src/lib` module for this on purpose. `@/lib/seo` is a set of pure
 * functions over `SeoDocument` — no database, no filesystem — which is what lets
 * it be tested without either. A query belongs on the side of that line the
 * routes are on.
 *
 * ## Why the index and not the Markdown
 *
 * `content_index` carries everything the sitemap and the feeds need, including
 * the description `deriveContent` produced for documents whose frontmatter has
 * none, and the `noindex` flag. Reading it costs one query; walking the content
 * tree costs a stat per file on every crawl. Markdown stays the source of truth
 * — the sync engine is what keeps this table equal to it, and `checkContentDrift`
 * is what says when they have parted ways.
 */

/**
 * Every indexed document, in the shape the SEO modules read.
 *
 * Deliberately unfiltered: `isPublic` is applied by `buildSitemapEntries` and
 * `feedItems`, so drafts and future-dated documents are excluded by the one
 * predicate those modules share rather than by a `where` clause here that would
 * have to be kept in step with it.
 *
 * Column names are the flat spellings `SeoDocument` also accepts
 * (`seoTitle`, `canonicalUrl`, …) because these values come from the row.
 */
export async function loadSeoDocuments(): Promise<SeoDocument[]> {
  const [rows, tagPairs] = await Promise.all([
    db
      .select({
        id: contentIndex.id,
        type: contentIndex.type,
        slug: contentIndex.slug,
        title: contentIndex.title,
        description: contentIndex.description,
        status: contentIndex.status,
        publishedAt: contentIndex.publishedAt,
        scheduledAt: contentIndex.scheduledAt,
        updatedAt: contentIndex.updatedAt,
        cover: contentIndex.cover,
        category: contentIndex.category,
        series: contentIndex.series,
        seoTitle: contentIndex.seoTitle,
        seoDescription: contentIndex.seoDescription,
        canonicalUrl: contentIndex.canonicalUrl,
        ogImage: contentIndex.ogImage,
        noindex: contentIndex.noindex,
      })
      .from(contentIndex),
    db
      .select({ contentId: contentTags.contentId, name: tags.name })
      .from(contentTags)
      .innerJoin(tags, eq(tags.id, contentTags.tagId))
      // Stable order, so two runs produce byte-identical feeds. A feed whose
      // items reshuffle for no reason looks changed to every reader that
      // compares them.
      .orderBy(asc(tags.name)),
  ])

  const tagsByContent = new Map<string, string[]>()
  for (const pair of tagPairs) {
    const list = tagsByContent.get(pair.contentId)
    if (list) list.push(pair.name)
    else tagsByContent.set(pair.contentId, [pair.name])
  }

  return rows.map((row) => ({
    type: row.type,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    publishedAt: row.publishedAt,
    scheduledAt: row.scheduledAt,
    updatedAt: row.updatedAt,
    cover: row.cover,
    category: row.category,
    series: row.series,
    tags: tagsByContent.get(row.id) ?? [],
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    canonicalUrl: row.canonicalUrl,
    ogImage: row.ogImage,
    noindex: row.noindex,
  }))
}

/**
 * Rendered per request rather than prerendered at build.
 *
 * A build has no database — the Docker image is built before anything is
 * running — so a prerendered sitemap would either fail the build or freeze
 * whichever documents existed at the time into a file that outlives them. One
 * indexed query per crawl is cheaper than a sitemap that lists a deleted page.
 */
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The tag list is the one thing the index cannot supply: a document carries
  // tag names, and a tag page is addressed by a slug that only the `tags` table
  // knows. `listTags` already means "tags with published content behind them",
  // which is exactly the set whose pages exist.
  const [documents, tags] = await Promise.all([loadSeoDocuments(), listTags()])

  return buildSitemapEntries({
    documents,
    tagSlugs: new Map(tags.map((tag) => [tag.name, tag.slug])),
  })
}
