import { describe, expect, it } from 'vitest'

import { groupByYearAndMonth, UNDATED } from '@/lib/content/archive'

/**
 * The archive's grouping.
 *
 * Four rules, all of which a reader would notice only as "the archive looks
 * wrong" and none of which the page's own render can pin: which month a
 * document near a boundary falls in, where an undated document goes, that the
 * order inside a group survives, and that an empty month is not a heading.
 *
 * The time zone is the whole reason this is a function and not four lines in
 * the page, so the boundary case below is the one that matters most.
 */

const SHANGHAI = { locale: 'en', timeZone: 'Asia/Shanghai' }
const NEW_YORK = { locale: 'en', timeZone: 'America/New_York' }

const entry = (title: string, publishedAt: Date | null) => ({ title, publishedAt })

describe('groupByYearAndMonth', () => {
  it('groups years and months, newest first', () => {
    const years = groupByYearAndMonth(
      [
        entry('September post', new Date('2026-09-11T00:00:00Z')),
        entry('August post', new Date('2026-08-21T00:00:00Z')),
        entry('Last year', new Date('2025-12-01T00:00:00Z')),
      ],
      SHANGHAI,
    )

    expect(years.map((year) => year.year)).toEqual(['2026', '2025'])
    expect(years[0]?.months.map((month) => month.key)).toEqual(['09', '08'])
    expect(years[0]?.months.map((month) => month.label)).toEqual(['September', 'August'])
  })

  it('files a document by the site’s time zone and not by UTC', () => {
    // 17:00Z on the 31st of August is one in the morning on the 1st of September
    // in Shanghai — the author published it in September and it is filed under
    // September. `getUTCMonth()` says August, and so does this assertion's
    // failure message if the conversion is ever undone.
    const years = groupByYearAndMonth([entry('Just after midnight', new Date('2026-08-31T17:00:00Z'))], SHANGHAI)

    expect(years[0]?.months[0]?.key).toBe('09')
    expect(years[0]?.months[0]?.label).toBe('September')
  })

  it('files it by UTC when UTC is the site’s zone — the other direction', () => {
    // The mirror image, and the reason the function takes a context instead of
    // hardcoding one: 02:00Z on the 1st of September is ten at night on the
    // 31st of August in New York. A site in New York files it under August.
    const years = groupByYearAndMonth([entry('Evening', new Date('2026-09-01T02:00:00Z'))], NEW_YORK)

    expect(years[0]?.months[0]?.key).toBe('08')
    expect(years[0]?.months[0]?.label).toBe('August')
  })

  it('puts documents with no publication date in one trailing group', () => {
    const years = groupByYearAndMonth(
      [
        entry('Dated', new Date('2026-09-11T00:00:00Z')),
        entry('Undated', null),
      ],
      SHANGHAI,
    )

    expect(years.at(-1)?.year).toBe(UNDATED)
    expect(years.at(-1)?.months).toHaveLength(1)
    expect(years.at(-1)?.months[0]?.items.map((item) => item.title)).toEqual(['Undated'])
    // The undated group has no date to take a month name from.
    expect(years.at(-1)?.months[0]?.label).toBe('')
  })

  it('keeps the order it was given inside a group', () => {
    // Regrouping is not re-ranking. The query returns newest first and nothing
    // here is allowed to have a second opinion.
    const years = groupByYearAndMonth(
      [
        entry('Second', new Date('2026-09-02T00:00:00Z')),
        entry('First', new Date('2026-09-01T00:00:00Z')),
        entry('Third', new Date('2026-09-03T00:00:00Z')),
      ],
      SHANGHAI,
    )

    expect(years[0]?.months[0]?.items.map((item) => item.title)).toEqual([
      'Second',
      'First',
      'Third',
    ])
  })

  it('does not emit a month nothing landed in', () => {
    const years = groupByYearAndMonth(
      [
        entry('September', new Date('2026-09-11T00:00:00Z')),
        entry('June', new Date('2026-06-01T00:00:00Z')),
      ],
      SHANGHAI,
    )

    expect(years[0]?.months.map((month) => month.key)).toEqual(['09', '06'])
  })

  it('returns nothing for an empty list', () => {
    expect(groupByYearAndMonth([], SHANGHAI)).toEqual([])
  })
})
