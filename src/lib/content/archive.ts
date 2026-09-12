import { formatDate, monthIn, yearIn, type DateFormatContext } from '@/lib/utils/date'

/**
 * The archive's two levels of grouping.
 *
 * ## Why this is a module and not a few lines in the page
 *
 * The archive is the one page whose whole reason to exist is that it is the
 * complete record, and the grouping is what makes a thousand entries legible
 * rather than a wall. Three rules in it are easy to get subtly wrong and
 * impossible to notice: which group an entry on the last day of a month belongs
 * to, what happens to a document with no date, and whether the ordering inside
 * a group survives the regrouping. Written inline they could only be checked by
 * loading the page and reading a long list; here they are a pure function with
 * a test.
 *
 * ## The rules
 *
 * **The site's time zone decides the year and the month, never UTC.** A post
 * published at 23:30 in Shanghai is dated the 11th by its author, and a
 * document is filed under the month its author wrote down. `getUTCMonth()`
 * would move everything published late in the evening on the last day of a
 * month into the next one.
 *
 * **Undated documents are a real group, placed last.** A note can legitimately
 * have no date. Dropping them would make the archive quietly incomplete, which
 * is the one thing an archive must not be.
 *
 * **Regrouping is not re-ordering.** The list arrives newest first and each
 * group keeps that order. A document is never moved within its month because
 * the query happened to return it somewhere else.
 *
 * **An empty group is not returned.** A month with nothing in it is not a
 * heading; the archive of a site that paused for a year should not be a ladder
 * of empty months.
 */

/** The undated group's key. `''` sorts and compares as a year nothing produces. */
export const UNDATED = ''

export interface ArchiveMonth<T> {
  /** The month's name in the site's locale — `September`. */
  label: string
  /** The two-digit month, for a stable React key. */
  key: string
  items: T[]
}

export interface ArchiveYear<T> {
  /** Four-digit year, or `UNDATED` for the trailing group. */
  year: string
  months: ArchiveMonth<T>[]
}

/**
 * Group a newest-first list into years, and each year into months.
 *
 * `context` is the site's locale and time zone, and it is required rather than
 * defaulted: a caller that does not know them cannot group an archive, and
 * defaulting to UTC would silently produce the wrong answer for every site not
 * in it.
 *
 * Generic over the row, like `groupHits`: the rule uses one field of it, and
 * taking the whole `ContentSummary` would make every future field of a content
 * summary a compile error here in a function that never reads it.
 *
 * ## What "undated" means
 *
 * A null `publishedAt` — not a missing *effective* date, and not a null
 * `updatedAt` used as a stand-in. The archive is a record of publication, and
 * `listArchive` orders by `published_at DESC NULLS LAST`: filing an undated
 * note under the month it was last touched would lift it out of the trailing
 * group the query deliberately put it in and drop it into the middle of the
 * page, so the grouping and the ordering would be telling two different
 * stories. A published note is allowed to have no date; it is not allowed to
 * be quietly given one.
 */
export function groupByYearAndMonth<T extends { publishedAt: Date | null }>(
  items: readonly T[],
  context: DateFormatContext,
): ArchiveYear<T>[] {
  const years = new Map<string, Map<string, T[]>>()

  for (const item of items) {
    const date = item.publishedAt
    const year = date ? yearIn(date, context.timeZone) : UNDATED
    const month = date ? monthIn(date, context.timeZone) : UNDATED

    const months = years.get(year) ?? new Map<string, T[]>()
    if (!years.has(year)) years.set(year, months)

    const bucket = months.get(month)
    if (bucket) bucket.push(item)
    else months.set(month, [item])
  }

  return [...years.entries()]
    .sort(([a], [b]) => orderYears(a, b))
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort(([a], [b]) => orderMonths(a, b))
        .map(([key, monthItems]) => ({
          key,
          // The label is read off a date that is genuinely in this month, in the
          // same time zone the grouping used, so the heading and the entries
          // under it cannot disagree. The undated group has no such date and
          // takes its label from the page.
          label: monthItems[0]?.publishedAt
            ? formatDate(monthItems[0].publishedAt, context, 'month')
            : '',
          items: monthItems,
        })),
    }))
}

/** Descending, with the undated group last whichever way the comparison runs. */
function orderYears(a: string, b: string): number {
  if (a === UNDATED) return b === UNDATED ? 0 : 1
  if (b === UNDATED) return -1
  return b.localeCompare(a)
}

/** Descending within a year; the undated bucket only exists in the undated year. */
function orderMonths(a: string, b: string): number {
  if (a === UNDATED) return b === UNDATED ? 0 : 1
  if (b === UNDATED) return -1
  return b.localeCompare(a)
}
