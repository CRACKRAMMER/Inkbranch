import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { signIn } from './support'

/**
 * The states a page can be in that are not its content.
 *
 * A site is judged on these more than on its happy path, and they are the part
 * that no page's own test would cover: the loading state belongs to the route
 * rather than to the page, and the 404 belongs to a URL that no test otherwise
 * visits. Both are also places where the failure is silent — a loading state
 * that no longer renders is a slower page, not a broken one, and a 404 answered
 * by the framework instead of by the site is a dead end with no way back.
 *
 * No fixtures. The first two steps need no sign-in — these are the states a
 * visitor with a stale bookmark meets — and the last signs in, because the
 * admin's 404 is only shown to someone who could act on it. Both answers to an
 * admin URL that resolves to nothing are asserted: a reader's dead end and an
 * operator's next move are different pages, and a test that knew about only one
 * of them would report the other as a failure.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a slow page says it is loading, and a missing one says what to do', async ({
  page,
  request,
}) => {
  await test.step('carries a skeleton, and no spinner, for the search route', async () => {
    /*
     * Asserted against the response body rather than against a browser, and the
     * reason is worth stating because the obvious test does not work.
     *
     * Whether the skeleton is *rendered* is down to how long the search takes.
     * The server flushes the page shell when the render suspends on the query,
     * so on a fast query — and on a machine where the database is on the same
     * disk — the whole page can arrive in one piece with no fallback ever
     * emitted, which is the intended behaviour rather than a defect, and it
     * makes an assertion on the rendered skeleton a coin flip. (Delaying the
     * response with `page.route` does not produce one either: the client router
     * holds the old page until the payload lands, so the fallback is never
     * mounted.)
     *
     * What is stable is that the route *has* a loading state: it travels with
     * the page, in the payload the client reads when a navigation does have to
     * wait. That is what this asserts — the loading UI exists, and it is a
     * skeleton rather than a spinner. It does not assert that a reader will see
     * it, because on a fast day no reader will.
     */
    const response = await request.get('/search?q=anything')
    const html = await response.text()

    expect(response.status()).toBe(200)
    expect(html).toContain('Searching…')

    // The brief's other half: a skeleton rather than a spinner. A spinner is
    // what a site shows when it has nothing to promise about the shape of what
    // is coming.
    expect(html).not.toContain('animate-spin')
  })

  await test.step('answers a missing document with its own 404', async () => {
    const response = await page.goto('/posts/no-such-document-at-all')

    expect(response?.status()).toBe(404)
    // This site's 404, not the framework's. Next's default is a bare line of
    // text with no navigation, and a reader who lands on it from a stale link
    // is left guessing whether the site is broken.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This page does not exist.',
    )
    await expect(page.getByRole('link', { name: 'Search the site' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
  })

  /*
   * The admin's answer to a URL that resolves to nothing, which is not the
   * public one and is not the same for both askers.
   *
   * Both halves are asserted because the naive expectation is one of them and
   * the truth is the other: an admin URL that matches no document is a 404 for
   * the person who can act on it and a sign-in page for the person who cannot.
   * The root `not-found.tsx` is not what answers here — the admin brings its own,
   * because the sentence a reader needs ("this page does not exist") is usually
   * false about an admin URL, where the real cause is a document that has left
   * the index while still being on disk.
   */
  const missingAdminUrl = '/admin/no-such-section'

  await test.step('sends an anonymous visitor to sign in, holding the address', async () => {
    const response = await page.goto(missingAdminUrl)

    // 200 because the browser followed the redirect; the address it lands on is
    // the assertion. `next` is what makes this a detour rather than a dead end
    // — arriving at a sign-in form with no memory of where you were going is
    // indistinguishable from a broken link.
    expect(response?.status()).toBe(200)
    await expect(page).toHaveURL(/\/admin\/login\?next=/)
    expect(decodeURIComponent(page.url())).toContain(missingAdminUrl)
  })

  await test.step('shows a signed-in operator the admin’s own 404', async () => {
    await signIn(page)
    const response = await page.goto(missingAdminUrl)

    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found')

    // Inside the shell rather than instead of it: the sidebar is there, and the
    // page offers the one move that actually fixes this — a sync, which
    // reconciles the index with the files and never writes to a document.
    await expect(page.getByRole('link', { name: 'Check the index for drift' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'All posts' })).toBeVisible()
  })
})
