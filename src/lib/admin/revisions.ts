import 'server-only'

import { asc, count, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { contentIndex, contentRevisions, users, type ContentType } from '@/lib/db/schema'
import { AUTOSAVE_SUMMARY } from '@/lib/revision/store'

/**
 * What the revision pages read.
 *
 * The writing half of this — `captureWithPolicy` and `pruneRevisions` — lives in
 * `@/lib/revision/policy`, because the editor, the scheduler and the importer
 * all record revisions and only one of them is the admin. Everything here exists
 * to render a page under `app/admin`, so everything here can stay here.
 */

/** How many revisions a document has, for the list's pagination. */
export async function countRevisions(contentId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
  return Number(row?.value ?? 0)
}

/**
 * Display names for the accounts that wrote a set of revisions.
 *
 * One query for the page rather than a join per row; a revision with no author
 * was written by the CLI, the importer or a job, which the caller renders as
 * such rather than as "unknown".
 */
export async function revisionAuthors(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const names = new Map<string, string>()
  if (unique.length === 0) return names

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, unique))

  for (const row of rows) names.set(row.id, row.name || row.email)
  return names
}

export interface DocumentRevisionStats {
  /** Total rows, autosaves included. */
  total: number
  autosaves: number
  /** Oldest and newest revision timestamps, for the "nothing to recover" line. */
  firstAt: Date | null
  lastAt: Date | null
}

export async function revisionStats(contentId: string): Promise<DocumentRevisionStats> {
  const rows = await db
    .select({
      summary: contentRevisions.summary,
      createdAt: contentRevisions.createdAt,
    })
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(asc(contentRevisions.createdAt))

  const autosaves = rows.filter((row) => row.summary === AUTOSAVE_SUMMARY).length
  return {
    total: rows.length,
    autosaves,
    firstAt: rows[0]?.createdAt ?? null,
    lastAt: rows[rows.length - 1]?.createdAt ?? null,
  }
}

export interface RevisionAuditTarget {
  type: ContentType
  slug: string
  title: string
}

/**
 * The index row a revision belongs to, for audit metadata and for the restore
 * path's revalidation.
 */
export async function revisionTarget(contentId: string): Promise<RevisionAuditTarget | null> {
  const [row] = await db
    .select({ type: contentIndex.type, slug: contentIndex.slug, title: contentIndex.title })
    .from(contentIndex)
    .where(eq(contentIndex.id, contentId))
    .limit(1)
  return row ?? null
}
