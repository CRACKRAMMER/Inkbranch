import { expect, test, type Locator, type Page } from '@playwright/test'
import { Client } from 'pg'

import { e2eDatabaseUrl } from './environment'
import { signIn } from './support'

/**
 * The dashboard, read against the database it claims to describe.
 *
 * ## Why this is an end-to-end test
 *
 * Every figure on that page comes from a query of its own, and the page is the
 * only place where all of them meet. A unit test can prove that `contentCounts`
 * sums the rows it read; nothing but a browser can notice that the page renders
 * the wrong one of them, or that a section was never wired up — which is the
 * mistake a page assembled from twelve data sources actually invites. So the
 * assertions below are not about arithmetic. They are about the seam: the number
 * in the document against the number in the database, each read on its own.
 *
 * ## The tree this suite leaves behind, and what that means for the counts
 *
 * Every spec here creates the content it needs and removes it again — see
 * `states.spec.ts` for the argument — so between specs the index is empty and
 * the dashboard reports zeroes. A count compared with a query is therefore a
 * comparison of two zeroes, and it proves the wiring rather than the
 * arithmetic: those counts are summed by `contentCounts` and friends, which
 * `tests/unit` covers against seeded rows.
 *
 * The traffic figures get a fixture for exactly that reason. They are the part
 * of this page whose arithmetic is not covered elsewhere against *live* rows,
 * and a window boundary is the kind of claim that reads as correct until it is
 * compared with something: the rows below are dated so that each window's edge
 * falls between two of them.
 */

/**
 * The block under a heading.
 *
 * The page is a list of `<section>`s with real headings, so the heading is the
 * handle a reader would use and the one a test should: a word like "Storage"
 * could appear anywhere in the admin, and scoping to the block it belongs to is
 * what keeps these assertions from being about position.
 */
function section(page: Page, heading: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
}

/**
 * The value cell of the row labelled with a term.
 *
 * Found by walking up from the term rather than down from the list, because the
 * term is the `<dt>`'s own text in two of these lists and a link inside one in
 * the third — a locator that had to know which would be asserting about markup.
 * Every one of them is a `<dl>` whose entries are a `div` holding a term and its
 * value.
 */
function rowValue(container: Page | Locator, term: string): Locator {
  return container
    .getByText(term, { exact: true })
    .locator('xpath=ancestor::div[dt][1]')
    .locator('dd')
}

/**
 * The figure a stat leads with.
 *
 * The note under it is deliberately excluded: "Jobs open" carries one when jobs
 * have failed, and a count compared against a database should be the count and
 * not the count with a sentence after it.
 */
function statFigure(page: Page, term: string): Locator {
  return rowValue(page, term).locator('span').first()
}

interface ViewCounts {
  views: number
  visitors: number
}

/** The three windows, under the labels the page shows them with. */
const WINDOWS = {
  today: 'Today',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
} as const

/**
 * A day for the `analytics_daily.day` column, `offset` days from today.
 *
 * Written out here rather than imported from the application, and UTC because
 * that is the day boundary the aggregates are bucketed by. A test that computed
 * its expectations with the code under test's own helper could agree with it
 * about the wrong day, which is the one failure this fixture exists to catch.
 */
function dayOffset(offset: number): string {
  const now = new Date()
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset),
  )
  return day.toISOString().slice(0, 10)
}

/**
 * The two numbers in a traffic row, as the page renders them.
 *
 * Read out of the text rather than out of the markup, because the claim being
 * tested is about what a reader is told. The separators are matched loosely —
 * the row is a run of values and labels with no whitespace contract — and the
 * failure names the text it could not read, since a row that renders "—" is a
 * different bug from a row that renders nothing.
 */
async function trafficFigure(page: Page, window: string): Promise<ViewCounts> {
  const text = await rowValue(section(page, 'Traffic'), window).innerText()
  const match = /(\d+)[^\d]+views[^\d]+(\d+)[^\d]+visitors/.exec(text)

  if (!match) throw new Error(`No figures in the "${window}" row: ${JSON.stringify(text)}`)
  return { views: Number(match[1]), visitors: Number(match[2]) }
}

test('the dashboard reports the installation it is running against', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()

  const client = new Client({ connectionString: e2eDatabaseUrl() })
  await client.connect()

  /** One integer out of one statement, which is all the counts below need. */
  const count = async (sql: string): Promise<number> => {
    const result = await client.query<{ n: number }>(sql)
    return result.rows[0]?.n ?? -1
  }

  /*
   * Scoped to this run twice over: a path nothing else writes, under a prefix
   * this file owns. Cleanup is by path, so it cannot reach a row another spec
   * put in the same window — which is also what makes a rerun safe.
   */
  const fixturePath = `/__dashboard_test__/${Date.now().toString(36)}`

  try {
    await test.step('leads with counts the content index accounts for', async () => {
      /*
       * One at a time rather than in parallel: a `pg` client is one connection
       * and queues what it is handed, so `Promise.all` over it buys nothing but
       * a deprecation warning.
       */
      const documents = await count('select count(*)::int as n from content_index')
      const published = await count(
        "select count(*)::int as n from content_index where status = 'published'",
      )
      const drafts = await count(
        "select count(*)::int as n from content_index where status in ('draft','scheduled')",
      )
      const open = await count(
        "select count(*)::int as n from scheduled_jobs where status in ('pending','running')",
      )

      await expect(statFigure(page, 'Documents')).toHaveText(String(documents))
      await expect(statFigure(page, 'Published')).toHaveText(String(published))
      /*
       * Drafts and scheduled are one figure on the page and two statuses in the
       * table. Summed here rather than asserted one at a time because the claim
       * being checked is the page's: a document waiting to go out is neither
       * published nor nothing.
       */
      await expect(statFigure(page, 'Drafts & scheduled')).toHaveText(String(drafts))
      /*
       * Open, and not "in the list": this figure counts the whole queue, where
       * the section below it lists the most recent few. A job stuck in `pending`
       * since yesterday is older than fifty that finished since, which is the
       * row a count taken from that list would drop.
       */
      await expect(statFigure(page, 'Jobs open')).toHaveText(String(open))
    })

    await test.step('reads the content index, and says whether it is in step', async () => {
      const indexed = await count('select count(*)::int as n from content_index')
      const drift = rowValue(page, 'Content index')

      // Whichever way the check went, the figure it reports is the index's own:
      // this is the count the page compares against the files on disk, so a
      // number that disagreed with the table would mean it was comparing
      // something else.
      await expect(drift).toContainText(String(indexed))

      // The tree is indexed on boot and no spec leaves a file behind, so the
      // two agree. If that stops being true, this says which way it changed.
      await expect(drift).toContainText('in sync')
    })

    await test.step('reports the search index and the storage it was built with', async () => {
      const system = section(page, 'System')

      /*
       * `up to date` is a claim about every write path: each stamps the current
       * document version on the row it indexes, and this suite's tree was
       * written by those paths. A stale row here is a path that stopped
       * stamping, which is worth failing for.
       */
      await expect(rowValue(system, 'Search index')).toContainText('up to date')

      const files = await count('select count(*)::int as n from assets')
      const storage = rowValue(system, 'Storage')
      await expect(storage).toContainText(`${files} file`)
      // The directory uploads are written into exists in this environment, so
      // this check has an answer rather than a failure to report.
      await expect(storage).toContainText('writable')
    })

    await test.step('puts each day of traffic in the window that claims it', async () => {
      /*
       * Read before the fixture exists, so what follows is a comparison of
       * deltas. The alternative — absolute figures — would be a comparison
       * against whatever this database happens to hold, which for a rolling
       * window includes whatever a previous run of this file left behind.
       */
      const before = {
        today: await trafficFigure(page, 'Today'),
        last7: await trafficFigure(page, 'Last 7 days'),
        last30: await trafficFigure(page, 'Last 30 days'),
      }

      /*
       * One day per boundary, and the boundaries are the point: the oldest day
       * each window holds, and the first day past it. The values are powers of
       * two so that no subset of them sums to another subset's total — a window
       * that took in one day too many cannot land on the right answer by
       * coincidence.
       */
      const days: [day: string, views: number, visitors: number][] = [
        [dayOffset(0), 1, 3],
        [dayOffset(-1), 2, 4],
        [dayOffset(-6), 4, 6],
        [dayOffset(-7), 8, 16],
        [dayOffset(-29), 32, 64],
        // Past the end of the longest window: no figure on the page may move.
        [dayOffset(-30), 128, 256],
      ]

      await client.query('delete from analytics_daily where path = $1', [fixturePath])
      for (const [day, views, visitors] of days) {
        await client.query(
          `insert into analytics_daily (day, path, views, visitors)
           values ($1, $2, $3, $4)`,
          [day, fixturePath, views, visitors],
        )
      }

      await page.reload()

      const added = async (window: keyof typeof before): Promise<ViewCounts> => {
        const after = await trafficFigure(page, WINDOWS[window])
        return {
          views: after.views - before[window].views,
          visitors: after.visitors - before[window].visitors,
        }
      }

      // Today is today: yesterday is not in it, and the row is this one rather
      // than a sum that happens to fit.
      expect(await added('today')).toEqual({ views: 1, visitors: 3 })

      // Today, yesterday and the sixth day back — and not the seventh, which is
      // where the eight views are.
      expect(await added('last7')).toEqual({ views: 7, visitors: 13 })

      // The same three plus days seven and twenty-nine back. A window that
      // reached one day further would report 175 here, and the day that would
      // have carried it is the 128 in the fixture.
      expect(await added('last30')).toEqual({ views: 47, visitors: 93 })
    })
  } finally {
    await client.query('delete from analytics_daily where path = $1', [fixturePath])
    await client.end()
  }
})
