import type { Metadata } from 'next'
import Link from 'next/link'

import { listAuditLogs } from '@/lib/audit'
import { requireUser } from '@/lib/auth/session'
import { checkContentDrift } from '@/lib/content/sync'
import { listJobs, type JobStatus } from '@/lib/jobs'
import { getSettings } from '@/lib/settings'
import { formatRelative } from '@/lib/utils/date'
import {
  contentCounts,
  dueScheduledContent,
  recentlyUpdatedContent,
} from '@/lib/admin/queries'
import { TYPE_COPY, segmentForType } from '@/lib/admin/routes'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { StatusBadge } from '@/components/admin/status-badge'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * Where the admin lands after signing in.
 *
 * Ordered by what needs acting on rather than by what is interesting to look at:
 * anything wrong first (drift, failed jobs, overdue schedules), then the state of
 * the content, then what happened recently. A dashboard that leads with a chart
 * of last month's traffic leads with the one number nobody can act on.
 */
export default async function DashboardPage() {
  await requireUser()

  const [settings, counts, recent, audit, jobs, drift, overdue] = await Promise.all([
    getSettings(),
    contentCounts(),
    recentlyUpdatedContent(8),
    listAuditLogs({ limit: 8 }),
    listJobs({ limit: 50 }),
    checkContentDrift(),
    dueScheduledContent(5),
  ])

  const now = new Date()
  const context = { locale: settings.locale, timeZone: settings.timezone, now }
  const byStatus = (status: JobStatus) => jobs.filter((job) => job.status === status)
  const failedJobs = byStatus('failed')
  const openJobs = byStatus('pending').length + byStatus('running').length
  const drafts = counts.byStatus.draft.total + counts.byStatus.scheduled.total

  return (
    <Page title="Dashboard" eyebrow={settings.siteName} measure="wide">
      {drift.drift ? (
        <InlineNote tone="warning">
          The content index and the files on disk disagree ({drift.scanned} files, {drift.indexed}{' '}
          indexed). Lists and counts on these pages read from the index, so they may be missing a
          document.{' '}
          <Link href="/admin/system" className="text-brand underline underline-offset-2">
            Run a sync from System
          </Link>
          .
        </InlineNote>
      ) : null}

      {failedJobs.length > 0 ? (
        <InlineNote tone="danger">
          {failedJobs.length} job{failedJobs.length === 1 ? '' : 's'} failed. The last error was{' '}
          <span className="font-mono text-xs">{failedJobs[0]?.lastError ?? 'not recorded'}</span>.{' '}
          <Link href="/admin/system#queue" className="text-brand underline underline-offset-2">
            See the queue
          </Link>
          .
        </InlineNote>
      ) : null}

      {overdue.length > 0 ? (
        <InlineNote>
          {overdue.length} scheduled document{overdue.length === 1 ? ' is' : 's are'} due but still
          marked scheduled — the worker that publishes them has not run.{' '}
          <Link href="/admin/system#queue" className="text-brand underline underline-offset-2">
            Queue a publish pass
          </Link>
          .
        </InlineNote>
      ) : null}

      <StatRow>
        <StatCell>
          <Stat label="Documents" value={counts.total} />
        </StatCell>
        <StatCell>
          <Stat label="Published" value={counts.byStatus.published.total} />
        </StatCell>
        <StatCell>
          <Stat label="Drafts & scheduled" value={drafts} />
        </StatCell>
        <StatCell>
          <Stat label="Jobs open" value={openJobs} note={failedJobs.length > 0 ? `${failedJobs.length} failed` : undefined} />
        </StatCell>
      </StatRow>

      <Section
        title="By type and status"
        description="Counts come from the content index. A file that is on disk but not indexed is not counted here — the drift line above is what tells you that."
        actions={
          <Link
            href="/admin/posts/new"
            className="text-sm text-brand underline underline-offset-2"
          >
            New post
          </Link>
        }
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 pr-4 font-medium text-ink-muted">
                Type
              </th>
              {(['draft', 'scheduled', 'published', 'archived'] as const).map((status) => (
                <th key={status} scope="col" className="py-2 pr-4 font-medium text-ink-muted">
                  {status}
                </th>
              ))}
              <th scope="col" className="py-2 font-medium text-ink-muted">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {(['post', 'note', 'project'] as const).map((type) => (
              <tr key={type} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-normal">
                  <Link
                    href={`/admin/${segmentForType(type)}`}
                    className="text-ink hover:text-brand"
                  >
                    {TYPE_COPY[type].plural}
                  </Link>
                </th>
                {(['draft', 'scheduled', 'published', 'archived'] as const).map((status) => (
                  <td key={status} className="py-2 pr-4 tabular-nums text-ink-muted">
                    {counts.byStatus[status].byType[type]}
                  </td>
                ))}
                <td className="py-2 tabular-nums text-ink">{counts.byType[type]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Recently updated"
        description="The eight documents whose files changed most recently."
      >
        {recent.length === 0 ? (
          <InlineNote>
            Nothing is indexed yet. If you have Markdown files in <code>content/</code>, run a sync
            from System.
          </InlineNote>
        ) : (
          <ul className="border-t border-line">
            {recent.map((item) => (
              <li key={item.id} className="flex items-baseline gap-3 border-b border-line py-2.5">
                <span className="w-16 shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
                  {item.type}
                </span>
                <Link
                  href={`/admin/${segmentForType(item.type)}/${item.slug}/edit`}
                  className="min-w-0 flex-1 truncate text-sm text-ink hover:text-brand"
                >
                  {item.title}
                </Link>
                <StatusBadge status={item.status} />
                <time
                  dateTime={item.updatedAt.toISOString()}
                  className="w-28 shrink-0 text-right text-xs text-ink-subtle"
                >
                  {formatRelative(item.updatedAt, context)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <Section title="Recent activity" description="The last few entries in the audit log.">
          {audit.rows.length === 0 ? (
            <InlineNote>Nothing has been recorded yet.</InlineNote>
          ) : (
            <ul className="border-t border-line">
              {audit.rows.map((row) => (
                <li key={row.id} className="border-b border-line py-2.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-xs text-ink">{row.action}</span>
                    <time
                      dateTime={row.createdAt.toISOString()}
                      className="shrink-0 text-xs text-ink-subtle"
                    >
                      {formatRelative(row.createdAt, context)}
                    </time>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-muted">
                    {row.targetId ?? row.targetType ?? '—'}
                    {row.outcome === 'denied' ? ' · denied' : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-subtle">
            <Link href="/admin/system#audit" className="text-brand underline underline-offset-2">
              Full audit log
            </Link>
          </p>
        </Section>

        <Section
          title="Job queue"
          description="Scheduled work — content syncs, scheduled publishing, search reindexing."
        >
          {jobs.length === 0 ? (
            <InlineNote>The queue is empty.</InlineNote>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {(['pending', 'running', 'failed', 'done'] as const).map((status) => {
                  const rows = byStatus(status)
                  if (rows.length === 0) return null
                  return (
                    <Badge
                      key={status}
                      variant={
                        status === 'failed'
                          ? 'destructive'
                          : status === 'done'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {status} {rows.length}
                    </Badge>
                  )
                })}
              </div>
              <ul className="mt-4 border-t border-line">
                {jobs.slice(0, 6).map((job) => (
                  <li key={job.id} className="border-b border-line py-2.5 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-xs text-ink">{job.type}</span>
                      <time
                        dateTime={job.runAt.toISOString()}
                        className="shrink-0 text-xs text-ink-subtle"
                      >
                        {formatRelative(job.runAt, context)}
                      </time>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {job.status}
                      {job.attempts > 0 ? ` · ${job.attempts}/${job.maxAttempts} attempts` : ''}
                      {job.lastError ? ` · ${job.lastError}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-subtle">
                <Link href="/admin/system#queue" className="text-brand underline underline-offset-2">
                  Queue and run jobs
                </Link>
              </p>
            </>
          )}
        </Section>
      </div>
    </Page>
  )
}
