import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/components/content/page-header'
import { Container } from '@/components/site/container'
import { groupByYearAndMonth, type ArchiveYear } from '@/lib/content/archive'
import { listArchive, type ContentSummary } from '@/lib/content/queries'
import { buildPageMetadata, siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'
import { formatDate, toIsoDate } from '@/lib/utils/date'

/**
 * Everything, by year and then by month.
 *
 * The one page that is deliberately not paginated. Its whole purpose is to be
 * the complete record — a reader comes here to find the shape of the whole
 * body of work, and an archive that stops after twenty entries and asks you to
 * click for more is not an archive.
 *
 * Denser than any other list on the site: no descriptions, no tags, no reading
 * times. Once a reader has decided to scroll the whole thing, every extra
 * column per row doubles the length of the page and halves how much of it fits
 * on screen.
 *
 * Three levels, because two were not enough to navigate by. A year heading over
 * sixty undated rows tells a reader nothing about where they are in it; the
 * month is the level a person actually thinks in ("what was I writing in
 * September?"), and it costs one line of a size that does not compete with the
 * year. The day is left to each row, where it is already the only thing in the
 * left column.
 *
 * `groupByYearAndMonth` holds the rules — the site's time zone, where undated
 * documents go, and what happens to the order inside a group.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings()

  return buildPageMetadata({
    site: siteIdentityFromSettings(settings),
    title: 'Archive',
    description: 'Everything published here, newest first, as one list.',
    path: '/archive',
  })
}

export default async function ArchivePage() {
  const [settings, items] = await Promise.all([getSettings(), listArchive()])

  const dateContext = { locale: settings.locale, timeZone: settings.timezone }
  const years = groupByYearAndMonth(items, dateContext)
  const total = items.length

  return (
    <Container>
      <PageHeader
        title="Archive"
        description="Everything published here, newest first."
        meta={total > 0 ? `${total} ${total === 1 ? 'entry' : 'entries'}` : undefined}
      />

      {total === 0 ? (
        <p className="py-16 text-sm text-ink-subtle">Nothing has been published yet.</p>
      ) : (
        <div className="flex flex-col gap-10 pt-8">
          {years.map((year) => (
            <section key={year.year || 'undated'} aria-labelledby={`y-${year.year || 'u'}`}>
              <h2
                id={`y-${year.year || 'u'}`}
                className="border-b border-line pb-2 font-mono text-sm text-ink-subtle"
              >
                {year.year || 'Undated'}
                <span className="ml-3 text-xs">
                  {countOf(year)} {countOf(year) === 1 ? 'entry' : 'entries'}
                </span>
              </h2>

              {year.months.map((month) => (
                <div key={month.key || 'undated'} className="pt-4 last:pb-0">
                  {/*
                   * A month heading inside a year is a divider, not a title: it
                   * is set in the same muted mono as the year and deliberately
                   * one step smaller, so the eye lands on the year, then the
                   * dates, and only reads the month when it is looking for it.
                   * `aria-hidden` is not used — a screen reader navigating by
                   * heading should be able to jump to a month.
                   */}
                  <h3 className="mb-1 pl-[4.5rem] text-xs text-ink-subtle sm:pl-[5.5rem]">
                    {month.label || 'Undated'}
                  </h3>

                  <ul className="flex flex-col">
                    {month.items.map((item) => (
                      <li
                        key={`${item.type}:${item.slug}`}
                        className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-4 py-1.5 sm:grid-cols-[5.5rem_1fr]"
                      >
                        <time
                          dateTime={toIsoDate(item.publishedAt ?? item.updatedAt)}
                          className="text-right font-mono text-xs text-ink-subtle"
                        >
                          {formatDate(item.publishedAt ?? item.updatedAt, dateContext, 'day')}
                        </time>

                        <Link
                          href={item.url}
                          className="text-sm leading-snug text-ink-muted transition-colors duration-150 hover:text-brand"
                        >
                          {item.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </Container>
  )
}

/** Entries in a year, across its months. */
function countOf(year: ArchiveYear<ContentSummary>): number {
  return year.months.reduce((sum, month) => sum + month.items.length, 0)
}
