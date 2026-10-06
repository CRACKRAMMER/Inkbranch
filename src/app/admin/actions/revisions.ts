'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { syncOneDocument } from '@/lib/content/sync'
import { getRevision, restoreRevision } from '@/lib/revision/store'
import { getSettings } from '@/lib/settings'
import { actionFailure, actionOk, type ActionResult, type CommittedContentChange } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'
import { commitContentChange, commitTitle } from '@/lib/admin/git'
import { revalidateContentChange } from '@/lib/admin/revalidate'
import { revisionTarget } from '@/lib/admin/revisions'
import { pruneRevisions } from '@/lib/revision/policy'
import type { GitCommitOutcome } from '@/lib/git'

/**
 * Restoring a revision.
 *
 * `restoreRevision` writes the snapshot through the writer — lock, temp file,
 * atomic rename — and records the state it replaced. What it cannot do is update
 * `content_index`: the revision module knows about revisions and the writer knows
 * about files, and the index is a third thing that only `@/lib/content/sync`
 * maintains. A restore that skipped the sync would leave the file correct and the
 * site showing the text it just replaced, which is the failure mode that looks
 * like the restore silently did nothing.
 */

const restoreSchema = z.object({
  revisionId: z.uuid(),
})

export type RestoreRevisionInput = z.output<typeof restoreSchema>

export interface RestoreRevisionResult {
  type: 'post' | 'note' | 'project'
  slug: string
  path: string
  checksum: string
  restoredRevisionId: string
  /** Revision number of the restored snapshot, for the confirmation line. */
  restoredRevisionNo: number
  /**
   * Whether the state the restore replaced was itself recorded, which is what
   * makes the restore undoable. When false the only way back is the file's
   * history in git or a backup, and the UI says so.
   */
  undoRecorded: boolean
  undoRevisionNo: number | null
  /** Revisions dropped to respect `revisionsMaxPerContent`. */
  trimmed: number
  /** What became of the commit, when the site asks for one. */
  git: GitCommitOutcome | null
}

export async function restoreRevisionAction(
  input: RestoreRevisionInput,
): Promise<ActionResult<RestoreRevisionResult>> {
  let committed: CommittedContentChange | undefined
  try {
    const context = await guardAction()
    const parsed = parseActionInput(restoreSchema, input)
    if (!parsed.ok) return parsed

    const revision = await getRevision(parsed.value.revisionId)
    const target = await revisionTarget(revision.contentId)
    if (!target) {
      return actionFailure('That revision belongs to a document that is no longer indexed.')
    }

    const result = await restoreRevision(parsed.value.revisionId, context.user.id)
    committed = { path: result.relativePath, slug: target.slug, operation: 'write', checksum: result.checksum,
      ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}) }

    // The sync is the difference between "the file is restored" and "the site
    // shows the restored text". Its failure is reported as its own state rather
    // than folded into the restore's: the file *was* written, and saying
    // otherwise would send someone to redo a write that already happened.
    try {
      await syncOneDocument(result.relativePath)
    } catch (error) {
      await recordAudit({
        action: 'revision.restore',
        actorId: context.user.id,
        targetType: 'content',
        targetId: result.relativePath,
        outcome: 'ok',
        metadata: {
          type: target.type,
          slug: target.slug,
          revisionNo: revision.revisionNo,
          indexSynced: false,
        },
        request: context.request,
      })
      revalidatePath(`/admin/${target.type}s/${target.slug}/revisions`)
      return actionFailure(
        'The revision was written back to the file, but the content index was not updated.',
        {
          code: 'content-committed',
          committed: [committed],
          detail:
            (error instanceof Error
              ? `${error.name}: run a content sync from System before trusting the site's pages.`
              : 'Run a content sync from System before trusting the site’s pages.') +
            (committed.recoveryPath ? ` Previous bytes are retained privately at ${committed.recoveryPath}.` : ''),
        },
      )
    }
    if (result.revision.error) throw result.revision.error

    // The restore path records its own undo row through the revision module, so
    // the bound is enforced here rather than inside it. Restores are not pruned
    // into oblivion by autosaves: `pruneRevisions` counts named rows only.
    const settings = await getSettings()
    const trimmed = settings.revisionsEnabled
      ? await pruneRevisions(revision.contentId, settings.revisionsMaxPerContent)
      : 0

    await recordAudit({
      action: 'revision.restore',
      actorId: context.user.id,
      targetType: 'content',
      targetId: result.relativePath,
      metadata: {
        type: target.type,
        slug: target.slug,
        revisionNo: revision.revisionNo,
        undoCaptured: result.revision.captured,
        indexSynced: true,
      },
      request: context.request,
    })

    revalidateContentChange(target.type, target.slug)
    revalidatePath(`/admin/${target.type}s/${target.slug}/revisions`)

    const git = await commitContentChange({
      action: 'restore',
      title: commitTitle({ title: target.title }, target.slug),
      paths: [result.relativePath],
    })

    return actionOk({
      type: target.type,
      slug: target.slug,
      path: result.relativePath,
      checksum: result.checksum,
      restoredRevisionId: parsed.value.revisionId,
      restoredRevisionNo: revision.revisionNo,
      undoRecorded: result.revision.captured,
      undoRevisionNo: result.revision.revisionNo,
      trimmed,
      git,
    })
  } catch (error) {
    if (committed) {
      console.error('[admin] revision restored on disk; follow-up processing failed:', error)
      return actionFailure('The revision was written back to the file, but follow-up processing did not complete.', {
        code: 'content-committed', committed: [committed],
        detail: `Run a content sync from System before trusting the index.${committed.recoveryPath ? ` Previous bytes are retained privately at ${committed.recoveryPath}.` : ''}`,
      })
    }
    return describeActionError(error)
  }
}
