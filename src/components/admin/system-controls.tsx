'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import {
  runSystemOperationAction,
  type SystemOperation,
  type SystemOperationResult,
} from '@/app/admin/actions/system'
import { Button } from '@/components/ui/button'

/**
 * The maintenance buttons, and the report from the last one.
 *
 * One component for all five because the interesting part is the answer, not the
 * press: a sync that ran returns counts, a queued job returns the row it wrote
 * or the news that an equivalent job is already pending, and either way the
 * result stays on screen until the next press. A toast alone would be gone
 * before an operator finished reading the numbers.
 */

const ACTIONS: {
  operation: SystemOperation
  label: string
  variant: 'default' | 'secondary' | 'ghost'
  /** What the button does, for the tooltip-free case where the label is short. */
  description: string
}[] = [
  {
    operation: 'sync-now',
    label: 'Reconcile now',
    variant: 'default',
    description: 'Reads every Markdown file and updates the index. Takes as long as the tree is big.',
  },
  {
    operation: 'queue-sync',
    label: 'Queue a sync',
    variant: 'secondary',
    description: 'Writes a content.sync job for the worker.',
  },
  {
    operation: 'queue-publish',
    label: 'Queue a publish pass',
    variant: 'secondary',
    description: 'Writes a content.publish-scheduled job, which publishes anything that has come due.',
  },
  {
    operation: 'queue-reindex',
    label: 'Queue a reindex',
    variant: 'secondary',
    description: 'Writes a search.reindex job for documents indexed under an older shape.',
  },
  {
    operation: 'purge-caches',
    label: 'Purge caches',
    variant: 'ghost',
    description: 'Invalidates the settings tag and the whole public tree.',
  },
]

export function SystemActions() {
  const router = useRouter()
  const [report, setReport] = useState<SystemOperationResult | null>(null)
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const [running, setRunning] = useState<SystemOperation | null>(null)
  const [pending, startTransition] = useTransition()

  function run(operation: SystemOperation) {
    setFailure(null)
    setRunning(operation)

    startTransition(async () => {
      const result = await runSystemOperationAction({ operation })
      setRunning(null)

      if (!result.ok) {
        setReport(null)
        setFailure({ message: result.error, detail: result.detail })
        return
      }

      setReport(result.data)
      toast.success(result.data.summary)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((action) => (
          <Button
            key={action.operation}
            type="button"
            size="sm"
            variant={action.variant}
            disabled={pending}
            onClick={() => run(action.operation)}
          >
            {running === action.operation ? 'Working…' : action.label}
          </Button>
        ))}
      </div>

      <ul className="space-y-1 text-xs leading-relaxed text-ink-subtle">
        {ACTIONS.map((action) => (
          <li key={action.operation}>
            <span className="text-ink-muted">{action.label}</span> — {action.description}
          </li>
        ))}
      </ul>

      {failure ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {failure.message}
          {failure.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{failure.detail}</span>
          ) : null}
        </p>
      ) : null}

      {report ? (
        <div aria-live="polite" className="border border-line bg-sunken px-4 py-3 text-sm">
          <p className="text-ink">{report.summary}</p>
          {report.detail ? <p className="mt-1 text-xs text-ink-muted">{report.detail}</p> : null}

          {report.sync ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-line pt-3 text-xs sm:grid-cols-3">
                <SyncStat label="Scanned" value={report.sync.scanned} />
                <SyncStat label="Added" value={report.sync.added} />
                <SyncStat label="Updated" value={report.sync.updated} />
                <SyncStat label="Deleted" value={report.sync.deleted} />
                <SyncStat label="Unchanged" value={report.sync.unchanged} />
                <SyncStat label="Tags created" value={report.sync.tagsCreated} />
                <SyncStat label="Links resolved" value={report.sync.linksResolved} />
                <SyncStat label="Links broken" value={report.sync.linksBroken} />
                <SyncStat label="Took" value={`${report.sync.durationMs} ms`} />
              </dl>

              {report.sync.truncated ? (
                <p className="mt-3 border-t border-line pt-3 text-xs text-ink">
                  The scan stopped at the file cap, so this run is partial and files past the cap were
                  treated as absent. Raise CONTENT_MAX_FILES before trusting these counts.
                </p>
              ) : null}

              {report.sync.errors.length > 0 ? (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="text-xs text-ink">
                    {report.sync.errors.length} file
                    {report.sync.errors.length === 1 ? '' : 's'} could not be read:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {report.sync.errors.map((error) => (
                      <li key={`${error.path}-${error.message}`} className="text-xs text-ink-muted">
                        <span className="font-mono">{error.path}</span> — {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SyncStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  )
}
