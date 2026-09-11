import { expect, type Page } from '@playwright/test'
import { Client } from 'pg'

import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, e2eDatabaseUrl } from './environment'

/**
 * Shared steps for the end-to-end suite.
 *
 * Small on purpose. Anything here has to be true of every caller, and a helper
 * that hides what it does makes a failing test harder to read than the
 * duplication it saves.
 */

/**
 * Empty the sign-in rate-limit buckets before signing in.
 *
 * ## Why the suite is allowed to do this
 *
 * The limiter is deliberately tight — five attempts per address per fifteen
 * minutes plus ten per account per hour — because its job is to bound password
 * guessing. This suite is not guessing. It signs in once or twice per test, over
 * a couple of minutes, from one address, so a run spends the account's whole
 * allowance and then the eleventh sign-in is refused: the run ends with one or
 * two tests failing on "Too many sign-in attempts", a message that has nothing
 * to do with what they were testing.
 *
 * That is not hypothetical. This suite sat *exactly* on the ten-attempt ceiling
 * for as long as it had five specs — the tenth sign-in of a run consumed the
 * last token and left the bucket at zero — and adding the sixth is what surfaced
 * it. A suite whose green depends on being one test below a security control is
 * worth less than the control: the buckets get cleared here, where the
 * heaviness is, and the limiter keeps its production shape, which is the part
 * that matters. The thing given up is E2E coverage of the limiter, and the
 * limiter has no test coverage today either way.
 *
 * Only `login:*` buckets, because the account one is the one that accumulates:
 * a successful sign-in resets the address bucket and never the account's, which
 * is the whole point of an account-level lockout.
 *
 * A connection per call rather than a shared one: this runs a handful of times
 * in a run, and a client outliving the test that made it is a `globalTeardown`
 * problem this file does not need to have.
 */
async function clearLoginLimits(): Promise<void> {
  const client = new Client({ connectionString: e2eDatabaseUrl() })
  await client.connect()
  try {
    await client.query("delete from rate_limits where key like 'login:%'")
  } finally {
    await client.end()
  }
}

/**
 * A slug no previous run can have used.
 *
 * The suite deletes what it creates, but a run that fails partway does not —
 * and a fixed slug would then collide on the next attempt, turning one failure
 * into a permanent one. The content tree is recreated per run, so this is belt
 * and braces; it costs nothing and removes a class of confusing re-run.
 */
export function uniqueSlug(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Sign in as the seeded administrator, and prove it worked. */
export async function signIn(page: Page): Promise<void> {
  // Before the form, so the attempt this helper is about to make cannot be the
  // one that finds the bucket empty.
  await clearLoginLimits()

  await page.goto('/admin/login')
  await page.fill('#email', E2E_ADMIN_EMAIL)
  await page.fill('#password', E2E_ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // The form posts to a server action and lands on the dashboard. Waiting for
  // the URL rather than for a selector means a failed sign-in is reported here,
  // as a sign-in failure, instead of as whatever the next assertion trips over.
  await expect(page).toHaveURL(/\/admin(\?|$)/)
}

/**
 * Put a Markdown body into the editor's source.
 *
 * `insertText` rather than `type`, and the difference is not cosmetic.
 * `keyboard.type` sends one keystroke per character, which turns each newline
 * into an Enter press — and Enter is a *keybinding* in a Markdown editor, not a
 * character. That has two consequences, both of which were observed rather than
 * predicted: the editor's list continuation inserts a second `- ` after every
 * list item, so the body acquires formatting the test never asked for; and on
 * the mobile project the newlines were not delivered as key events at all, so
 * the entire document arrived as a single line and the heading it was supposed
 * to contain did not exist.
 *
 * `insertText` delivers the string as a single input event, which is what
 * pasting does and what CodeMirror is built to receive. The author's text is
 * then exactly the text, and what the test asserts on is the Markdown pipeline
 * rather than the editor's keymap.
 *
 * `.cm-content` rather than a label-based selector: CodeMirror owns the DOM
 * inside its scroller, and the accessible name of the editable region is
 * derived from the document title, which changes as the document is edited.
 */
export async function typeBody(page: Page, markdown: string): Promise<void> {
  const source = page.locator('.cm-content')
  await source.click()
  await page.keyboard.insertText(markdown)
}

/**
 * Bring the metadata fields into view if the viewport hides them.
 *
 * Below the editor's breakpoint the three panes are shown one at a time behind
 * a switcher, and the metadata fields — slug, status, tags — are on a pane of
 * their own. On a wide viewport that switcher is not rendered and the metadata
 * is a permanent left column, so there is nothing to click.
 *
 * Checking for the switcher's visibility rather than for the viewport width is
 * the difference between testing the layout and testing a media query: if the
 * breakpoint moves, the visible control is still the one that gets clicked.
 */
export async function showMetadata(page: Page): Promise<void> {
  const switcher = page.getByRole('group', { name: 'Editor pane' })
  if (await switcher.isVisible()) {
    await switcher.getByRole('button', { name: 'Metadata' }).click()
  }
}
