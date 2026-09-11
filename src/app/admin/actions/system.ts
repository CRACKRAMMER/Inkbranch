'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'

import { SETTINGS_CACHE_TAG } from '@/lib/settings'
import { RATE_LIMITS, consumeRateLimit, retryAfterSeconds } from '@/lib/auth/rate-limit'
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
 * None of these record an audit row, and that is a fact about the audit union
 * rather than an oversight: `AUDIT_ACTIONS` covers changes to content, assets,
 * settings, navigation and redirects. A sync reconciles derived data and a
 * reindex rebuilds a cache — neither is a change to something a reader sees —
 * and inventing an action for them would put rows in the log that no reader of
 * it can act on. The page says so where the buttons are.
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
