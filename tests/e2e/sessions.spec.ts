import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { E2E_BASE_URL, hasE2eDatabase } from './environment'
import { clearAdminSessions, signIn } from './support'

/**
 * The device list in settings, and the two ways it signs a device out.
 *
 * ## Why this file is here rather than in the integration suite
 *
 * `tests/integration/session-list.test.ts` holds the rules: which rows come
 * back, that a projection cannot carry a token, and that a session id belonging
 * to somebody else is refused. All of that is a function called directly.
 *
 * What only a browser can say is that the screen exists and that pressing the
 * button does what the button says — and that is the specific thing that was
 * missing. The reason this feature is worth a spec at all is that three
 * comments in the codebase described this screen while it did not exist, so a
 * test that only exercised the store functions would have passed the whole time
 * the promise was unkept.
 *
 * ## Why the second device is given a user agent
 *
 * The list tells rows apart by their label, and two Chromium contexts on one
 * machine send the same header — so the row for the other device would be
 * indistinguishable from the row for this one, and a test that picked rows by
 * position would pass whether or not the label meant anything. An iPhone's user
 * agent is a real header naming a real difference, and it makes the assertion
 * the one a person makes: *that* row is the phone, and it is the one to sign
 * out.
 *
 * The second context is deliberately not given the project's device settings —
 * see `signInSecondDevice`, which `password.spec.ts` shares the shape of.
 *
 * ## Why the account's last sign-in is asserted here
 *
 * `users.last_login_at` was the same defect one table over: written on every
 * successful sign-in, read by nothing, while the table above it showed per-device
 * activity. It is now a line under the table, and the two halves — a write in a
 * server action and a read in a render — meet only in a browser. The assertion
 * is about the relationship rather than the value, because the value is a clock.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

/** A real Safari-on-iOS header, so the row it produces is unmistakable. */
const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const PHONE_LABEL = 'Safari on iPhone'

/** The second device, so the hook can close it even after a failure. */
let phone: BrowserContext | undefined

test.beforeEach(async () => {
  // The suite shares one administrator across two projects that run one after
  // the other, so a session left behind by the desktop pass would be a second
  // row in the mobile pass's list. See `clearAdminSessions`.
  await clearAdminSessions()
})

test.afterEach(async () => {
  await phone?.close()
  phone = undefined
})

/** A second device signed in as the same administrator, sending the header above. */
async function signInPhone(browser: Browser): Promise<Page> {
  phone = await browser.newContext({ baseURL: E2E_BASE_URL, userAgent: IPHONE_USER_AGENT })
  const page = await phone.newPage()
  await signIn(page)
  return page
}

/** Press the confirm button of the dialog the last click opened. */
async function confirm(page: Page, label: string): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: label }).click()
}

test('lists the signed-in devices and signs one out without touching this one', async ({
  page,
  browser,
}) => {
  const other = await signInPhone(browser)
  await signIn(page)

  await test.step('both devices are on the list, and this one is marked', async () => {
    await page.goto('/admin/settings')

    const phoneRow = page.getByRole('row').filter({ hasText: PHONE_LABEL })
    await expect(phoneRow).toBeVisible()

    // Two rows, not one: the device reading the page is on it too. That is the
    // assertion the `ip_hash` column and `listUserSessions` were written for.
    await expect(page.getByRole('row').filter({ hasText: 'This device' })).toHaveCount(1)

    // And the row for this device offers no way to sign itself out — the header
    // button is that, and a second one inside a dialog would be a way to
    // sign out with a confirmation dialog in the way.
    await expect(
      page.getByRole('row').filter({ hasText: 'This device' }).getByRole('button', {
        name: 'Sign out',
      }),
    ).toHaveCount(0)
  })

  await test.step('the account line reports the sign-in that just happened', async () => {
    // `users.last_login_at` is written by the sign-in above and read by this
    // page, and this is the only layer where the two halves meet: the write is
    // inside a server action behind a form, and the read is a render.
    const line = page.locator('p', { hasText: 'This account was last signed in to' })
    const stamp = await line.locator('time').getAttribute('datetime')
    expect(stamp).not.toBeNull()

    // This device's own row is the session the sign-in created, so the account's
    // last sign-in can be neither older than it — which is what a column left
    // unwritten would look like — nor in the future, which is what a value
    // written from the browser's clock rather than the database's would be.
    const session = await page
      .getByRole('row')
      .filter({ hasText: 'This device' })
      .locator('time')
      .first()
      .getAttribute('datetime')

    const signedIn = new Date(stamp as string).getTime()
    expect(signedIn).toBeGreaterThanOrEqual(new Date(session as string).getTime())
    expect(signedIn).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  await test.step('signing the phone out ends exactly that session', async () => {
    const phoneRow = page.getByRole('row').filter({ hasText: PHONE_LABEL })
    await phoneRow.getByRole('button', { name: 'Sign out' }).click()
    await confirm(page, 'Sign out')

    // ## Why the dialog has to be gone before the row is asked about
    //
    // A modal Radix dialog marks everything outside it `aria-hidden`, and
    // `getByRole` reads the accessibility tree rather than the DOM — so while
    // the dialog is open, a row query answers zero for the whole page. Asking
    // whether the row is gone *during* the dialog is therefore a question that
    // passes against a list that still has it, and the test would walk on to
    // the phone before the action had committed.
    //
    // The dialog closes when the action resolves, so waiting for it is waiting
    // for the delete — and only then does the next line mean what it says.
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The row goes without a navigation, because the action refreshes the
    // route — so this is the list reading the database again, and it is the
    // second half of the claim: the session is gone, not merely marked.
    await expect(page.getByRole('row').filter({ hasText: PHONE_LABEL })).toHaveCount(0)
  })

  await test.step('the phone is signed out and this device is not', async () => {
    await other.goto('/admin/posts')
    await expect(other).toHaveURL(/\/admin\/login/)

    // The session that asked is still the session that asked. A revocation that
    // took the current device with it would be a page that signs you out for
    // pressing a button about somebody else.
    await page.goto('/admin/posts')
    await expect(page).toHaveURL(/\/admin\/posts/)
  })
})

test('signs out every other device at once, and keeps this one', async ({ page, browser }) => {
  const other = await signInPhone(browser)
  await signIn(page)
  await page.goto('/admin/settings')

  // The bulk button is the one whose wording — "sign out other devices" — is
  // what `destroyOtherSessions` had been documented as being for.
  await page.getByRole('button', { name: 'Sign out other devices' }).click()
  await expect(page.getByRole('dialog')).toContainText('1 other device')
  await confirm(page, 'Sign them out')

  await expect(page.getByText('Other devices signed out.')).toBeVisible()

  // The same gate as in the test above, and for the same reason: a modal
  // dialog takes the rest of the page out of the accessibility tree, so a
  // `getByRole` query behind one answers zero whatever the page holds.
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // With no other device left, the button that sweeps them has nothing to
  // sweep, and offering it anyway would be offering a no-op.
  await expect(page.getByRole('button', { name: 'Sign out other devices' })).toHaveCount(0)

  await other.goto('/admin/posts')
  await expect(other).toHaveURL(/\/admin\/login/)

  await page.goto('/admin/posts')
  await expect(page).toHaveURL(/\/admin\/posts/)
})
