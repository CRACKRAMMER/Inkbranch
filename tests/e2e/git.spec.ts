import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

import { E2E_CONTENT_DIR, hasE2eDatabase, hasGit } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * Content auto-commit, end to end, against a real repository.
 *
 * The feature is a save that also commits the file it wrote. Two switches have
 * to agree: `gitEnabled` and `gitAutoCommit` in the settings, and
 * `GIT_INTEGRATION_ENABLED` in the deployment's environment — which
 * `environment.ts` sets to `1` for this suite, and which `global-setup.ts`
 * backs with a repository that has no commits in it. Nothing here ever pushes.
 *
 * ## Why this spec reads a repository
 *
 * Every other file in this suite asserts only on what a reader or an author can
 * see, and the rule is a good one. This file departs from it in one place, for a
 * reason that does not generalise: the deliverable of this feature *is* a
 * repository state, and that state has no page. The product's only claim about
 * it is one phrase in the editor's status line — "committed 1a2b3c4" — so a
 * suite that checked the phrase and stopped would pass against a status line
 * that lies. Lying is the failure mode this feature is built against; it is the
 * reason `commitContentChange` answers a site that asked for commits with either
 * a commit or a reason, and never with silence. So the phrase is checked against
 * `git log` and `git rev-parse`: the same interface an operator would use.
 *
 * ## Why the settings are turned off in an `afterEach`
 *
 * There is one settings row for the whole site and one database for the whole
 * run, so a switch this file leaves on is a switch every later file runs with —
 * and by then the tree it writes to is a repository. The turn-off cannot be the
 * last step of the test: a failed step aborts the rest of it, and the restore is
 * exactly what has to survive a failure. An `afterEach` runs either way.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test.skip(!hasGit, 'git is not installed, so the content tree is not a repository.')

/** Commit subjects, newest first. Empty in a repository that has no commits. */
function subjects(): string[] {
  try {
    return execFileSync('git', ['log', '--pretty=%s'], {
      cwd: E2E_CONTENT_DIR,
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter((line) => line !== '')
  } catch {
    // `git log` exits non-zero when there is nothing to log, and an empty list is
    // the truthful answer to "what has been committed" in that repository.
    return []
  }
}

/** The repository-relative paths git is tracking. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: E2E_CONTENT_DIR, stdio: 'pipe' })
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line !== '')
}

/** The sha the repository is on, which is what the status line promises. */
function shortHead(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: E2E_CONTENT_DIR,
    stdio: 'pipe',
  })
    .toString()
    .trim()
}

/**
 * The editor's status line.
 *
 * Filtered to the one that is reporting a file rather than the draft revision
 * beside it: `role="status"` is also what a toast announces itself with, and the
 * two are different claims — one of them has a commit behind it.
 */
function statusLine(page: Page) {
  return page.getByRole('status').filter({ hasText: 'Saved to file' })
}

test.afterEach(async ({ page }) => {
  // The test's own page, so its session is reused: a page of its own would sign
  // in a second time for no reason.
  //
  // A test that failed between typing and saving leaves the editor holding
  // unsaved changes, and its guard asks `beforeunload` before letting anything
  // navigate out of it. Playwright dismisses dialogs unless it is told
  // otherwise, and a dismissed `beforeunload` **cancels** the navigation — which
  // would leave the settings on for the rest of the run, the one thing this hook
  // exists to prevent. Accepting is the answer that guard is asking for.
  page.on('dialog', (dialog) => void dialog.accept())

  await page.goto('/admin/settings')

  // A test that failed before signing in leaves the session anonymous, and the
  // guard turns that request into the login page. Only reachable when the run is
  // already failing, so the extra sign-in is not on the healthy path.
  if (!page.url().includes('/admin/settings')) {
    await signIn(page)
    await page.goto('/admin/settings')
  }

  // Idempotent on purpose: a test that failed before it turned anything on finds
  // two switches already off, clicks nothing, and finds the save button disabled
  // because nothing is dirty.
  for (const id of ['#setting-gitEnabled', '#setting-gitAutoCommit']) {
    const control = page.locator(id)
    if ((await control.getAttribute('aria-checked')) === 'true') await control.click()
  }

  const save = page.getByRole('button', { name: 'Save changes' })
  if (await save.isEnabled()) {
    await save.click()
    // The switch position is client state until the server has taken it, and the
    // next file's saves are what this is protecting.
    await expect(page.getByText(/All changes saved at/)).toBeVisible()
  }
})

test('a save commits the content directory, and the editor says which commit', async ({ page }) => {
  const slug = uniqueSlug()
  const title = `E2E Git Post ${slug}`

  // The two projects of a run share one content tree, and this file is the only
  // one that commits to it — so the mobile pass starts with whatever the desktop
  // pass left behind. Counting from here is what lets the assertions below be
  // about *these* saves rather than about the repository's whole history.
  const baseline = subjects().length

  await test.step('turns auto-commit on', async () => {
    await signIn(page)
    await page.goto('/admin/settings')

    // By id rather than by role and name: the switch is a `<button
    // role="switch">` whose label is attached with `htmlFor`, and the id is the
    // app's own handle on it.
    await page.locator('#setting-gitEnabled').click()
    await page.locator('#setting-gitAutoCommit').click()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(/All changes saved at/)).toBeVisible()

    // Reloaded, because the point of this step is that the *server* has the
    // settings. A switch position a client remembers says nothing about what the
    // next save will do.
    await page.reload()
    await expect(page.locator('#setting-gitEnabled')).toBeChecked()
    await expect(page.locator('#setting-gitAutoCommit')).toBeChecked()
  })

  await test.step('publishes a post, and the save is committed', async () => {
    await page.goto('/admin/posts/new')
    await page.fill('#title', title)
    await page.fill('#slug', slug)
    await page.selectOption('#status', 'draft')
    await page.getByRole('button', { name: 'Create and edit' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))

    await typeBody(page, 'The end-to-end suite writes this so there is something to commit.\n')
    await showMetadata(page)
    await page.selectOption('#fm-status', 'published')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(statusLine(page)).toContainText('Saved to file at')

    const note = statusLine(page).locator('span').filter({ hasText: /^committed / })
    await expect(note).toBeVisible()

    // The sha in the phrase is checked against the repository rather than
    // believed: `rev-parse` is asked separately, and a commit is the only thing
    // that can produce it.
    expect((await note.innerText()).trim()).toBe(`committed ${shortHead()}`)
  })

  await test.step('has one commit per save, and nothing else', async () => {
    // The whole of this test's history, not a subset of it. Creating the
    // document was one decision and publishing it was another, so two commits
    // were added — and a third entry would mean a save that committed twice, or
    // something committing that should not be.
    const log = subjects()
    expect(log.slice(0, 2)).toEqual([
      `content: publish "${title}"`,
      `content: create "${title}"`,
    ])
    expect(log).toHaveLength(baseline + 2)
    expect(tracked()).toContain(`posts/${slug}.md`)
  })

  await test.step('deletes it, and the deletion is committed', async () => {
    await page.goto('/admin/posts')
    const row = page.getByRole('row', { name: new RegExp(title) })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()

    // The toast, and not the row disappearing. That row is *not* a signal that
    // the delete has happened: while the confirmation is open the dialog marks
    // everything outside itself `aria-hidden`, `getByRole` cannot see an
    // aria-hidden row, and a locator that matches nothing is hidden — so
    // `toBeHidden()` passes while the dialog is still on screen and the server
    // action has not been sent. The toast is emitted after `await action(…)`
    // returns, and the action returns after the commit.
    await expect(page.getByText('Document deleted')).toBeVisible()

    // Polled rather than read once, because the thing being asserted is in
    // another process's view of the filesystem. The order above is the
    // guarantee; this is what tolerates the observation being a moment late.
    await expect.poll(() => subjects()[0]).toBe(`content: delete "${title}"`)
    expect(tracked()).not.toContain(`posts/${slug}.md`)
    expect(subjects()).toHaveLength(baseline + 3)
  })
})
