import { expect, type Page } from '@playwright/test'

import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './environment'

/**
 * Shared steps for the end-to-end suite.
 *
 * Small on purpose. Anything here has to be true of every caller, and a helper
 * that hides what it does makes a failing test harder to read than the
 * duplication it saves.
 */

/** Sign in as the seeded administrator, and prove it worked. */
export async function signIn(page: Page): Promise<void> {
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
