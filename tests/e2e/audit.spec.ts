import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { signIn } from './support'

/**
 * An empty page of the audit log is not an empty log.
 *
 * `/admin/system` renders its audit table from `listAuditLogs`, which returns a
 * page of rows *and* a total for the whole filter. The page read only the rows:
 * whenever they came back empty it printed "Nothing has been recorded yet.
 * Signing in, saving a document, uploading an asset and changing a setting all
 * write a row here" — a sentence about the log, inferred from a fact about one
 * page of it.
 *
 * The two states are not the same thing and the operator is the one who has to
 * tell them apart. "Nothing has been recorded" is the answer to "is the audit
 * log working?"; a page number past the end is the answer to "am I looking at
 * the wrong page?". Saying the first when the second is true is the failure this
 * file exists to prevent, because it is the reassuring one: an operator who
 * reads it concludes the log is empty rather than that they mistyped a URL.
 *
 * The pagination moved with it. It used to be rendered inside the non-empty
 * branch, so the page that most needed a way back to page one was the page that
 * had none. It is keyed on the total now, like the redirects and assets tables.
 *
 * ## What is asserted here, and what is not
 *
 * That a page past the end says so, that the log renders normally once a page
 * that exists is asked for, and that an empty *page* is no longer described as
 * an empty *log*. The branch this suite can reach is the one with a short log,
 * where there are no page links to check — reaching the paginated case would
 * mean writing fifty rows to prove something about a link's href, when the
 * distinction being tested is between two sentences.
 *
 * The count line is asserted exactly, and that is how it came to light that the
 * component spelled it "12 entrys". It is the same reading of the same page —
 * the count is the other half of telling one empty page from an empty log, and
 * a count that is not a word is a sentence the reader has to decode.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a page past the end of the log says so instead of claiming the log is empty', async ({
  page,
}) => {
  await test.step('signs in, which is itself a row in the log', async () => {
    // The row this test depends on. `auth.login` is written by the sign-in the
    // step performs, so the total is at least one whatever else the run has
    // done, and the "past the end" branch is reachable without seeding anything.
    await signIn(page)
  })

  await test.step('asks for a page that does not exist', async () => {
    await page.goto('/admin/system?audit=999')

    await expect(page.getByText(/past the last page/)).toBeVisible()

    // The sentence this test is about. Asserted as absent rather than only
    // asserting the new one is present, because both could be rendered.
    await expect(page.getByText(/Nothing has been recorded yet/)).toHaveCount(0)

    // No rows, and no table to hold them.
    await expect(page.getByRole('table', { name: /Audit entries/ })).toHaveCount(0)

    // The count still reaches the page: the reader is told how many entries
    // exist, which is what makes the sentence above believable rather than a
    // different way of saying "empty".
    //
    // The word is spelled out in the pattern rather than matched loosely,
    // because this assertion is what found the count line reading "12 entrys":
    // `Pagination` built the plural by appending an `s`, which is the rule that
    // works for every noun it was given until this page gave it `entry`.
    await expect(page.getByText(/^\d+ entr(y|ies)$/).first()).toBeVisible()
  })

  await test.step('renders the log normally on a page that exists', async () => {
    await page.goto('/admin/system')

    const log = page.getByRole('table', { name: /Audit entries/ })
    await expect(log).toBeVisible()
    const region = page.getByRole('region', { name: 'Audit log', exact: true })
    await region.focus()
    await expect(region).toBeFocused()
    if (await region.evaluate(node => node.scrollWidth > node.clientWidth)) {
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    }
    // Written by the sign-in above, and the one action every run is certain to
    // have produced. `.first()`, because the log accumulates and this asserts
    // what is rendered, not how many: the row is written by every sign-in, and
    // the table is shared by every project in the run and every run before it —
    // enough sign-ins and the row legitimately appears twice on one page.
    await expect(log.getByText('auth.login', { exact: true }).first()).toBeVisible()
  })
})
