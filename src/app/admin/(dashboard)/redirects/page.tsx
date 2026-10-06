import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth/session'
import { listRedirects } from '@/lib/redirects'
import { formatDate } from '@/lib/utils/date'
import { getSettings } from '@/lib/settings'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { Pagination } from '@/components/admin/pagination'
import {
  DeleteRedirectButton,
  EditRedirectDialog,
  RedirectForm,
  RedirectImport,
} from '@/components/admin/redirect-controls'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'Redirects' }

const PER_PAGE = 50

/**
 * Moved URLs.
 *
 * Hit counts are deliberately absent. `resolveRedirect` runs on the miss path of
 * every request and takes a read, not a write, because incrementing a counter
 * there would put every 404 in the site in contention on one row's lock — so the
 * `hits` column exists and is always zero, and a page that rendered it would be
 * inventing a metric.
 */
export default async function RedirectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  await requireUser()

  const [query, settings] = await Promise.all([searchParams, getSettings()])
  const search = query.q?.trim() || undefined
  const page = clampPage(query.page)

  const { rows, total } = await listRedirects({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
    ...(search ? { search } : {}),
  })

  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE))
  const disabled = rows.filter((row) => !row.enabled).length

  return (
    <Page
      title="Redirects"
      description="Checked when a request would otherwise 404. Nothing here is stored in a file, and no hit counts are kept."
    >
      <StatRow>
        <StatCell>
          <Stat label="Rules" value={total} note={search ? 'matching the filter' : undefined} />
        </StatCell>
        <StatCell>
          <Stat label="Disabled here" value={disabled} note="Not consulted while off" />
        </StatCell>
        <StatCell>
          <Stat label="On this page" value={rows.length} />
        </StatCell>
        <StatCell>
          <Stat label="Status codes" value="301 · 302 · 307 · 308" />
        </StatCell>
      </StatRow>

      <Section
        title="Add a redirect"
        description="A source path that is already stored is updated rather than duplicated."
      >
        <RedirectForm />
      </Section>

      <Section
        title="Import a CSV"
        description="For a migration with more than a handful of moved URLs."
      >
        <RedirectImport />
      </Section>

      <Section
        title="Rules"
        description="Most recently changed first."
        actions={
          <form method="get" className="flex items-center gap-2">
            <label className="sr-only" htmlFor="redirect-search">
              Filter redirects
            </label>
            <input
              id="redirect-search"
              name="q"
              defaultValue={query.q ?? ''}
              placeholder="Filter by path"
              className="h-8 w-48 rounded-md border border-input bg-transparent px-2 text-sm"
            />
            <button
              type="submit"
              className="h-8 rounded-md border border-line-strong px-2.5 text-xs text-ink hover:bg-sunken"
            >
              Filter
            </button>
          </form>
        }
      >
        {rows.length === 0 ? (
          <InlineNote>
            {search
              ? 'No redirect matches that filter.'
              : 'No redirects yet. A moved post usually wants one: the old URL 404s until a rule points it somewhere.'}
          </InlineNote>
        ) : (
          <div className="relative overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Stored redirects, most recently changed first</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    From
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    To
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
                    Changed
                  </th>
                  <th scope="col" className="py-2 text-right font-medium text-ink-muted">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line align-top last:border-0">
                    <th scope="row" className="py-3 pr-3 text-left font-normal">
                      <span className="font-mono text-xs text-ink">{row.fromPath}</span>
                      {!row.enabled ? (
                        <span className="mt-1 block">
                          <Badge variant="outline">disabled</Badge>
                        </span>
                      ) : null}
                      {row.note ? (
                        <span className="mt-1 block text-xs text-ink-muted">{row.note}</span>
                      ) : null}
                    </th>
                    <td className="py-3 pr-3">
                      {row.toPath.startsWith('http') ? (
                        <a
                          href={row.toPath}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all font-mono text-xs text-brand underline underline-offset-2"
                        >
                          {row.toPath}
                        </a>
                      ) : (
                        <span className="break-all font-mono text-xs text-ink">{row.toPath}</span>
                      )}
                    </td>
                    <td className="py-3 pr-3 tabular-nums text-ink-muted">{row.statusCode}</td>
                    <td className="py-3 pr-3 text-ink-muted">
                      {formatDate(row.updatedAt, context, 'short')}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap items-start justify-end gap-1">
                        <EditRedirectDialog
                          redirect={{
                            id: row.id,
                            fromPath: row.fromPath,
                            toPath: row.toPath,
                            statusCode: row.statusCode,
                            enabled: row.enabled,
                            note: row.note ?? '',
                          }}
                        />
                        <DeleteRedirectButton id={row.id} fromPath={row.fromPath} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 ? (
          <div className="mt-6">
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              noun="redirect"
              hrefFor={(next) => {
                const params = new URLSearchParams()
                if (search) params.set('q', search)
                if (next > 1) params.set('page', String(next))
                const suffix = params.toString()
                return suffix ? `/admin/redirects?${suffix}` : '/admin/redirects'
              }}
            />
          </div>
        ) : null}

        <p className="mt-6 text-xs leading-relaxed text-ink-subtle">
          A rule whose source is this site path but whose target is another site sends the reader
          away with a redirect rather than a page.{' '}
          <Link href="/admin/system" className="text-brand underline underline-offset-2">
            System
          </Link>{' '}
          shows whether the last sync recorded any broken links worth a rule.
        </p>
      </Section>
    </Page>
  )
}

function clampPage(value: string | undefined): number {
  const parsed = Number(value ?? 1)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.trunc(parsed))
}
