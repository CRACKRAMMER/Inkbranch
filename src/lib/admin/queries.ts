import 'server-only'

import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  contentIndex,
  contentTags,
  tags,
  users,
  type ContentRow,
  type ContentStatus,
  type ContentType,
} from '@/lib/db/schema'

/**
 * The admin's read layer.
 *
 * It exists because `@/lib/content/queries` is the *public* read layer and
 * answers only for published documents — deliberately, so a draft cannot leak
 * into a tag count or a feed. An admin screen needs the opposite default:
 * everything, with status as a filter the operator chooses. Two audiences, two
 * definitions of "visible"; keeping them in separate modules is what stops one
 * from being relaxed to serve the other.
 *
 * Rows come from the index, never from disk. A content file with no index row
 * does not exist as far as these lists are concerned, which is exactly what the
 * drift warning on the dashboard is for.
 */

export const ADMIN_PAGE_SIZE = 25
export const MAX_ADMIN_PAGE_SIZE = 100

export const CONTENT_SORTS = ['updated', 'published', 'views', 'title'] as const
export type ContentSort = (typeof CONTENT_SORTS)[number]

export interface AdminContentQuery {
  type: ContentType
  /** Free text, matched against title and slug. */
  search?: string
  status?: ContentStatus | 'all'
  category?: string
  tag?: string
  sort?: ContentSort
  page?: number
  perPage?: number
}

export interface AdminContentListItem {
  id: string
  type: ContentType
  slug: string
  path: string
  title: string
  description: string | null
  status: ContentStatus
  category: string | null
  series: string | null
  publishedAt: Date | null
  scheduledAt: Date | null
  updatedAt: Date
  viewCount: number
  featured: boolean
  wordCount: number
  tags: { slug: string; name: string }[]
}

export interface AdminContentPage {
  items: AdminContentListItem[]
  total: number
  page: number
  perPage: number
  pageCount: number
}

function clampPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 1
  return Math.max(1, Math.trunc(value))
}

function clampPerPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return ADMIN_PAGE_SIZE
  return Math.min(MAX_ADMIN_PAGE_SIZE, Math.max(1, Math.trunc(value)))
}

/** Escape the LIKE wildcards so a search for `100%` means what it says. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

function orderFor(sort: ContentSort): SQL[] {
  switch (sort) {
    case 'published':
      return [desc(sql`coalesce(${contentIndex.publishedAt}, ${contentIndex.scheduledAt})`), desc(contentIndex.updatedAt)]
    case 'views':
      return [desc(contentIndex.viewCount), desc(contentIndex.updatedAt)]
    case 'title':
      return [asc(contentIndex.title)]
    case 'updated':
    default:
      return [desc(contentIndex.updatedAt)]
  }
}

/**
 * Tags for a page of rows, in one follow-up query.
 *
 * Fetching them per row would be a query per list item, on the one screen most
 * likely to be open on a slow connection.
 */
async function tagsFor(contentIds: string[]): Promise<Map<string, { slug: string; name: string }[]>> {
  const grouped = new Map<string, { slug: string; name: string }[]>()
  if (contentIds.length === 0) return grouped

  const rows = await db
    .select({ contentId: contentTags.contentId, slug: tags.slug, name: tags.name })
    .from(contentTags)
    .innerJoin(tags, eq(tags.id, contentTags.tagId))
    .where(inArray(contentTags.contentId, contentIds))
    .orderBy(asc(tags.name))

  for (const row of rows) {
    const list = grouped.get(row.contentId) ?? []
    list.push({ slug: row.slug, name: row.name })
    grouped.set(row.contentId, list)
  }
  return grouped
}

export async function listAdminContent(query: AdminContentQuery): Promise<AdminContentPage> {
  const page = clampPage(query.page)
  const perPage = clampPerPage(query.perPage)
  const filters: SQL[] = [eq(contentIndex.type, query.type)]

  if (query.status && query.status !== 'all') {
    filters.push(eq(contentIndex.status, query.status))
  }
  if (query.category) {
    filters.push(eq(contentIndex.category, query.category))
  }
  const search = query.search?.trim()
  if (search) {
    const pattern = likePattern(search)
    const clause = or(ilike(contentIndex.title, pattern), ilike(contentIndex.slug, pattern))
    if (clause) filters.push(clause)
  }
  if (query.tag) {
    // A subquery rather than a join so the row count stays a count of documents
    // rather than of documents-times-matching-tags.
    filters.push(
      sql`exists (
        select 1 from content_tags ct
        join tags t on t.id = ct.tag_id
        where ct.content_id = ${contentIndex.id} and t.slug = ${query.tag}
      )`,
    )
  }

  const where = and(...filters)

  const [totalRow] = await db
    .select({ value: count() })
    .from(contentIndex)
    .where(where)
  const total = Number(totalRow?.value ?? 0)

  const rows = await db
    .select()
    .from(contentIndex)
    .where(where)
    .orderBy(...orderFor(query.sort ?? 'updated'))
    .limit(perPage)
    .offset((page - 1) * perPage)

  const tagMap = await tagsFor(rows.map((row) => row.id))

  return {
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      slug: row.slug,
      path: row.path,
      title: row.title,
      description: row.description,
      status: row.status,
      category: row.category,
      series: row.series,
      publishedAt: row.publishedAt,
      scheduledAt: row.scheduledAt,
      updatedAt: row.updatedAt,
      viewCount: row.viewCount,
      featured: row.featured,
      wordCount: row.wordCount,
      tags: tagMap.get(row.id) ?? [],
    })),
    total,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  }
}

export interface TypeStatusCounts {
  byType: Record<ContentType, number>
  byStatus: Record<ContentStatus, { total: number; byType: Record<ContentType, number> }>
  total: number
}

export async function contentCounts(): Promise<TypeStatusCounts> {
  const rows = await db
    .select({ type: contentIndex.type, status: contentIndex.status, value: count() })
    .from(contentIndex)
    .groupBy(contentIndex.type, contentIndex.status)

  const emptyTypes = (): Record<ContentType, number> => ({ post: 0, note: 0, project: 0 })
  const byType = emptyTypes()
  const byStatus: TypeStatusCounts['byStatus'] = {
    draft: { total: 0, byType: emptyTypes() },
    scheduled: { total: 0, byType: emptyTypes() },
    published: { total: 0, byType: emptyTypes() },
    archived: { total: 0, byType: emptyTypes() },
  }

  let total = 0
  for (const row of rows) {
    const value = Number(row.value)
    total += value
    byType[row.type] += value
    const status = byStatus[row.status]
    if (status) {
      status.total += value
      status.byType[row.type] += value
    }
  }

  return { byType, byStatus, total }
}

export interface RecentContentItem {
  id: string
  type: ContentType
  slug: string
  title: string
  status: ContentStatus
  updatedAt: Date
  path: string
}

export async function recentlyUpdatedContent(limit = 8): Promise<RecentContentItem[]> {
  const rows = await db
    .select({
      id: contentIndex.id,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
      updatedAt: contentIndex.updatedAt,
      path: contentIndex.path,
    })
    .from(contentIndex)
    .orderBy(desc(contentIndex.updatedAt))
    .limit(limit)
  return rows
}

/** Documents whose schedule is due but which the worker has not published yet. */
export async function dueScheduledContent(limit = 5): Promise<RecentContentItem[]> {
  return db
    .select({
      id: contentIndex.id,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
      updatedAt: contentIndex.updatedAt,
      path: contentIndex.path,
    })
    .from(contentIndex)
    .where(and(eq(contentIndex.status, 'scheduled'), sql`${contentIndex.scheduledAt} <= now()`))
    .orderBy(asc(contentIndex.scheduledAt))
    .limit(limit)
}

export interface AdminTag {
  id: string
  slug: string
  name: string
  description: string | null
  color: string | null
  /** Documents carrying the tag, at any status. */
  contentCount: number
  publishedCount: number
}

/**
 * Tag counts across every status, which is the only version an editor can act
 * on: a tag used solely by a draft looks unused on the public site and is not.
 */
export async function listAdminTags(): Promise<AdminTag[]> {
  const rows = await db
    .select({
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      color: tags.color,
      contentCount: count(contentTags.contentId),
      publishedCount: sql<number>`count(*) filter (where ${contentIndex.status} = 'published')`,
    })
    .from(tags)
    .leftJoin(contentTags, eq(contentTags.tagId, tags.id))
    .leftJoin(contentIndex, eq(contentIndex.id, contentTags.contentId))
    .groupBy(tags.id)
    .orderBy(desc(count(contentTags.contentId)), asc(tags.name))

  return rows.map((row) => ({
    ...row,
    contentCount: Number(row.contentCount),
    publishedCount: Number(row.publishedCount),
  }))
}

export async function getAdminTag(slug: string): Promise<AdminTag | null> {
  const all = await listAdminTags()
  return all.find((tag) => tag.slug === slug) ?? null
}

export interface TagOption {
  slug: string
  name: string
  contentCount: number
}

/** The tag list a document editor offers, ordered by use. */
export async function listTagOptions(): Promise<TagOption[]> {
  const rows = await db
    .select({
      slug: tags.slug,
      name: tags.name,
      contentCount: count(contentTags.contentId),
    })
    .from(tags)
    .leftJoin(contentTags, eq(contentTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(desc(count(contentTags.contentId)), asc(tags.name))

  return rows.map((row) => ({ ...row, contentCount: Number(row.contentCount) }))
}

/**
 * Every distinct category in use, for the filter dropdown.
 *
 * Derived from the index rather than a table: a category is only ever a string
 * in frontmatter, and inventing a table for it would create a second source of
 * truth that could disagree with the files.
 */
export async function listCategories(type?: ContentType): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: contentIndex.category })
    .from(contentIndex)
    .where(
      type
        ? and(eq(contentIndex.type, type), sql`${contentIndex.category} is not null`)
        : sql`${contentIndex.category} is not null`,
    )
    .orderBy(asc(contentIndex.category))

  return rows.map((row) => row.category).filter((value): value is string => Boolean(value))
}

export async function contentRowFor(type: ContentType, slug: string): Promise<ContentRow | null> {
  const [row] = await db
    .select()
    .from(contentIndex)
    .where(and(eq(contentIndex.type, type), eq(contentIndex.slug, slug)))
    .limit(1)
  return row ?? null
}

/**
 * Whether the installation has been seeded.
 *
 * The login screen asks this so it can distinguish "your password is wrong"
 * from "there is no account yet" — two problems with entirely different fixes,
 * and the second one has no in-app remedy by design.
 */
export async function hasAnyUser(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  return Boolean(row)
}

/**
 * Every `type/slug` in the index, for the editor's link check.
 *
 * All statuses, not just published. The site flags a link to a draft as broken
 * because a reader cannot follow it; in the editor that would mean every
 * half-written article cries wolf about the note it links to. Under-reporting is
 * the safe direction for a check whose purpose is to catch typos.
 */
export async function indexSlugKeys(): Promise<string[]> {
  const rows = await db
    .select({ type: contentIndex.type, slug: contentIndex.slug })
    .from(contentIndex)
  return rows.map((row) => `${row.type}/${row.slug}`)
}
export async function contentRowByPath(path: string): Promise<ContentRow | null> {
  const [row] = await db.select().from(contentIndex).where(eq(contentIndex.path, path)).limit(1)
  return row ?? null
}

/**
 * Slugs already taken by a type.
 *
 * Used to refuse a slug change that would collide: the unique index would reject
 * the write anyway, but a database constraint violation is a poor error message
 * for a person who just mistyped a URL.
 */
export async function takenSlugs(type: ContentType, exceptPath?: string): Promise<string[]> {
  const rows = await db
    .select({ slug: contentIndex.slug, path: contentIndex.path })
    .from(contentIndex)
    .where(eq(contentIndex.type, type))
  return rows.filter((row) => row.path !== exceptPath).map((row) => row.slug)
}
