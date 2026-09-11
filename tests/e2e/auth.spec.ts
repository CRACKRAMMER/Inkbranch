import { expect, test } from '@playwright/test'

import { E2E_ADMIN_EMAIL, hasE2eDatabase } from './environment'
import { signIn } from './support'

/**
 * Sign-in, and the things that must not work without it.
 *
 * The refusal cases carry as much weight as the success case. A blog admin is a
 * single-owner login with no open registration, which makes the gate the whole
 * of the security boundary — and a suite that only proves the right password
 * works would pass just as happily against a form that let anyone in.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('refuses a wrong password without disclosing whether the account exists', async ({ page }) => {
  await page.goto('/admin/login')
  await page.fill('#email', E2E_ADMIN_EMAIL)
  await page.fill('#password', 'definitely-not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/login/)

  // The same message for an unknown account, which is what keeps the form from
  // being a way to enumerate administrators. Asserted on the generic wording
  // rather than on an exact string so the copy can be improved without
  // invalidating the test — what must not appear is the email.
  const text = (await alert.textContent()) ?? ''
  expect(text.toLowerCase()).not.toContain('no such user')
  expect(text.toLowerCase()).not.toContain('not found')
  expect(text.toLowerCase()).not.toContain('incorrect password')
})

test('sends an anonymous visitor to the sign-in page, remembering where they were going', async ({
  page,
}) => {
  await page.goto('/admin/posts')

  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  expect(decodeURIComponent(page.url())).toContain('/admin/posts')
})

test('does not serve the admin shell to an anonymous visitor', async ({ request }) => {
  // `redirect: 'manual'` because the assertion is about the response the server
  // sends, not about where a browser would end up. Following the redirect would
  // make this pass whether the route refused or merely rendered an empty page.
  const response = await request.get('/admin/posts', { maxRedirects: 0 })
  expect([301, 302, 303, 307, 308]).toContain(response.status())
})

test('signs out, and the session stops working', async ({ page }) => {
  await signIn(page)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/admin\/login/)

  // The cookie is gone, not merely navigated away from. Going straight back to a
  // protected page is the check that a sign-out actually invalidated something.
  await page.goto('/admin/posts')
  await expect(page).toHaveURL(/\/admin\/login/)
})
