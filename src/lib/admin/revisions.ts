import 'server-only'

import { asc, count, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { contentIndex, contentRevisions, users, type ContentType } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import { AUTOSAVE_SUMMARY, captureRevision, type CaptureResult, type CaptureRevisionInput } from '@/lib/revision/store'

/**
 * Revision capture as the admin performs it: the store's function plus the two
 * settings that decide whether and how much to keep.
 *
 * The store deliberately knows nothing about settings — it is the mechanism, and
 * a mechanism that reads configuration is one you cannot test without it. The
 * policy lives here, at the call site that has an actor and a settings row.
 */

export interface CaptureWithPolicyResult extends CaptureResult {
  /** True when nothing was attempted because revisions are switched off. */
  disabled: boolean
  /** Rows dropped to respect `revisionsMaxPerContent`. */
  trimmed: number
}

export async function captureWithPolicy(
  input: CaptureRevisionInput,
): Promise<CaptureWithPolicyResult> {
  const settings = await getSettings()

  if (!settings.revisionsEnabled) {
    return {
      captured: false,
      skipped: null,
      revisionId: null,
      revisionNo: null,
      pruned: 0,
      error: null,
      disabled: true,
      trimmed: 0,
    }
  }

  const result = await captureRevision(input)

  // The bound is applied after the write, never before: the alternative is a
  // save that fails because trimming failed, which trades a full disk for a
  // lost article.
  //
  // Autosaves are skipped: they cannot push a named revision past the bound, and
  // they arrive every couple of seconds while somebody types, which is the worst
  // possible moment to re-read every revision of the document.
  let trimmed = 0
  if (result.captured && input.reason !== 'autosave') {
    trimmed = await pruneRevisions(input.contentId, settings.revisionsMaxPerContent)
  }

  return { ...result, disabled: false, trimmed }
}

/**
 * Keep the newest `keep` revisions of a document, and its autosaves within their
 * own bound.
 *
 * Autosaves carry their own, much larger bound (`AUTOSAVE_REVISIONS_KEPT`) and
 * are trimmed by the store as it writes them, so they are excluded from the
 * count here — otherwise an afternoon of typing would evict every named save
 * that came before it, which is exactly the history worth keeping.
 */
export async function pruneRevisions(contentId: string, keep: number): Promise<number> {
  const bound = Math.max(1, Math.trunc(keep))

  const rows = await db
    .select({
      id: contentRevisions.id,
      summary: contentRevisions.summary,
    })
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.revisionNo))

  const named = rows.filter((row) => row.summary !== AUTOSAVE_SUMMARY)
  if (named.length <= bound) return 0

  const doomed = named.slice(bound).map((row) => row.id)
  const deleted = await db
    .delete(contentRevisions)
    .where(inArray(contentRevisions.id, doomed))
    .returning({ id: contentRevisions.id })

  return deleted.length
}

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
