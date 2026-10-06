import 'server-only'
import { eq } from 'drizzle-orm'
import { documentUrl } from '@/lib/content/paths'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { db } from '@/lib/db'
import { contentIndex, contentLinks, type LinkKind } from '@/lib/db/schema'
import { compareStable, isVisible } from './model'

/**
 * Backlinks: which documents reference this one.
 *
 * The Obsidian idea, and the reason `content_links` exists. This runs on every
 * article page render, so it is one query against an index — `target_id` is
 * indexed for exactly this — followed by grouping in memory. Nothing here reads
 * a file.
 *
 * ## What the table can and cannot say
 *
 * A row is one *distinct reference form*: the sync engine writes one row per
 * (kind, target key) pair, so `/posts/hello` and `[[hello]]` in the same
 * document are two rows, while the same link written five times is one. That
 * matters for what a backlink can show. The rows give the label of each distinct
 * reference and nothing at all about how many times or where — there is no
 * `line` column in `content_links`. Times and lines would mean re-scanning the
 * source file, which is a read per backlink on a page render.
 *
 * ## Unresolved links are not backlinks
 *
 * `target_id` is the filter, not `resolved`. For the two kinds that have a
 * target to find, the two columns agree — a link is stored resolved exactly
 * when it found one — but `resolved` is `true` for the kinds that have none: an
 * image reference or an anchor is not resolved or unresolved, it is simply not
 * a link between documents. A row whose `target_id` equals this document is a
 * row that found it.
 */

/** A single distinct reference from one document to another. */
export interface BacklinkReference {
  /** `internal` for a Markdown link, `wiki` for `[[…]]`. */
  kind: LinkKind
  /** The href as the author wrote it. */
  href: string
  /** The link text, when there was any. */
  label: string | null
}

/** One source document, with every distinct way it references the target. */
export interface Backlink {
  /** The document that links here — `content_links.source_id`. */
  id: string
  type: ContentType
  slug: string
  title: string
  url: string
  publishedAt: Date | null
  updatedAt: Date
  references: BacklinkReference[]
}

export interface BacklinkOptions {
  /**
   * Statuses whose backlinks are shown. Defaults to published, because the
   * alternative is an unpublished draft revealing its title on a public page.
   */
  statuses?: readonly ContentStatus[]
}

/**
 * Rows pulled before grouping.
 *
 * A document referenced by five hundred distinct link rows is a hub — an index
 * page, or a note everything points at — and the page shows a bounded list
 * either way. Ordered by source below, so hitting the ceiling drops whole source
 * documents from the end of the list rather than scattering their references.
 */
const MAX_BACKLINK_ROWS = 500

const DEFAULT_STATUSES: readonly ContentStatus[] = ['published']

/** One joined row, as selected below. Grouped by `collectBacklinks`. */
export interface BacklinkRow {
  sourceId: string
  kind: LinkKind
  href: string
  label: string | null
  type: ContentType
  slug: string
  title: string
  status: ContentStatus
  scheduledAt: Date | null
  publishedAt: Date | null
  updatedAt: Date
}

/**
 * Documents that link to `contentId`, newest first.
 *
 * Grouped by source document: one document that references this one four ways
 * is one entry with four references, not four entries with the same title. The
 * order is fixed by `compareStable` rather than by the row order the database
 * happened to return, because a "Referenced by" list that reorders itself
 * between two loads of the same page is read as broken.
 */
export async function getBacklinks(
  contentId: string,
  options: BacklinkOptions = {},
): Promise<Backlink[]> {
  const rows = await db
    .select({
      sourceId: contentLinks.sourceId,
      kind: contentLinks.kind,
      href: contentLinks.href,
      label: contentLinks.label,
      type: contentIndex.type,
      slug: contentIndex.slug,
      title: contentIndex.title,
      status: contentIndex.status,
      scheduledAt: contentIndex.scheduledAt,
      publishedAt: contentIndex.publishedAt,
      updatedAt: contentIndex.updatedAt,
    })
    .from(contentLinks)
    .innerJoin(contentIndex, eq(contentIndex.id, contentLinks.sourceId))
    .where(eq(contentLinks.targetId, contentId))
    .orderBy(contentLinks.sourceId)
    .limit(MAX_BACKLINK_ROWS)

  return collectBacklinks(rows, new Set(options.statuses ?? DEFAULT_STATUSES))
}

/**
 * Group rows by source document.
 *
 * Pure, and separated from the query because the grouping is where the shape a
 * page renders is decided — one entry per source, references in a fixed order —
 * and that is worth testing without a database.
 */
export function collectBacklinks(
  rows: readonly BacklinkRow[],
  statuses: ReadonlySet<ContentStatus>,
): Backlink[] {
  const grouped = new Map<string, Backlink>()

  for (const row of rows) {
    // Filtered here rather than in SQL so the visibility rule stays in one
    // function, and so a scheduled post that has come due is included by the
    // same test the search provider applies.
    if (!isVisible(row, statuses)) continue

    let entry = grouped.get(row.sourceId)
    if (!entry) {
      entry = {
        id: row.sourceId,
        type: row.type,
        slug: row.slug,
        title: row.title,
        url: documentUrl(row.type, row.slug),
        publishedAt: row.publishedAt,
        updatedAt: row.updatedAt,
        references: [],
      }
      grouped.set(row.sourceId, entry)
    }

    entry.references.push({
      kind: row.kind,
      href: row.href,
      label: row.label,
    })
  }

  for (const entry of grouped.values()) {
    // Row order within a source is not part of the query's contract, so the
    // references are put in a stable order of their own: by kind, then by the
    // href as written.
    entry.references.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.href.localeCompare(b.href),
    )
  }

  return [...grouped.values()].sort(compareStable)
}
