'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { SETTINGS_CACHE_TAG } from '@/lib/settings'
import { RATE_LIMITS, consumeRateLimit, retryAfterSeconds } from '@/lib/auth/rate-limit'
import type { ActionContext } from '@/lib/auth/session'
import { syncContent } from '@/lib/content/sync'
import { enqueue, type JobKind } from '@/lib/jobs'
import { actionFailure, actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'

/**
 * The operations the system page can run.
 *
 * Two shapes of work, kept apart on purpose:
 *
 * - **Now** means this request does it and reports what happened. Only the
 *   content sync is in this group: it is a filesystem scan the operator asked
 *   for and is waiting on, and its report (added, updated, deleted, errors) is
 *   the whole reason to press the button. It is rate limited, because a full
 *   scan reads every Markdown file.
 * - **Queue** means a row is written for the worker to pick up. Everything else
 *   is in this group, including search reindexing: the local provider builds its
 *   index from the files in process memory, so the work belongs where the
 *   process that will hold the index lives.
 *
 * ## Why every one of these is audited
 *
 * An earlier version of this comment argued the opposite — that a sync
 * reconciles derived data and a reindex rebuilds a cache, so neither is "a
 * change to something a reader sees" and an action for them would only put rows
 * in the log that nobody can act on. Two of the buttons falsify that. A sync can
 * delete index rows and `sync-now` revalidates the entire public tree on the
 * strength of it; a publish pass rewrites frontmatter to make documents public.
 * A cache purge is the only record anywhere that somebody caused every page to
 * be rendered again.
 *
 * `system.operation` is one action for all five rather than five, and the
 * operation is in the metadata. The rest of the union is finer-grained because
 * its members are different outcomes for the same objects — a create, an update,
 * a delete. Here the object is always the system page and the difference is
 * already a validated enum, so splitting it would add four more entries to the
 * log's filter for no more information.
 *
 * A rate-limited sync is not recorded. No other rate limit in this application
 * writes a row, and a refusal that changed nothing is not an operation.
 *
 * These rows are written here rather than in a library, which is the opposite of
 * where every other audit call in this tree lives. The others can be in a
 * library because each records a change to one object through one function —
 * `saveNavigation`, `deleteAsset`. Nothing is changed *by* these buttons: a sync
 * is a library function that also runs at boot and from the worker, and the row
 * belongs to the press, not to the scan. So the press is what is recorded, and
 * the press is here.
 */

const operationSchema = z.enum([
  'sync-now',
  'queue-sync',
  'queue-publish',
  'queue-reindex',
  'purge-caches',
])

export type SystemOperation = z.infer<typeof operationSchema>

const inputSchema = z.object({ operation: operationSchema })

export interface SystemOperationResult {
  operation: SystemOperation
  /** One sentence describing what happened. */
  summary: string
  /** A second line, when there is a number or a caveat worth reading. */
  detail?: string
  /** Counts from a sync that ran here. */
  sync?: {
    scanned: number
    added: number
    updated: number
    deleted: number
    unchanged: number
    tagsCreated: number
    linksResolved: number
    linksBroken: number
    truncated: boolean
    durationMs: number
    errors: { path: string; message: string }[]
  }
  /** The kind of job this call queued, when it queued one. */
  queued?: JobKind
}

/**
 * Where each queued operation lands. One place, so the copy and the code agree.
 *
 * `satisfies` rather than an annotation, so the literal kinds survive in the
 * inferred type: `QueueableKind` below is read off this map, and an annotation
 * would widen every value to `JobKind` and take the point of it with them.
 */
const QUEUE_TARGETS = {
  'queue-sync': 'content.sync',
  'queue-publish': 'content.publish-scheduled',
  'queue-reindex': 'search.reindex',
} satisfies Record<'queue-sync' | 'queue-publish' | 'queue-reindex', JobKind>

/**
 * The kinds this page can queue — which is deliberately not every kind.
 *
 * Keyed by what `QUEUE_TARGETS` maps to rather than by `JobKind`, so adding an
 * operation above still fails to compile until it has a sentence, while the
 * kinds nobody presses a button for do not have to pretend to have one. The
 * analytics roll-up, the raw-event prune and the orphan scan are the worker's own
 * housekeeping: they run on its cadence, and three more levers on a page an
 * author visits to reconcile content would be three more things to explain.
 */
type QueueableKind = (typeof QUEUE_TARGETS)[keyof typeof QUEUE_TARGETS]

const QUEUED_COPY: Record<QueueableKind, string> = {
  'content.sync': 'A content sync is queued.',
  'content.publish-scheduled': 'A publish pass is queued.',
  'search.reindex': 'A search reindex is queued.',
}

export async function runSystemOperationAction(
  input: unknown,
): Promise<ActionResult<SystemOperationResult>> {
  try {
    const context = await guardAction()

    const parsed = parseActionInput(inputSchema, input)
    if (!parsed.ok) return parsed

    switch (parsed.value.operation) {
      case 'sync-now': {
        const limit = await consumeRateLimit(
          `system:sync:${context.user.id}`,
          RATE_LIMITS.sensitiveAction,
        )
        if (!limit.allowed) {
          return actionFailure('Too many syncs in the last hour.', {
            detail: `A sync reads every Markdown file. Try again in ${retryAfterSeconds(limit)} second(s).`,
            retryable: true,
          })
        }

        const report = await syncContent()

        await recordOperation(context, 'sync-now', {
          scanned: report.scanned,
          added: report.added,
          updated: report.updated,
          deleted: report.deleted,
          errors: report.errors.length,
          truncated: report.truncated,
        })

        // A sync can add, change or delete anything public, and it also moves
        // the counts the admin lists are built from.
        revalidatePath('/', 'layout')

        return actionOk({
          operation: 'sync-now',
          summary: report.errors.length
            ? `Sync finished with ${report.errors.length} file error${report.errors.length === 1 ? '' : 's'}.`
            : 'Sync finished.',
          detail: `${report.scanned} files scanned, ${report.added} added, ${report.updated} updated, ${report.deleted} deleted, ${report.unchanged} unchanged.`,
          sync: {
            scanned: report.scanned,
            added: report.added,
            updated: report.updated,
            deleted: report.deleted,
            unchanged: report.unchanged,
            tagsCreated: report.tagsCreated,
            linksResolved: report.linksResolved,
            linksBroken: report.linksBroken,
            truncated: report.truncated,
            durationMs: report.durationMs,
            errors: report.errors.map((error) => ({ path: error.path, message: error.message })),
          },
        })
      }

      case 'queue-sync':
      case 'queue-publish':
      case 'queue-reindex': {
        const kind = QUEUE_TARGETS[parsed.value.operation]

        // The dedupe key is fixed per kind rather than random: pressing the
        // button twice should not queue the same pass twice, and the partial
        // unique index behind this collapses the second insert instead.
        const row = await enqueue({ type: kind, dedupeKey: 'admin' })

        await recordOperation(context, parsed.value.operation, {
          kind,
          // The job that will do the work, when one was queued. A publish pass
          // records `post.publish` against each document it publishes, with a
          // null actor because the worker is what acts; this row is the only
          // place that says which administrator asked for it.
          ...(row ? { jobId: row.id } : {}),
          deduped: row === null,
        })

        revalidatePath('/admin/system')

        return actionOk({
          operation: parsed.value.operation,
          summary: row ? QUEUED_COPY[kind] : 'Nothing was queued.',
          detail: row
            ? `Job ${row.id} is pending. Nothing runs it until the worker does — see the queue below.`
            : `A ${kind} job is already pending, so this press changed nothing.`,
          queued: row ? kind : undefined,
        })
      }

      case 'purge-caches': {
        purgeCaches()
        await recordOperation(context, 'purge-caches')
        return actionOk({
          operation: 'purge-caches',
          summary: 'Caches purged.',
          detail:
            'The public tree is marked for rebuild, so the next request for any page renders it again. The settings tag was purged too, though nothing in this build attaches it to cached data — settings are read per request — so that part is a no-op today.',
        })
      }
    }
  } catch (error) {
    return describeActionError(error)
  }
}

/**
 * One audit row per press, whatever it was.
 *
 * `targetId` is the operation rather than a row id, because there is no single
 * row these act on: a sync touches as many documents as it touches. What a
 * reader of the log wants from these is who reached for the button and when, and
 * the metadata carries the counts that make the row specific.
 */
async function recordOperation(
  context: ActionContext,
  operation: SystemOperation,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit({
    action: 'system.operation',
    actorId: context.user.id,
    targetType: 'system',
    targetId: operation,
    metadata: { via: 'admin.system', operation, ...metadata },
    request: context.request,
  })
}

/**
 * Invalidate what this admin can reach.
 *
 * Two mechanisms, and neither is a general "clear the cache": Next's data cache
 * is per-process and in-memory, and the entries that matter are the ones tagged
 * with the settings tag and the rendered public pages. Everything else expires
 * on its own schedule.
 *
 * `updateTag` rather than `revalidateTag` for the tagged data: this runs from a
 * Server Action and the person who pressed the button is waiting to see the
 * result, so the cache expires immediately and the next request blocks for fresh
 * data. `revalidateTag` would serve the stale copy first and refresh behind it,
 * which is the right default for an ordinary write and the wrong one for a
 * button that says purge.
 *
 * Searched for and worth stating: nothing currently attaches
 * `SETTINGS_CACHE_TAG` to cached data — there is no `'use cache'` consumer in
 * this tree, and `getSettings` is memoised per request instead — so the tag call
 * is a no-op today and the path revalidation is the whole effect. It stays
 * because the tag is part of the settings module's declared contract and the
 * first `'use cache'` reader will need it; the answer the button gives says so
 * rather than implying more than happened.
 */
function purgeCaches(): void {
  updateTag(SETTINGS_CACHE_TAG)
  revalidatePath('/', 'layout')
}
