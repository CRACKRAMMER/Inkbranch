import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { signIn, uniqueSlug } from './support'

/**
 * A stored redirect is actually served.
 *
 * This is the test that was missing, and its absence was the whole problem: the
 * redirect table had a complete implementation, a CSV importer, an admin with
 * loop detection, and unit tests covering the resolver — and a row in it did
 * nothing at all when a request came in, because nothing on the request path
 * ever asked. Every piece passed its own tests.
 *
 * So this asserts the one thing none of those could: an author saves a rule in
 * the admin, and a request for that URL leaves the server pointing somewhere
 * else. It goes through the real proxy against a real production build, because
 * that is the only place the two halves meet.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a redirect saved in the admin is served to a request', async ({ page, request }) => {
  // Unique per run: the suite does not delete this one, and a fixed source path
  // would make the second run fail on a duplicate rather than on a defect.
  const from = `/e2e-moved-${uniqueSlug()}`
  const to = '/notes'

  await test.step('signs in', async () => {
    await signIn(page)
  })

  await test.step('saves the redirect', async () => {
    await page.goto('/admin/redirects')

    // Labelled rather than addressed by id: the form builds its ids from
    // `useId()`, so they are stable within a render and meaningless across one.
    await page.getByLabel('From').fill(from)
    await page.getByLabel('To').fill(to)
    await page.getByRole('button', { name: 'Add redirect' }).click()

    /*
     * Asserted against the table, and the table specifically.
     *
     * Saving is a server action followed by `router.refresh()`, so waiting for
     * the row to appear in the list is waiting for the write to have committed
     * and been read back — which is what every later step depends on.
     *
     * `page.getByText(from)` looks like it would do that and does not: the form
     * renders a live preview of what it is about to save — `{from} → {to}` —
     * as soon as the fields are filled. It is on screen before the button is
     * pressed, so the assertion passed instantly whether or not the save
     * happened, and the test then asked the server for a redirect that might
     * not exist yet. It failed about half the time, on whichever run lost that
     * race, which is the most expensive kind of test to own.
     *
     * The table is server state; the preview is not.
     */
    await expect(
      page
        .getByRole('table', { name: 'Stored redirects, most recently changed first' })
        .getByText(from),
    ).toBeVisible()
  })

  await test.step('answers the old URL with a permanent redirect', async () => {
    /*
     * Asked without following it, because the status code is the assertion.
     * `page.goto` would follow the redirect and report the *destination's* 200,
     * which a rule that redirected with a 302 — or with no redirect at all, if
     * the target happened to be reachable — would also produce.
     */
    const response = await request.get(from, { maxRedirects: 0 })

    expect(response.status()).toBe(301)
    expect(response.headers()['location']).toContain(to)
  })

  await test.step('takes a browser to the destination', async () => {
    await page.goto(from)
    await expect(page).toHaveURL(new RegExp(`${to}$`))
  })

  await test.step('is refused when it would lock the author out of the admin', async () => {
    // The admin is the only interface that can delete a redirect, so a rule on
    // it would be a rule nobody could undo from the product. The refusal is
    // asserted through the UI rather than as a unit test of the validator,
    // because the point is that the operator is told, in the form, before the
    // row is written.
    await page.goto('/admin/redirects')
    await page.getByLabel('From').fill('/admin/posts')
    await page.getByLabel('To').fill('/notes')
    await page.getByRole('button', { name: 'Add redirect' }).click()

    /*
     * Filtered by its text, not addressed as `getByRole('alert')`.
     *
     * Next renders a route announcer — `<div role="alert" id="__next-route-announcer__">` —
     * on every page, so the bare role matches two elements and strict mode
     * refuses to guess. Naming the message is also the stronger assertion: it
     * is the refusal being tested, not the presence of an alert box.
     */
    await expect(
      page.getByRole('alert').filter({ hasText: 'only place this row could be deleted from' }),
    ).toBeVisible()

    // And the admin still works, which is the thing the refusal exists to
    // protect.
    await page.goto('/admin/posts')
    await expect(page).toHaveURL(/\/admin\/posts$/)
  })
})
