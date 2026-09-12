import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { E2E_ADMIN_PASSWORD, E2E_BASE_URL, hasE2eDatabase } from './environment'
import { clearAdminSessions, signIn, signInWith, trySignIn } from './support'

/**
 * Changing the password, and the revocation that is the point of it.
 *
 * ## What this file is for
 *
 * The site's only credential had no way to be rotated: the seed declines to
 * touch an existing account and tells the operator to use the admin, and the
 * admin had no such screen. Everything else about the feature — the form, the
 * audit row, the length bounds — is asserted in the integration suite, where a
 * function can be called directly. The two claims that only a browser can make
 * are here, and they are the two that matter to the person pressing the button:
 *
 * 1. **This device stays signed in.** The alternative is an owner locked out of
 *    their own site by a typo in a field they cannot read.
 * 2. **The other device does not.** This is what a password change is *for* —
 *    it is what someone does when they suspect a session they no longer
 *    control, and a form that quietly left that session alive would be worse
 *    than no form.
 *
 * The second claim needs a second device, so this is the one spec in the suite
 * that runs two browser contexts at once, and it is why `clearAdminSessions`
 * exists.
 *
 * ## Why the seeded password is rotated and put back
 *
 * There is one administrator and one database for the whole run, and the E2E run
 * signs in as that administrator — so a spec that rotates the password and
 * leaves it rotated takes every later spec with it, in both projects.
 *
 * `git.spec.ts` has the same problem with the settings row and solves it the
 * same way: an `afterEach` that puts the value back, because a failed step
 * aborts the rest of the test and the restore is exactly what has to survive the
 * failure. The difference here is that a password cannot be put back by clicking
 * a switch to its old position — the restore needs to know the current password
 * — which is what the `rotated` flag below is about.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

/** Long enough for the policy's minimum, and obviously not the seeded one. */
const ROTATED_PASSWORD = 'the-password-e2e-rotates-to'

/**
 * Whether the seeded password may have been rotated and not yet put back.
 *
 * ## Why it is set before the click rather than after the toast
 *
 * The server commits the change and then the browser is told about it, and the
 * gap between those two is one rendering. A failure inside that gap — an
 * assertion that throws, a page that navigates away — would leave the password
 * rotated while a flag set *after* the toast said otherwise, and the restore
 * would then go looking for a password that no longer opens anything. Set before
 * the click, the flag means "may have rotated", which is the honest thing to
 * know and the state the restore below is written to handle.
 *
 * Cleared at the end of the restore, so the next test in the file starts out
 * believing the seeded password works.
 */
let rotated = false

/** The second device, so the restore hook can close it even after a failure. */
let otherDevice: BrowserContext | undefined

test.beforeEach(async () => {
  // Before either device signs in, so that every session the password change
  // revokes is one this test created. See `clearAdminSessions`.
  await clearAdminSessions()
})

test.afterEach(async ({ page }) => {
  try {
    await otherDevice?.close()
    otherDevice = undefined

    if (rotated) await restoreSeededPassword(page)
  } finally {
    rotated = false
  }
})

/**
 * Put the seeded password back.
 *
 * ## Why the form is asked, and the session is not
 *
 * The flag says the password *may* have rotated, and there are only two things
 * it could be — so the restore attempts the change that assumes the rotated one
 * and reads the answer. A refusal is the answer that it was never rotated: the
 * current password is wrong, which with two candidates means the other one is
 * the password, and the site is already in the state this hook exists to leave
 * it in.
 *
 * The obvious shortcut is to read the session: a page that is still signed in
 * after the change has an authenticated cookie, so surely the password is the
 * rotated one. That inference is exactly backwards, and it was written here
 * first, where the injected-failure check caught it — **a session outlives a
 * password change on the device that made it**, which is the feature. So being
 * signed in says nothing at all, and the form's own refusal does.
 *
 * ## Why the refusal is not checked against its message
 *
 * The two ways this form can refuse are "wrong current password" and "that is
 * the password you already have", and with `ROTATED` as the current password and
 * `E2E_ADMIN_PASSWORD` as the new one the second is unreachable — the first
 * check fails before the second can be reached. A refusal here therefore can
 * only mean the current password is not the rotated one, and the hook can rely
 * on that without matching copy that is free to change.
 *
 * The `goto` at the top is not only for the failed path. It is also what makes
 * the wait at the bottom mean something: a full navigation discards every toast
 * on the page, so the one it waits for cannot be the test's own, still on screen
 * from a moment ago.
 */
async function restoreSeededPassword(page: Page): Promise<void> {
  await page.goto('/admin/settings')

  // Anonymous: a test that signed out deliberately leaves it there — the step
  // that proves the new password opens the door ends signed in with it — and a
  // test that failed early leaves it there too.
  if (!page.url().includes('/admin/settings')) {
    // Which password gets in is not used to decide anything; the change below
    // asks its own question and works either way. The order only matters for
    // speed, and the rotated one is what a passing run leaves live.
    const signedIn =
      (await trySignIn(page, ROTATED_PASSWORD)) || (await trySignIn(page, E2E_ADMIN_PASSWORD))

    if (!signedIn) {
      throw new Error(
        'Neither the rotated nor the seeded password signs in, so this run has left the ' +
          'administrator locked out of its own database. The password has to be reset by hand: ' +
          'scripts/db/seed.ts declines to touch an existing account.',
      )
    }

    await page.goto('/admin/settings')
  }

  await submitChange(page, ROTATED_PASSWORD, E2E_ADMIN_PASSWORD)

  // Either answer is an answer. The assertion is what waits; the branch below is
  // what reads it. A third outcome — neither a toast nor a field error, which is
  // what a hook racing a rate limit or a 500 would see — fails here, loudly,
  // rather than leaving a rotated password behind for the rest of the run.
  const refusal = page.locator('[data-slot="field-error"]')
  await expect(page.getByText('Password changed.').or(refusal)).toBeVisible()

  // Refused, so the flag was pessimistic and the seeded password is already the
  // current one.
  if (await refusal.isVisible()) return
}

/** Fill the three fields and submit, without claiming an outcome. */
async function submitChange(page: Page, current: string, next: string): Promise<void> {
  await page.fill('#current-password', current)
  await page.fill('#new-password', next)
  await page.fill('#confirm-password', next)
  await page.getByRole('button', { name: 'Change password' }).click()
}

/**
 * A second browser context, signed in as the same administrator.
 *
 * `baseURL` is passed explicitly because a context made here does not inherit
 * the project's `use` block, and a context with no `baseURL` fails every
 * relative `goto`. The project's device settings are deliberately *not* passed
 * on: what this context stands for is "another device the owner is signed in
 * on", and nothing asserted about it depends on its screen size — so the mobile
 * pass gets a plain desktop second device, which is a fair reading of the claim.
 */
async function signInSecondDevice(browser: Browser): Promise<Page> {
  otherDevice = await browser.newContext({ baseURL: E2E_BASE_URL })
  const page = await otherDevice.newPage()
  await signIn(page)
  return page
}

test('changes the password, keeps this device signed in, and signs out the other one', async ({
  page,
  browser,
}) => {
  let other: Page

  await test.step('two devices are signed in', async () => {
    await signIn(page)
    other = await signInSecondDevice(browser)
  })

  await test.step('a wrong current password changes nothing', async () => {
    await page.goto('/admin/settings')

    // The refusal is a field error rather than a whole-form one, so it is
    // asserted where the operator reads it: next to the box that was wrong.
    //
    // Selected by slot rather than by `role="alert"`, which the route announcer
    // in the document also matches — the hazard `auth.spec.ts` documents. Only a
    // field carrying a message renders one of these, so a single match is also
    // the assertion that exactly one field was refused.
    await submitChange(page, 'not-the-password-this-account-has', ROTATED_PASSWORD)
    await expect(page.locator('[data-slot="field-error"]')).toHaveText(
      'That is not the password this account currently has.',
    )
    await expect(page).toHaveURL(/\/admin\/settings/)

    // And the other device is untouched: a refused change is not a change.
    await other.goto('/admin/posts')
    await expect(other).toHaveURL(/\/admin\/posts/)
  })

  await test.step('the change goes through, and says what it revoked', async () => {
    // Before the click, never after it. See the `rotated` flag.
    rotated = true
    await submitChange(page, E2E_ADMIN_PASSWORD, ROTATED_PASSWORD)

    await expect(page.getByText('Password changed.')).toBeVisible()

    // The count is the claim, not a decoration: one other device was signed in,
    // and one is what the owner is told about. `clearAdminSessions` is what
    // makes the number this test's rather than the run's.
    await expect(page.getByText('1 other session signed out.')).toBeVisible()
  })

  await test.step('this device is still signed in', async () => {
    await page.goto('/admin/posts')
    await expect(page).toHaveURL(/\/admin\/posts/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  await test.step('the other device is signed out', async () => {
    await other.goto('/admin/posts')

    // The whole point of the feature. The session row is gone and the version
    // comparison would refuse it anyway; what a person sees is this.
    await expect(other).toHaveURL(/\/admin\/login/)
  })

  await test.step('the new password is the one that opens the door', async () => {
    // Signing out first, so the sign-in below is a real one rather than a
    // session that was already there.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/admin\/login/)
    await signInWith(page, ROTATED_PASSWORD)
  })
})

test('refuses to change a password to the value it already has', async ({ page }) => {
  // Worth a browser test of its own because of what the refusal protects: an
  // owner who believes an exposed password has been retired. A form that took
  // this would answer "Password changed." to a rotation that rotated nothing.
  await signIn(page)
  await page.goto('/admin/settings')

  // `rotated` is deliberately not set here: nothing in this test asks the
  // database to change a credential, and the restore hook's first job is to
  // work out whether that is true.
  await submitChange(page, E2E_ADMIN_PASSWORD, E2E_ADMIN_PASSWORD)

  await expect(page.locator('[data-slot="field-error"]')).toHaveText(
    'That is the password this account already has, so nothing was changed.',
  )

  // The session is untouched, which is the browser's version of "nothing was
  // written": a refusal that revoked the sessions it was asked not to touch
  // would be a strange way to say no.
  await page.goto('/admin/posts')
  await expect(page).toHaveURL(/\/admin\/posts/)
})
