import type { Metadata } from 'next'
import Link from 'next/link'

import { AUDIT_ACTIONS, listAuditLogs, type AuditAction } from '@/lib/audit'
import { requireUser } from '@/lib/auth/session'
import { checkContentDrift } from '@/lib/content/sync'
import { env } from '@/env'
import { listJobs, type JobStatus } from '@/lib/jobs'
import { searchProviderName } from '@/lib/search'
import { getSettings } from '@/lib/settings'
import { formatDate, formatRelative } from '@/lib/utils/date'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { Pagination } from '@/components/admin/pagination'
import { SystemActions } from '@/components/admin/system-controls'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'System' }

const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'failed', 'done']
const JOB_LIMIT = 25
const AUDIT_PER_PAGE = 50

/**
 * Maintenance: the state of the derived data, the queue that keeps it moving,
 * and the log of who changed what.
 *
 * The two anchors on this page (`#queue`, `#audit`) are linked from the
 * dashboard and from a bulk tag operation, so the ids are load-bearing rather
 * than decorative.
 *
 * What is shown about the environment is what an operator can act on and
 * nothing else: flags, paths, limits. `SESSION_SECRET` and the database
 * password are not rendered, not truncated, and not hinted at — a settings page
 * that shows half a secret is a page that invites someone to screenshot it.
 * The database is identified by host and database name, which is the part that
 * answers "which server am I looking at".
 */
export default async function SystemPage({
  searchParams,
}: {
  searchParams: Promise<{ audit?: string; action?: string }>
}) {
  await requireUser()

  const query = await searchParams
  const auditPage = clampPage(query.audit)
  const actionFilter = AUDIT_ACTIONS.includes(query.action as AuditAction)
    ? (query.action as AuditAction)
    : undefined

  const [settings, drift, jobs, audit] = await Promise.all([
    getSettings(),
    checkContentDrift(),
    listJobs({ limit: JOB_LIMIT }),
    listAuditLogs({
      limit: AUDIT_PER_PAGE,
      offset: (auditPage - 1) * AUDIT_PER_PAGE,
      ...(actionFilter ? { action: actionFilter } : {}),
    }),
  ])

  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }
  const byStatus = (status: JobStatus) => jobs.filter((job) => job.status === status)
  const auditPageCount = Math.max(1, Math.ceil(audit.total / AUDIT_PER_PAGE))
  const provider = searchProviderName()

  return (
    <Page
      title="System"
      measure="wide"
      description="Derived data, the job queue, and the audit log. Nothing on this page changes a Markdown file — the sync reads them and updates the index, which is the direction that is safe to run at any time."
    >
      <StatRow>
        <StatCell>
          <Stat
            label="Indexed"
            value={drift.indexed}
            note={`${drift.scanned} file${drift.scanned === 1 ? '' : 's'} on disk`}
          />
        </StatCell>
        <StatCell>
          <Stat
            label="Drift"
            value={drift.drift ? 'yes' : 'no'}
            note={drift.drift ? 'Files and index disagree' : 'Files and index agree'}
          />
        </StatCell>
        <StatCell>
          <Stat label="Jobs pending" value={byStatus('pending').length + byStatus('running').length} />
        </StatCell>
        <StatCell>
          <Stat
            label="Jobs failed"
            value={byStatus('failed').length}
            note={byStatus('failed').length > 0 ? 'Newest first below' : undefined}
          />
        </StatCell>
      </StatRow>

      {drift.drift ? (
        <InlineNote tone="warning">
          The index and the tree disagree: {drift.scanned} file{drift.scanned === 1 ? '' : 's'} on
          disk against {drift.indexed} indexed row{drift.indexed === 1 ? '' : 's'}. Every list and
          count in this admin reads the index, so it may be missing a document or carrying one that
          no longer exists. A sync reconciles both directions — it adds, updates and deletes index
          rows to match the files.
        </InlineNote>
      ) : null}

      <Section
        title="Maintenance"
        description="Two ways to run the same work: here, so you can read the result, or as a job, for the worker to pick up."
      >
        <SystemActions />
        <p className="mt-4 max-w-[46rem] text-xs leading-relaxed text-ink-subtle">
          Queueing writes a row and nothing else happens until the worker runs — start it with{' '}
          <span className="font-mono">pnpm worker</span>, or run these as one-shot commands with{' '}
          <span className="font-mono">pnpm content:sync</span> and{' '}
          <span className="font-mono">pnpm content:reindex</span>. None of these operations writes an
          audit entry: the audit log records changes to content, assets, settings, navigation and
          redirects, and a sync or a reindex changes none of them.
        </p>
      </Section>

      <Section
        title="Environment"
        description="What this process is configured with. Secrets are not shown, in part or in full."
      >
        <dl className="grid grid-cols-1 gap-x-10 gap-y-0 border-t border-line sm:grid-cols-2">
          <EnvRow label="Environment" value={env.NODE_ENV} />
          <EnvRow label="Node" value={process.version} />
          <EnvRow label="Site URL" value={env.SITE_URL} />
          <EnvRow label="Database" value={databaseLabel()} />
          <EnvRow label="Search provider" value={provider} />
          <EnvRow label="Content directory" value={env.CONTENT_DIR} />
          <EnvRow label="File cap" value={String(env.CONTENT_MAX_FILES)} />
          <EnvRow label="Sync on boot" value={env.CONTENT_SYNC_ON_BOOT ? 'on' : 'off'} />
          <EnvRow label="Uploads written to" value={env.UPLOAD_DIR} />
          <EnvRow label="Uploads served from" value={env.UPLOAD_URL_PREFIX} />
          <EnvRow label="Upload limit" value={formatBytes(env.MAX_UPLOAD_SIZE)} />
          <EnvRow label="Analytics collection" value={env.ANALYTICS_ENABLED ? 'on' : 'off'} />
          <EnvRow
            label="Raw event retention"
            value={`${env.ANALYTICS_RAW_RETENTION_DAYS} day${env.ANALYTICS_RAW_RETENTION_DAYS === 1 ? '' : 's'}`}
          />
          <EnvRow label="Git integration" value={env.GIT_INTEGRATION_ENABLED ? 'on' : 'off'} />
          <EnvRow label="Worker interval" value={`${Math.round(env.WORKER_INTERVAL_MS / 1000)}s`} />
          <EnvRow label="Cookies secure" value={env.COOKIE_SECURE ? 'yes' : 'no'} />
          <EnvRow label="Session cookie" value={env.SESSION_COOKIE_NAME} />
          <EnvRow label="Database pool" value={`${env.DATABASE_POOL_MAX} connection(s)`} />
        </dl>
        <p className="mt-4 max-w-[46rem] text-xs leading-relaxed text-ink-subtle">
          Collection and the git integration are gated here and not by the settings table, which is
          why the settings page says so beside each of those switches.
        </p>
      </Section>

      <Section
        title="Job queue"
        description={`The ${JOB_LIMIT} most recent jobs. The worker claims one at a time; a job that has not run yet is waiting for it, not broken.`}
      >
        <div id="queue" className="scroll-mt-24" />
        {jobs.length === 0 ? (
          <InlineNote>
            The queue is empty. Nothing is scheduled, and nothing has run yet.
          </InlineNote>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {JOB_STATUSES.map((status) => (
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
                  {status} {byStatus(status).length}
                </Badge>
              ))}
            </div>

            <div className="mt-4 overflow-x-auto border-t border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Most recent jobs, newest first</caption>
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Kind
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Attempts
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Run at
                    </th>
                    <th scope="col" className="py-2 font-medium text-ink-muted">
                      Last error
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} className="border-b border-line align-top last:border-0">
                      <th scope="row" className="py-2.5 pr-3 text-left font-mono text-xs font-normal text-ink">
                        {job.type}
                        {job.dedupeKey ? (
                          <span className="mt-1 block text-ink-subtle">dedupe: {job.dedupeKey}</span>
                        ) : null}
                      </th>
                      <td className="py-2.5 pr-3">
                        <Badge
                          variant={
                            job.status === 'failed'
                              ? 'destructive'
                              : job.status === 'done'
                                ? 'secondary'
                                : 'outline'
                          }
                        >
                          {job.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-ink-muted">
                        {job.attempts}/{job.maxAttempts}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-ink-muted">
                        {formatRelative(job.runAt, context)}
                        {job.finishedAt ? (
                          <span className="mt-0.5 block text-ink-subtle">
                            finished {formatRelative(job.finishedAt, context)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 text-xs text-ink-muted">
                        {job.lastError ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
              A job that failed is retried with a growing delay until it runs out of attempts; the
              count above is how many it has used. Retrying one by hand means queueing it again.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Audit log"
        description="One row per mutating action, newest first. Evidence after the fact — nothing in the site reads this to decide anything."
        actions={
          <form method="get" className="flex items-center gap-2">
            <label className="sr-only" htmlFor="audit-action">
              Filter by action
            </label>
            <select
              id="audit-action"
              name="action"
              defaultValue={actionFilter ?? ''}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="">All actions</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="h-8 rounded-md border border-line-strong px-2.5 text-xs text-ink hover:bg-sunken"
            >
              Filter
            </button>
          </form>
        }
      >
        <div id="audit" className="scroll-mt-24" />
        {audit.rows.length === 0 ? (
          <InlineNote>
            {actionFilter
              ? `No ${actionFilter} entries.`
              : 'Nothing has been recorded yet. Signing in, saving a document, uploading an asset and changing a setting all write a row here.'}
          </InlineNote>
        ) : (
          <>
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Audit entries, newest first{actionFilter ? `, filtered to ${actionFilter}` : ''}
                </caption>
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      When
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Action
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Outcome
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                      Target
                    </th>
                    <th scope="col" className="py-2 font-medium text-ink-muted">
                      Metadata
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {audit.rows.map((row) => (
                    <tr key={row.id} className="border-b border-line align-top last:border-0">
                      <th scope="row" className="whitespace-nowrap py-2.5 pr-3 text-left text-xs font-normal text-ink-muted">
                        <time dateTime={row.createdAt.toISOString()}>
                          {formatDate(row.createdAt, context, 'short')}
                        </time>
                      </th>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink">{row.action}</td>
                      <td className="py-2.5 pr-3">
                        <Badge variant={row.outcome === 'denied' ? 'destructive' : 'secondary'}>
                          {row.outcome}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-ink-muted">
                        {row.targetType ? (
                          <span className="font-mono">
                            {row.targetType}
                            {row.targetId ? ` · ${shorten(row.targetId)}` : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2.5 text-xs text-ink-muted">
                        <Metadata value={row.meta} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6">
              <Pagination
                page={auditPage}
                pageCount={auditPageCount}
                total={audit.total}
                noun="entry"
                hrefFor={(next) => {
                  const params = new URLSearchParams()
                  if (actionFilter) params.set('action', actionFilter)
                  if (next > 1) params.set('audit', String(next))
                  const suffix = params.toString()
                  return suffix ? `/admin/system?${suffix}` : '/admin/system'
                }}
              />
            </div>
          </>
        )}

        <p className="mt-6 text-xs leading-relaxed text-ink-subtle">
          Credentials are replaced with <span className="font-mono">[redacted]</span> before a row is
          written, and the actor is a user id rather than a name. A failed sign-in is recorded as{' '}
          <span className="font-mono">auth.login_failed</span> with a denied outcome; the address it
          came from is kept only as a keyed hash, which is what makes the row useful for spotting a
          pattern without the log itself holding an address.
        </p>
      </Section>

      <Section title="Where things live">
        <ul className="max-w-[46rem] space-y-2 text-xs leading-relaxed text-ink-muted">
          <li>
            <span className="text-ink">Markdown files</span> — the source of truth for every
            document, under <span className="font-mono">{env.CONTENT_DIR}</span>. Nothing in this
            admin writes one except the editor and a tag rewrite, and both go through the writer that
            locks and replaces the file atomically.
          </li>
          <li>
            <span className="text-ink">The database</span> — the index of those files plus everything
            that has no file: revisions, assets, tags, links, settings, navigation, redirects,
            analytics aggregates, jobs, sessions and this log.
          </li>
          <li>
            <span className="text-ink">Uploads</span> — files under{' '}
            <span className="font-mono">{env.UPLOAD_DIR}</span>, served from{' '}
            <span className="font-mono">{env.UPLOAD_URL_PREFIX}</span>. They are assets, not content:
            deleting one is refused while a document references it.
          </li>
          <li>
            <span className="text-ink">Search</span> — the{' '}
            <span className="font-mono">{provider}</span> provider indexes in process memory from the
            files rather than from a copy in Postgres, so there is no second copy to fall out of
            sync. A reindex job stamps the document shape version on rows written under an older one.
          </li>
        </ul>
        <p className="mt-4 text-xs text-ink-subtle">
          Revisions are stored per document; the count kept is a{' '}
          <Link href="/admin/settings" className="text-brand underline underline-offset-2">
            setting
          </Link>
          . Deleting a document deletes its revisions with it.
        </p>
      </Section>
    </Page>
  )
}

function EnvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-2">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate font-mono text-xs text-ink" title={value}>
        {value}
      </dd>
    </div>
  )
}

/**
 * The metadata blob, as one line.
 *
 * Rendered as text rather than as HTML: it is written by the application, but a
 * blob that originated in a request path is not something to put through
 * `dangerouslySetInnerHTML` for the sake of syntax colour.
 */
function Metadata({ value }: { value: Record<string, unknown> | null }) {
  if (!value || Object.keys(value).length === 0) return <span className="text-ink-subtle">—</span>

  return (
    <span className="font-mono break-all">
      {Object.entries(value)
        .map(([key, entry]) => `${key}=${describeValue(entry)}`)
        .join(' ')}
    </span>
  )
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? String(value)
}

/** Host and database name only. The password in the URL is never rendered. */
function databaseLabel(): string {
  try {
    const url = new URL(env.DATABASE_URL)
    const database = url.pathname.replace(/^\//, '')
    return `${url.hostname}${url.port ? `:${url.port}` : ''}/${database}`
  } catch {
    // An unparseable URL would have failed env validation; the honest answer if
    // it somehow happens is that it cannot be described, not a partial string.
    return 'not describable'
  }
}

function shorten(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(1))
  return `${rounded} ${units[unit]}`
}

function clampPage(value: string | undefined): number {
  const parsed = Number(value ?? 1)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.trunc(parsed))
}
