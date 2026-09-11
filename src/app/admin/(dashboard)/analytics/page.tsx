import type { Metadata } from 'next'
import Link from 'next/link'

import {
  analyticsEnabled,
  getAnalyticsSummary,
  getTopContent,
  rangeSchema,
  type TopContentEntry,
} from '@/lib/analytics'
import { requireUser } from '@/lib/auth/session'
import { segmentForType } from '@/lib/admin/routes'
import type { DeviceType } from '@/lib/db/schema'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { StatusBadge } from '@/components/admin/status-badge'
import { TrafficChart, type TrafficPoint } from '@/components/admin/traffic-chart'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'Analytics' }

/** Days of history the preset links cover. */
const PRESETS = [7, 30, 90]
const DEFAULT_DAYS = 30
const TOP_LIMIT = 10

const DEVICE_LABELS: Record<DeviceType, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  tablet: 'Tablet',
  bot: 'Bot',
  other: 'Other',
}

/**
 * What the site recorded, and nothing it did not.
 *
 * Every number on this page is a roll-up of `analytics_daily`: a day, a path, a
 * referrer host, a device class and a country column, summed. There is no
 * address and no user agent anywhere behind it — `collect.ts` never reads a
 * header that carries one — so there is nothing here to redact and no "IP" field
 * to show. What is deliberately missing is as much the subject of this page as
 * what is present: referrers lose their query strings, the visitor cookie dies
 * at midnight, and no per-reader record exists to drill into. A reader who wants
 * a session view of their traffic wants a different tool than this one.
 *
 * `visitors` is the one number here that needs a caveat every time it is shown:
 * it is the sum of per-dimension uniques, so a reader who came twice by two
 * paths counts twice. It is an upper bound, and it is labelled as one.
 *
 * The range is read from the URL and validated by the module's own schema, so a
 * hand-edited URL is answered with a message rather than a chart that quietly
 * covers a different period than its heading claims.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  await requireUser()

  const query = await searchParams
  const today = utcToday()
  const fallback = { from: shiftDay(today, -(DEFAULT_DAYS - 1)), to: today }
  const requested = { from: query.from ?? fallback.from, to: query.to ?? fallback.to }
  const parsed = rangeSchema.safeParse(requested)
  const range = parsed.success ? parsed.data : fallback
  const enabled = analyticsEnabled()

  const [summary, topContent] = await Promise.all([
    getAnalyticsSummary(range),
    getTopContent({ ...range, limit: TOP_LIMIT }),
  ])

  const points: TrafficPoint[] = summary.series.map((entry) => ({
    day: entry.day,
    views: entry.views,
    visitors: entry.visitors,
  }))

  let busiest: TrafficPoint | null = null
  for (const entry of summary.series) {
    if (entry.views > 0 && (busiest === null || entry.views > busiest.views)) busiest = entry
  }
  const quietDays = summary.series.filter((entry) => entry.views === 0).length
  const unresolved = topContent.filter((entry) => entry.kind === 'unresolved')

  return (
    <Page
      title="Analytics"
      description="Aggregate, cookieless page views. No address, no user agent, no identity that survives the day."
      actions={<RangeForm from={range.from} to={range.to} today={today} />}
    >
      {!parsed.success ? (
        <InlineNote tone="warning">
          That range could not be read ({parsed.error.issues[0]?.message ?? 'invalid'}), so the last{' '}
          {DEFAULT_DAYS} days are shown instead.
        </InlineNote>
      ) : null}

      {!enabled ? (
        <InlineNote tone="warning">
          Collection is off: <span className="font-mono text-xs">ANALYTICS_ENABLED</span> is 0, so the
          beacon drops new page views and these figures stop moving. History is still stored and still
          readable, which is why this page works at all with collection switched off.
        </InlineNote>
      ) : null}

      <StatRow>
        <StatCell>
          <Stat label="Views" value={summary.totals.views} note={`${range.from} → ${range.to}`} />
        </StatCell>
        <StatCell>
          <Stat
            label="Visitors"
            value={summary.totals.visitors}
            note="Upper bound — see the note below"
          />
        </StatCell>
        <StatCell>
          <Stat
            label="Busiest day"
            value={busiest ? busiest.views : '—'}
            note={busiest ? busiest.day : 'No views in this range'}
          />
        </StatCell>
        <StatCell>
          <Stat
            label="Quiet days"
            value={quietDays}
            note={quietDays === summary.series.length ? 'The whole range is quiet' : 'Days with no views'}
          />
        </StatCell>
      </StatRow>

      <Section
        title="Traffic"
        description="One point per UTC day, including the days nothing happened."
        actions={
          <div className="flex items-center gap-1">
            {PRESETS.map((days) => {
              const preset = { from: shiftDay(today, -(days - 1)), to: today }
              const current = preset.from === range.from && preset.to === range.to
              return (
                <Link
                  key={days}
                  href={`/admin/analytics?from=${preset.from}&to=${preset.to}`}
                  aria-current={current ? 'page' : undefined}
                  className={
                    current
                      ? 'border border-line-strong bg-sunken px-2 py-1 text-xs text-ink'
                      : 'border border-transparent px-2 py-1 text-xs text-ink-muted hover:border-line hover:text-ink'
                  }
                >
                  {days} days
                </Link>
              )
            })}
          </div>
        }
      >
        <TrafficChart series={points} />
        <p className="mt-3 max-w-[46rem] text-xs leading-relaxed text-ink-subtle">
          Days are UTC. The visitor line is the sum of each day&rsquo;s per-dimension uniques — a path, a
          referrer host, a device — so one reader who arrives twice by two routes is counted twice, and
          the total is at most what it says and at least the busiest single day. The exact number of
          people cannot be recovered from per-dimension counts, and a smaller figure that could not be
          defended would be worse than this one.
        </p>
      </Section>

      <Section
        title="Most viewed"
        description="By path, over the range. A path whose document no longer exists is kept rather than dropped."
      >
        {topContent.length === 0 ? (
          <InlineNote>Nothing was viewed in this range.</InlineNote>
        ) : (
          <ul className="border-t border-line">
            {topContent.map((entry) => (
              <TopContentRow key={`${entry.kind}-${entry.path}`} entry={entry} />
            ))}
          </ul>
        )}
        {unresolved.length > 0 ? (
          <p className="mt-4 max-w-[46rem] text-xs leading-relaxed text-ink-subtle">
            {unresolved.length === 1 ? 'One path' : `${unresolved.length} paths`} in this list match no
            document. That is either a link on another site pointing at a URL that moved — write a
            redirect and it will stop being a 404 — or a crawler working through a stale sitemap.
          </p>
        ) : null}
      </Section>

      <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
        <Section
          title="Referrers"
          description="External hosts only, and only the host: the path and query of a referrer are discarded before anything is stored."
        >
          {summary.topReferrers.length === 0 ? (
            <InlineNote>No external referrers in this range. Direct visits have no referrer and cannot appear here.</InlineNote>
          ) : (
            <CountList
              rows={summary.topReferrers.map((row) => ({ key: row.domain, label: row.domain, ...row }))}
            />
          )}
        </Section>

        <Section
          title="Devices"
          description="A coarse class derived from the user agent, which is then dropped. The agent string itself is not stored."
        >
          {summary.devices.length === 0 ? (
            <InlineNote>No devices recorded in this range.</InlineNote>
          ) : (
            <CountList
              rows={summary.devices.map((row) => ({
                key: row.device,
                label: DEVICE_LABELS[row.device],
                ...row,
              }))}
            />
          )}
        </Section>
      </div>

      <Section title="What this page cannot tell you">
        <ul className="max-w-[46rem] space-y-2 text-xs leading-relaxed text-ink-muted">
          <li>
            <span className="text-ink">Where a reader went next.</span> A view is recorded for a path on
            a day; nothing links two views by the same reader, so there are no sessions, funnels or
            paths through the site.
          </li>
          <li>
            <span className="text-ink">How long anyone stayed.</span> The beacon does report a duration
            and the raw event table keeps it for its retention window, but nothing rolls it up: the
            daily aggregate this page reads has no duration column, so there is no average here to
            show. Reading it would mean a second query over the raw events, which is a feature, not a
            number to invent from what is already fetched.
          </li>
          <li>
            <span className="text-ink">Anything about a person.</span> No address, no user agent, no
            cross-day identifier. There is no per-reader row to open and no filter that could produce
            one.
          </li>
          <li>
            <span className="text-ink">What a reader searched for.</span> Referrers keep the host and
            drop the query, which is usually the search terms themselves.
          </li>
        </ul>
      </Section>
    </Page>
  )
}

/**
 * The range as a form rather than a script.
 *
 * Two date inputs and a submit: the browser supplies the calendar, the value is
 * already `YYYY-MM-DD`, and the whole thing works without client JavaScript. The
 * page reads the same parameters the form writes, so a range from a bookmark, a
 * preset or the form is one code path.
 */
function RangeForm({ from, to, today }: { from: string; to: string; today: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        From
        <input
          type="date"
          name="from"
          defaultValue={from}
          max={today}
          className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        To
        <input
          type="date"
          name="to"
          defaultValue={to}
          max={today}
          className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-ink"
        />
      </label>
      <button
        type="submit"
        className="h-8 rounded-md border border-line-strong px-3 text-xs text-ink hover:bg-sunken"
      >
        Show
      </button>
    </form>
  )
}

function TopContentRow({ entry }: { entry: TopContentEntry }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-3">
      <div className="min-w-0">
        {entry.kind === 'content' ? (
          <>
            <Link
              href={`/admin/${segmentForType(entry.type)}/${entry.slug}/edit`}
              className="text-sm text-ink underline-offset-2 hover:underline"
            >
              {entry.title}
            </Link>
            <span className="ml-2 align-middle">
              <StatusBadge status={entry.status} />
            </span>
            <span className="mt-1 block break-all font-mono text-xs text-ink-subtle">
              {entry.path}
            </span>
          </>
        ) : (
          <>
            <span className="break-all font-mono text-sm text-ink">{entry.path}</span>
            <span className="ml-2 align-middle">
              <Badge variant="outline">no document</Badge>
            </span>
            <span className="mt-1 block text-xs text-ink-subtle">
              404s — this URL is not served by anything.
            </span>
          </>
        )}
      </div>
      <div className="flex items-baseline gap-4 text-xs">
        <span className="tabular-nums text-ink">
          {entry.views} <span className="text-ink-subtle">views</span>
        </span>
        <span className="tabular-nums text-ink-muted">
          {entry.visitors} <span className="text-ink-subtle">visitors</span>
        </span>
      </div>
    </li>
  )
}

function CountList({
  rows,
}: {
  rows: { key: string; label: string; views: number; visitors: number }[]
}) {
  const max = rows.reduce((peak, row) => Math.max(peak, row.views), 0)

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4">
          <div className="min-w-0">
            <span className="block truncate font-mono text-xs text-ink" title={row.label}>
              {row.label}
            </span>
            <span
              aria-hidden="true"
              className="mt-1 block h-[3px] bg-chart-views"
              style={{ width: `${max > 0 ? Math.max((row.views / max) * 100, 1) : 0}%` }}
            />
          </div>
          <span className="tabular-nums text-xs text-ink-muted">
            {row.views} <span className="text-ink-subtle">views</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The UTC day an instant falls in. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * `day` shifted by whole days.
 *
 * Deliberately local and deliberately tiny. `@/lib/analytics` exports the query
 * surface and keeps its day arithmetic internal, and this is the only place in
 * the admin that needs a default range — it produces `YYYY-MM-DD` values that
 * `rangeSchema` then validates, so the module remains the authority on what a
 * range may be.
 */
function shiftDay(day: string, days: number): string {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return new Date(start + days * 86_400_000).toISOString().slice(0, 10)
}
