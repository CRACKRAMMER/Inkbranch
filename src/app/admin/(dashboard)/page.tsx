import type { Metadata } from 'next'
import Link from 'next/link'

import { listAuditLogs } from '@/lib/audit'
import { requireUser } from '@/lib/auth/session'
import { checkContentDrift, countStaleSearchRows } from '@/lib/content/sync'
import { jobStatusCounts, listJobs, type JobStatus } from '@/lib/jobs'
import { getSettings } from '@/lib/settings'
import { formatRelative } from '@/lib/utils/date'
import { formatBytes } from '@/lib/utils/format'
import {
  contentCounts,
  dueScheduledContent,
  publishedInLastDays,
  recentlyUpdatedContent,
} from '@/lib/admin/queries'
import { analyticsEnabled, getTrafficWindows, type TrafficWindows } from '@/lib/analytics'
import { assetStorage } from '@/lib/assets/manage'
import { isUploadStorageWritable } from '@/lib/assets/storage'
import { searchProviderName } from '@/lib/search'
import { TYPE_COPY, segmentForType } from '@/lib/admin/routes'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { StatusBadge } from '@/components/admin/status-badge'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * How far back the per-type delta reaches.
 *
 * Seven days rather than the calendar week the brief asks for in words: a
 * calendar week has to be resolved in the site's timezone, and a "this week"
 * that is a day out is worse than a "last 7 days" that is exactly right. See
 * `publishedPerTypeSince`, where the reasoning is written out.
 */
const WEEK_DAYS = 7

/**
 * The traffic windows, in the order they are read.
 *
 * `key` is constrained to the fields `getTrafficWindows` returns rather than
 * being a plain string, so renaming a window there fails to compile here
 * instead of rendering a blank where a figure should be. What the labels say is
 * this page's business; how long each window is, is the query module's.
 */
const TRAFFIC_ROWS = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
] as const satisfies readonly { key: keyof TrafficWindows; label: string }[]

/**
 * Where the admin lands after signing in.
 *
 * Ordered by what needs acting on rather than by what is interesting to look at:
 * anything wrong first (drift, failed jobs, overdue schedules), then the state of
 * the content, then what happened recently. A dashboard that leads with a chart
 * of last month's traffic leads with the one number nobody can act on.
 *
 * The last two sections are that principle's other half. Traffic does not
 * belong above the content state, and the three system checks do not belong
 * above anything — they are the answer to "is the machinery sound", which is a
 * question asked after "is there anything to do". Both are here so the page
 * answers them without a second navigation, not because they are news.
 */
export default async function DashboardPage() {
  await requireUser()

  const now = new Date()
  const enabled = analyticsEnabled()

  const [
    settings,
    counts,
    recent,
    audit,
    jobs,
    jobCounts,
    drift,
    overdue,
    publishedThisWeek,
    storage,
    storageWritable,
    staleSearchRows,
    traffic,
  ] = await Promise.all([
    getSettings(),
    contentCounts(),
    recentlyUpdatedContent(8),
    listAuditLogs({ limit: 8 }),
    listJobs({ limit: 50 }),
    jobStatusCounts(),
    checkContentDrift(),
    dueScheduledContent(5),
    publishedInLastDays(WEEK_DAYS),
    assetStorage(),
    isUploadStorageWritable(),
    countStaleSearchRows(),
    // Not read at all when collection is off: the switch exists to stop the
    // dashboard asking, and three zeroes would read as "nobody came" rather
    // than "nothing is being counted".
    enabled ? getTrafficWindows(now) : null,
  ])

  const context = { locale: settings.locale, timeZone: settings.timezone, now }
  /*
    `jobs` is a window — the most recently created fifty — and `jobCounts` is the
    whole queue. The counts come from the second: "Jobs open" and "N jobs failed"
    are statements about the installation, and a job stuck in `pending` since
    yesterday is older than fifty that finished since it, so a count of the
    window would drop precisely the row worth seeing.
  */
  const byStatus = (status: JobStatus) => jobs.filter((job) => job.status === status)
  const failedJobs = byStatus('failed')
  const openJobs = jobCounts.pending + jobCounts.running
  const drafts = counts.byStatus.draft.total + counts.byStatus.scheduled.total

  /*
    Both figures when they disagree, one when they cannot. The number of indexed
    documents is the figure that means something when the two agree, and stating
    it twice reads as a comparison that failed rather than one that passed.
  */
  const indexDetail = drift.drift
    ? `${drift.indexed} indexed, ${drift.scanned} on disk`
    : `${drift.indexed} document${drift.indexed === 1 ? '' : 's'}`

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

      {jobCounts.failed > 0 ? (
        <InlineNote tone="danger">
          {jobCounts.failed} job{jobCounts.failed === 1 ? '' : 's'} failed.
          {/*
            The error comes from the recent window, the count does not, so a
            failure old enough to have fallen out of the window is reported
            without one. Saying "not recorded" there would blame the log for
            what is this list's own limit.
          */}
          {failedJobs[0]?.lastError ? (
            <>
              {' '}
              The last error was{' '}
              <span className="font-mono text-xs">{failedJobs[0].lastError}</span>.
            </>
          ) : null}{' '}
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
        <div
          role="region"
          aria-label="Content counts by type and status"
          tabIndex={0}
          className="overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <th scope="col" className="py-2 pr-4 font-medium text-ink-muted">
                  Total
                </th>
                {/*
                  A time axis next to a status axis, which is why it says what the
                  window is in the header rather than leaving a bare `+3` to be
                  interpreted. Published-and-since-archived counts here and not in
                  the Total beside it; that is the difference between the column
                  and its neighbour, so both are labelled.
                */}
                <th
                  scope="col"
                  title={`Became public in the last ${WEEK_DAYS} days, whatever their status now`}
                  className="py-2 font-medium text-ink-muted"
                >
                  New ({WEEK_DAYS}d)
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
                  <td className="py-2 pr-4 tabular-nums text-ink">{counts.byType[type]}</td>
                  {/*
                    A dash rather than `+0`: a week without a post is not a
                    measurement of zero, it is nothing to report, and a column of
                    zeroes is what the eye stops reading.
                  */}
                  <td className="py-2 tabular-nums text-ink-muted">
                    {publishedThisWeek[type] > 0 ? `+${publishedThisWeek[type]}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
          description="Scheduled work — content syncs, scheduled publishing, search reindexing. The counts are the whole queue; the list below them is the most recent few."
        >
          {jobs.length === 0 ? (
            <InlineNote>The queue is empty.</InlineNote>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {(['pending', 'running', 'failed', 'done'] as const).map((status) => {
                  const total = jobCounts[status]
                  if (total === 0) return null
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
                      {status} {total}
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

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <Section
          title="Traffic"
          description="Rolling windows ending today, read from the daily aggregates. Visitors is an upper bound on distinct readers — the Analytics page is where that caveat is written out."
        >
          {traffic === null ? (
            /*
              Collection being off is stated rather than shown as zeroes. The
              switch stops the site from recording; it does not delete what was
              already recorded, which is why the link below still goes
              somewhere worth going.
            */
            <InlineNote>
              Collection is off — <span className="font-mono text-xs">ANALYTICS_ENABLED</span> is not
              set, so nothing is being recorded and these windows are not read. Days already
              aggregated are still there.
            </InlineNote>
          ) : (
            <dl className="border-t border-line">
              {TRAFFIC_ROWS.map(({ key, label }) => (
                <div
                  key={key}
                  className="flex items-baseline justify-between gap-6 border-b border-line py-2"
                >
                  <dt className="text-xs text-ink-muted">{label}</dt>
                  <dd className="text-xs tabular-nums text-ink">
                    {traffic[key].views} <span className="text-ink-subtle">views</span>
                    <span className="mx-1.5 text-ink-subtle">·</span>
                    {traffic[key].visitors} <span className="text-ink-subtle">visitors</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-3 text-xs text-ink-subtle">
            <Link href="/admin/analytics" className="text-brand underline underline-offset-2">
              Analytics
            </Link>{' '}
            — any range, top content, referrers.
          </p>
        </Section>

        <Section
          title="System"
          description="Three checks, in one line each. Storage counts the originals; the derivatives beside them are files on disk that no column records."
        >
          <dl className="border-t border-line">
            <CheckRow
              label="Content index"
              state={drift.drift ? 'out of sync' : 'in sync'}
              tone={drift.drift ? 'warning' : 'ok'}
              detail={indexDetail}
            />
            <CheckRow
              label="Search index"
              state={staleSearchRows === 0 ? 'up to date' : `${staleSearchRows} stale`}
              tone={staleSearchRows === 0 ? 'ok' : 'warning'}
              detail={`${searchProviderName()} provider`}
            />
            <CheckRow
              label="Storage"
              state={storageWritable ? 'writable' : 'not writable'}
              tone={storageWritable ? 'ok' : 'warning'}
              detail={`${storage.files} file${storage.files === 1 ? '' : 's'}, ${formatBytes(storage.bytes)}`}
            />
          </dl>
          <p className="mt-3 text-xs text-ink-subtle">
            <Link href="/admin/system" className="text-brand underline underline-offset-2">
              System
            </Link>{' '}
            — run a sync, reindex, and read the environment.
          </p>
        </Section>
      </div>
    </Page>
  )
}

/**
 * One line of the System check list.
 *
 * The state is a word rather than a `✓`: a tick read aloud is "check mark", and
 * the two states that matter here are failures, which a tick has no way to
 * express. The tone carries the colour, and the word carries the meaning, so
 * removing the colour removes nothing.
 *
 * Every row links to the same page, which is the point of the list — each line
 * answers "is this sound", and the page it points at answers "and what do I do
 * about it". The link is the label rather than an icon at the end, because a
 * row of three identical icons is three targets that say nothing.
 */
function CheckRow({
  label,
  state,
  tone,
  detail,
}: {
  label: string
  state: string
  tone: 'ok' | 'warning'
  detail: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-2">
      <dt className="text-xs">
        <Link href="/admin/system" className="text-ink hover:text-brand">
          {label}
        </Link>
      </dt>
      <dd className="text-right text-xs">
        <span className={tone === 'ok' ? 'text-ink' : 'text-warning'}>{state}</span>
        <span className="ml-2 text-ink-subtle">{detail}</span>
      </dd>
    </div>
  )
}
