import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { signIn } from './support'

/**
 * The queue says which worker last held a job.
 *
 * `scheduled_jobs.locked_by` had three decisions written about it and no reader.
 * The worker writes it on every claim; `failJob` clears it when a job goes back
 * to the queue and deliberately leaves it alone when a job fails, with the
 * comment "which worker last ran it is the only provenance a failed row has";
 * the column is sized and the writer truncates to that size. Nothing rendered it
 * anywhere, so the provenance was in the database and nowhere a person looks.
 * The column is now the last thing before the error in the queue table below,
 * which is the one screen where an operator asks what happened to a job.
 *
 * The empty case is the one this suite can produce. No worker process runs
 * during a Playwright run — the queue is drained by `pnpm worker`, which is a
 * different process from the one under test — so a job queued from the admin
 * stays `pending` with nobody's name on it, and the column has to say so rather
 * than show a blank. A row with a worker on it is what the same expression
 * renders when the value is there; the claim that produces it is asserted where
 * the claim happens, in `tests/unit/jobs.test.ts`.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a job nobody has claimed says so, in a column of its own', async ({ page }) => {
  await test.step('signs in', async () => {
    await signIn(page)
  })

  await test.step('queues a sync', async () => {
    await page.goto('/admin/system')
    await page.getByRole('button', { name: 'Queue a sync' }).click()

    /*
     * A queued job is a write the page then reads back: the action enqueues,
     * revalidates and the table re-renders from `listJobs`. Waiting for the row
     * is waiting for both halves, which is what the next step asserts on.
     *
     * Filtered by `pending` as well as by the kind, because the dedupe key is
     * fixed per kind — pressing the button twice collapses to one pending row,
     * but a `done` one left by an earlier pass would match the kind alone and
     * make the filter match two rows, which strict mode refuses.
     */
    await expect(
      page
        .getByRole('table', { name: 'Most recent jobs, newest first' })
        .getByRole('row')
        .filter({ hasText: 'content.sync' })
        .filter({ hasText: 'pending' }),
    ).toBeVisible()
  })

  await test.step('shows the column, empty, for a job no worker has taken', async () => {
    const table = page.getByRole('table', { name: 'Most recent jobs, newest first' })

    /*
     * The column is found by its heading rather than by position, so that
     * inserting one before it does not silently turn this into an assertion
     * about a different cell. The row's first column is its `<th scope="row">`,
     * so the `td` under heading *n* is `td` number *n − 1*.
     */
    const headings = await table.getByRole('columnheader').allInnerTexts()
    const worker = headings.indexOf('Worker')
    expect(worker, `no Worker column among ${JSON.stringify(headings)}`).toBeGreaterThanOrEqual(0)

    const row = table
      .getByRole('row')
      .filter({ hasText: 'content.sync' })
      .filter({ hasText: 'pending' })

    await expect(row.locator('td').nth(worker - 1)).toHaveText('—')
  })
})
