import 'server-only'

import { and, asc, count, desc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { cache } from 'react'

import { db } from '@/lib/db'
import {
  contentIndex,
  contentTags,
  tags,
  type ContentRow,
  type ContentStatus,
  type ContentType,
} from '@/lib/db/schema'
import { documentUrl } from './paths'

/**
 * The read layer the public site uses.
 *
 * Everything here answers a question a page asks, and none of it returns article
 * bodies — those are not in the database at all. A list item carries only what a
 * list renders; the article page reads its body off disk through the content
 * reader. Keeping those two paths separate is what makes "Markdown is the source
 * of truth" true rather than a slogan.
 *
 * Two rules apply to every query below:
 *
 *   1. **Public means published.** `visibleFilter()` is the single definition,
 *      and it is applied even where the caller "obviously" wants published
 *      content — a draft leaking into a tag count is just as wrong as one
 *      leaking into a list.
 *   2. **No N+1.** Tag lists are fetched in one follow-up query and grouped in
 *      memory, not queried per row.
 */

/* -------------------------------------------------------------------------- */
/*  Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The definition of "a reader may see this".
 *
 * `published` is the obvious case. The second clause covers a scheduled post
 * whose moment has passed: the worker normally flips the file and the row to
 * `published`, but the site should honour the schedule even when the worker is
 * not running, because "publish at 09:00" is a promise about the site, not
 * about a background process. A scheduled post with no date is never visible.
 *
 * Statuses are compared as a set rather than by excluding `draft`, so a status
 * added later is invisible until someone decides otherwise. Failing closed is
 * the only defensible default for a visibility check.
 */
function visibleFilter() {
  return or(
    eq(contentIndex.status, 'published'),
    and(eq(contentIndex.status, 'scheduled'), lte(contentIndex.scheduledAt, sql`now()`)),
  )
}

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** A publication date, already resolved to the one a reader should see. */
function effectiveDate(): typeof contentIndex.publishedAt {
  return contentIndex.publishedAt
}

/** What a list renders. Deliberately has no body and no frontmatter extras. */
export interface ContentSummary extends SummaryRow {
  /** Absolute site path, built from type and slug. */
  url: string
  tags: TagRef[]
}

/** The columns every summary query selects. Shared so the shape cannot drift. */
const summaryColumns = {
  id: contentIndex.id,
  type: contentIndex.type,
  slug: contentIndex.slug,
  title: contentIndex.title,
  description: contentIndex.description,
  publishedAt: contentIndex.publishedAt,
  updatedAt: contentIndex.updatedAt,
  readingTime: contentIndex.readingTime,
  wordCount: contentIndex.wordCount,
  featured: contentIndex.featured,
  cover: contentIndex.cover,
  category: contentIndex.category,
  series: contentIndex.series,
  projectStatus: contentIndex.projectStatus,
  techStack: contentIndex.techStack,
} as const

/**
 * What a summary query returns, derived from the table rather than from the
 * select object.
 *
 * A mapped type over `summaryColumns` reading each column's `_['data']` looks
 * tempting and is wrong: `_['data']` is the *writer* type, where a nullable
 * column is `string | null` on insert but `string` on read for columns with a
 * default. Deriving from `ContentRow` instead means a renamed or retyped column
 * fails to compile right here, which is the point of naming the shape at all.
 */
type SummaryRow = Pick<
  ContentRow,
  | 'id'
  | 'type'
  | 'slug'
  | 'title'
  | 'description'
  | 'publishedAt'
  | 'updatedAt'
  | 'readingTime'
  | 'wordCount'
  | 'featured'
  | 'cover'
  | 'category'
  | 'series'
  | 'projectStatus'
  | 'techStack'
>

/** A tag as it is attached to a summary. */
export interface TagRef {
  name: string
  slug: string
  color: string | null
}

/**
 * Attach tags to a page of rows with one extra query.
 *
 * The alternative — a `json_agg` subquery in the main select — reads better in
 * isolation but forces every caller to parse a JSON string that Drizzle types
 * as `unknown`, and it cannot use the `content_tags_tag_idx` index for the
 * "which posts have this tag" direction. Two round trips with a `Map` is
 * cheaper than one round trip and a cast.
 */
async function withTags(rows: SummaryRow[]): Promise<ContentSummary[]> {
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)

  const pairs = await db
    .select({
      contentId: contentTags.contentId,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
    })
    .from(contentTags)
    .innerJoin(tags, eq(tags.id, contentTags.tagId))
    .where(inArray(contentTags.contentId, ids))
    // Stable order so a post's tag list does not reshuffle between requests.
    .orderBy(asc(tags.name))

  const byContent = new Map<string, TagRef[]>()
  for (const pair of pairs) {
    const ref: TagRef = { name: pair.name, slug: pair.slug, color: pair.color }
    const list = byContent.get(pair.contentId)
    if (list) list.push(ref)
    else byContent.set(pair.contentId, [ref])
  }

  return rows.map((row) => ({
    ...row,
    tags: byContent.get(row.id) ?? [],
    url: documentUrl(row.type, row.slug),
  }))
}

/* -------------------------------------------------------------------------- */
/*  Lists                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How a list is ordered.
 *
 * `published` is the default and the right answer for anything a reader
 * browses chronologically. `updated` exists for the digital garden, where the
 * question is "what has been tended recently" and the planting date is the
 * wrong axis entirely.
 *
 * Two values rather than an open `orderBy` column name, because the ordering
 * has to agree with the index for the query to stay cheap, and because a
 * nullable `publishedAt` needs the `NULLS LAST` treatment that a caller passing
 * a bare column would not know to add.
 */
export type ListSort = 'published' | 'updated'

export interface ListOptions {
  type?: ContentType
  /** Tag slug or name; either identifies the tag. */
  tag?: string
  /**
   * Exact category, as written on the document.
   *
   * A category is a string rather than a row with a slug, so this is compared
   * as stored: `Linux` and `linux` would be two categories, which is what the
   * author sees in the admin's filter and in the feeds.
   */
  category?: string
  limit?: number
  offset?: number
  sort?: ListSort
}

/** Published content, newest first by publication date unless told otherwise. */
export async function listContent(options: ListOptions = {}): Promise<ContentSummary[]> {
  const { type, tag, category, limit = 20, offset = 0, sort = 'published' } = options

  const conditions = [visibleFilter()]
  if (type) conditions.push(eq(contentIndex.type, type))
  if (category) conditions.push(eq(contentIndex.category, category))

  if (tag) {
    // A correlated subquery rather than a join: a join against a many-to-many
    // table would return one row per matching tag, so a post carrying the tag
    // twice would appear twice and `limit` would count wrong.
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${contentTags}
        INNER JOIN ${tags} ON ${tags.id} = ${contentTags.tagId}
        WHERE ${contentTags.contentId} = ${contentIndex.id}
          AND (${tags.slug} = ${tag} OR ${tags.name} = ${tag})
      )`,
    )
  }

  const rows = await db
    .select(summaryColumns)
    .from(contentIndex)
    .where(and(...conditions))
    .orderBy(
      ...(sort === 'updated'
        ? // `updatedAt` is non-null on every row, so it needs no null handling.
          // Slug breaks ties, because two documents touched in the same
          // millisecond would otherwise come back in whatever order the planner
          // chose — and an unstable order across pages loses or repeats rows.
          [desc(contentIndex.updatedAt), asc(contentIndex.slug)]
        : // `publishedAt` is nullable, so rows are ordered by it descending with
          // nulls last — a published row with no date sorts after dated ones
          // rather than before them, which is where Postgres puts NULL by
          // default.
          [sql`${effectiveDate()} DESC NULLS LAST`, desc(contentIndex.updatedAt)]),
    )
    .limit(limit)
    .offset(offset)

  return withTags(rows)
}

/** How many published items match, for pagination. */
export async function countContent(
  options: Pick<ListOptions, 'type' | 'tag' | 'category'> = {},
): Promise<number> {
  const { type, tag, category } = options

  const conditions = [visibleFilter()]
  if (type) conditions.push(eq(contentIndex.type, type))
  if (category) conditions.push(eq(contentIndex.category, category))
  if (tag) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${contentTags}
        INNER JOIN ${tags} ON ${tags.id} = ${contentTags.tagId}
        WHERE ${contentTags.contentId} = ${contentIndex.id}
          AND (${tags.slug} = ${tag} OR ${tags.name} = ${tag})
      )`,
    )
  }

  const [row] = await db
    .select({ value: count() })
    .from(contentIndex)
    .where(and(...conditions))

  return row?.value ?? 0
}

/**
 * The home dashboard's featured slot.
 *
 * Newest first, and it falls back to nothing rather than to "recent" — a
 * featured slot filled with whatever was handy is a lie about what the author
 * chose to put there. The caller decides what to show instead.
 */
export async function listFeatured(limit = 3): Promise<ContentSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(contentIndex)
    .where(and(visibleFilter(), eq(contentIndex.featured, true)))
    .orderBy(sql`${effectiveDate()} DESC NULLS LAST`)
    .limit(limit)

  return withTags(rows)
}

/**
 * Recently updated, for the digital garden.
 *
 * Ordered by when the *file* last changed, not when it was published — a note
 * planted two years ago and tended last week belongs at the top of a garden,
 * and dating it by its planting would bury it.
 */
export async function listRecentlyUpdated(limit = 6): Promise<ContentSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(contentIndex)
    .where(visibleFilter())
    .orderBy(desc(contentIndex.updatedAt))
    .limit(limit)

  return withTags(rows)
}

/* -------------------------------------------------------------------------- */
/*  Single items                                                               */
/* -------------------------------------------------------------------------- */

export interface ContentDetail extends ContentSummary {
  path: string
  headings: { id: string; text: string; level: number }[]
  toc: boolean
  lang: string
  seoTitle: string | null
  seoDescription: string | null
  canonicalUrl: string | null
  ogImage: string | null
  noindex: boolean
  repoUrl: string | null
  websiteUrl: string | null
  startedAt: string | null
  checksum: string
}

/**
 * One published document by type and slug, or null.
 *
 * The caller passes the type rather than searching all three: slugs are only
 * unique within a type, so `/posts/hello` and `/notes/hello` are different
 * documents, and a lookup that ignored the type would return whichever the
 * planner happened to reach first.
 */
export const getContent = cache(
  async (type: ContentType, slug: string): Promise<ContentDetail | null> => {
    const [row] = await db
      .select({
        ...summaryColumns,
        path: contentIndex.path,
        headings: contentIndex.headings,
        toc: contentIndex.toc,
        lang: contentIndex.lang,
        seoTitle: contentIndex.seoTitle,
        seoDescription: contentIndex.seoDescription,
        canonicalUrl: contentIndex.canonicalUrl,
        ogImage: contentIndex.ogImage,
        noindex: contentIndex.noindex,
        repoUrl: contentIndex.repoUrl,
        websiteUrl: contentIndex.websiteUrl,
        startedAt: contentIndex.startedAt,
        checksum: contentIndex.checksum,
      })
      .from(contentIndex)
      .where(and(eq(contentIndex.type, type), eq(contentIndex.slug, slug), visibleFilter()))
      .limit(1)

    if (!row) return null
    const [summary] = await withTags([row])
    if (!summary) return null

    return {
      ...summary,
      path: row.path,
      headings: row.headings,
      toc: row.toc,
      lang: row.lang,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      canonicalUrl: row.canonicalUrl,
      ogImage: row.ogImage,
      noindex: row.noindex,
      repoUrl: row.repoUrl,
      websiteUrl: row.websiteUrl,
      startedAt: row.startedAt,
      checksum: row.checksum,
    }
  },
)

/**
 * The neighbours of a document in publication order.
 *
 * `older` is the next one published *before* this, `newer` the next one after.
 * Ties on `publishedAt` are broken by slug so a reader paging through two posts
 * published the same day does not see one of them twice and the other never.
 */
export async function getAdjacent(
  type: ContentType,
  publishedAt: Date | null,
  slug: string,
): Promise<{ newer: ContentSummary | null; older: ContentSummary | null }> {
  // An undated document has no position in a timeline, so it has no neighbours.
  if (!publishedAt) return { newer: null, older: null }

  const base = [visibleFilter(), eq(contentIndex.type, type), isNotNull(contentIndex.publishedAt)]

  const [newerRows, olderRows] = await Promise.all([
    db
      .select(summaryColumns)
      .from(contentIndex)
      .where(
        and(
          ...base,
          or(
            gt(contentIndex.publishedAt, publishedAt),
            and(eq(contentIndex.publishedAt, publishedAt), gt(contentIndex.slug, slug)),
          ),
        ),
      )
      .orderBy(asc(contentIndex.publishedAt), asc(contentIndex.slug))
      .limit(1),
    db
      .select(summaryColumns)
      .from(contentIndex)
      .where(
        and(
          ...base,
          or(
            sql`${contentIndex.publishedAt} < ${publishedAt}`,
            and(eq(contentIndex.publishedAt, publishedAt), sql`${contentIndex.slug} < ${slug}`),
          ),
        ),
      )
      .orderBy(desc(contentIndex.publishedAt), desc(contentIndex.slug))
      .limit(1),
  ])

  const [newer] = await withTags(newerRows)
  const [older] = await withTags(olderRows)

  return { newer: newer ?? null, older: older ?? null }
}

/** Every published document in a series, in reading order. */
export async function listSeries(series: string): Promise<ContentSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(contentIndex)
    .where(and(visibleFilter(), eq(contentIndex.series, series)))
    .orderBy(asc(contentIndex.publishedAt), asc(contentIndex.slug))

  return withTags(rows)
}

/* -------------------------------------------------------------------------- */
/*  Tags                                                                       */
/* -------------------------------------------------------------------------- */

export interface TagWithCount {
  slug: string
  name: string
  description: string | null
  color: string | null
  count: number
}

/**
 * Tags that actually have published content behind them.
 *
 * A tag whose only posts are drafts is not a topic a reader can browse, and
 * showing it produces an empty page that looks like a broken link. The inner
 * join against published rows is what enforces that, rather than a filter
 * afterwards — the count and the presence of the tag are then the same fact.
 */
export const listTags = cache(async (): Promise<TagWithCount[]> => {
  const rows = await db
    .select({
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      color: tags.color,
      count: count(contentIndex.id),
    })
    .from(tags)
    .innerJoin(contentTags, eq(contentTags.tagId, tags.id))
    .innerJoin(
      contentIndex,
      and(eq(contentIndex.id, contentTags.contentId), visibleFilter()),
    )
    .groupBy(tags.id, tags.slug, tags.name, tags.description, tags.color)
    // Most-used first: a tag cloud sorted alphabetically buries the topics the
    // author actually writes about. Name breaks ties so the order is stable.
    .orderBy(desc(count(contentIndex.id)), asc(tags.name))

  return rows
})

export const getTag = cache(async (slug: string): Promise<TagWithCount | null> => {
  const all = await listTags()
  return all.find((tag) => tag.slug === slug) ?? null
})

/* -------------------------------------------------------------------------- */
/*  Archive                                                                    */
/* -------------------------------------------------------------------------- */

export interface ArchiveGroup {
  /** Four-digit year, or the empty string for undated documents. */
  year: string
  items: ContentSummary[]
}

/**
 * Everything published, grouped by year, newest first.
 *
 * Undated documents are grouped under an empty year and placed last: they are a
 * real category (a note can legitimately have no date) and dropping them would
 * make the archive quietly incomplete.
 */
export async function listArchive(type?: ContentType): Promise<ArchiveGroup[]> {
  const conditions = [visibleFilter()]
  if (type) conditions.push(eq(contentIndex.type, type))

  const rows = await db
    .select(summaryColumns)
    .from(contentIndex)
    .where(and(...conditions))
    .orderBy(sql`${effectiveDate()} DESC NULLS LAST`, desc(contentIndex.updatedAt))

  const summaries = await withTags(rows)

  const groups = new Map<string, ContentSummary[]>()
  for (const item of summaries) {
    const year = item.publishedAt ? String(item.publishedAt.getUTCFullYear()) : ''
    const list = groups.get(year)
    if (list) list.push(item)
    else groups.set(year, [item])
  }

  return [...groups.entries()]
    .map(([year, items]) => ({ year, items }))
    .sort((a, b) => {
      if (a.year === '') return 1
      if (b.year === '') return -1
      return b.year.localeCompare(a.year)
    })
}

/* -------------------------------------------------------------------------- */
/*  Counts                                                                     */
/* -------------------------------------------------------------------------- */

/** Published counts per type, for the home dashboard and the navigation. */
export const countByType = cache(
  async (): Promise<Record<ContentType, number>> => {
    const rows = await db
      .select({ type: contentIndex.type, value: count() })
      .from(contentIndex)
      .where(visibleFilter())
      .groupBy(contentIndex.type)

    const result: Record<ContentType, number> = { post: 0, note: 0, project: 0 }
    for (const row of rows) result[row.type] = row.value
    return result
  },
)

/** Distinct statuses present, for the admin dashboard. Never used publicly. */
export async function countByStatus(): Promise<Record<ContentStatus, number>> {
  const rows = await db
    .select({ status: contentIndex.status, value: count() })
    .from(contentIndex)
    .groupBy(contentIndex.status)

  const result: Record<ContentStatus, number> = {
    draft: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  }
  for (const row of rows) result[row.status] = row.value
  return result
}
