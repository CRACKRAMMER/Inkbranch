import 'server-only'

import { desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { contentRevisions } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import { checksumOf } from '@/lib/content/reader'
import {
  AUTOSAVE_SUMMARY,
  captureRevision,
  type CaptureResult,
  type CaptureRevisionInput,
} from './store'

/**
 * Capture with the site's revision policy applied.
 *
 * `store.ts` deliberately knows nothing about settings — it is the mechanism,
 * and a mechanism that reads configuration is one you cannot test without it.
 * This module is the policy: the two settings that decide whether a revision is
 * kept and how many.
 *
 * ## Why this is not in `lib/admin`
 *
 * It was, until three callers outside the admin needed it. A save made by the
 * editor, a document published by the scheduler and a bundle written by the
 * importer are all writes that replace a previous state, and §19's rule — every
 * such write leaves a revision — has to hold for all three or it does not hold.
 * A policy function with one caller can live anywhere; a policy function with
 * four has to live where all four can reach it without reaching through the
 * admin, which is a feature folder rather than a layer.
 *
 * The read helpers the revision *pages* render (`revisionStats`,
 * `revisionAuthors` and the rest) stay in `lib/admin/revisions.ts`, because
 * their only caller is a page in `app/admin`.
 */

export interface CaptureWithPolicyResult extends CaptureResult {
  /** True when nothing was attempted because revisions are switched off. */
  disabled: boolean
  /** Rows dropped to respect `revisionsMaxPerContent`. */
  trimmed: number
}

export async function captureWithPolicy(
  input: CaptureRevisionInput & { writtenChecksum?: string },
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

  // A retry of a committed write can replace the same bytes again. Its earlier
  // recovery snapshot remains independent; this attempt has no new past state.
  if (input.previousContent !== null && input.writtenChecksum === checksumOf(input.previousContent)) {
    return { captured: false, skipped: 'unchanged', revisionId: null, revisionNo: null,
      pruned: 0, error: null, disabled: false, trimmed: 0 }
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
