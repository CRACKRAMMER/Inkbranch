import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { E2E_CONTENT_DIR, hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * A document the index has not seen, and one it has seen too little of.
 *
 * Both states are produced the way they happen in life — by writing Markdown
 * into the content tree from outside the admin — because that is the only way to
 * produce them: every write the admin makes goes through the index as well as
 * the file, so no screen in the product can leave the two disagreeing. The trick
 * the spec depends on is the environment: `CONTENT_SYNC_ON_BOOT=1` with
 * `WORKER_ENABLED=0` means the index is written at boot and by admin writes, and
 * by nothing else — so a file placed after boot stays unindexed for as long as
 * the test needs it to.
 *
 * What is under test is the half an author cannot see by reading the editor. The
 * site renders the index for everything the row holds and the file for the prose,
 * so a document with no row is one the site does not have at all, and a document
 * whose row was built from an earlier version is one whose title, description and
 * tags are behind its text. Both are the editor's business because both are
 * repaired the same way: open the document and save it, which writes the file and
 * re-indexes it.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

const POSTS = path.join(E2E_CONTENT_DIR, 'posts')

/** The files this spec wrote, so a test that fails partway still cleans up. */
const written = new Set<string>()

/**
 * Write a post into the content tree, exactly as a `git pull` would leave it.
 *
 * `status: published` on purpose. The point of the unindexed case is that a
 * document the site is meant to be serving is not being served — a draft would
 * be a 404 for the ordinary reason, and the test would prove nothing.
 */
function writePost(
  slug: string,
  fields: { title: string; description: string; body: string },
): string {
  fs.mkdirSync(POSTS, { recursive: true })
  const file = path.join(POSTS, `${slug}.md`)

  fs.writeFileSync(
    file,
    [
      '---',
      `title: ${fields.title}`,
      `slug: ${slug}`,
      `description: ${fields.description}`,
      'date: 2026-01-01',
      'status: published',
      '---',
      '',
      fields.body,
      '',
    ].join('\n'),
    'utf8',
  )

  written.add(file)
  return file
}

/**
 * Delete the document through the admin, which removes the file and the row.
 *
 * Local rather than in `support.ts`: the deletion is here for cleanup, and the
 * flow it drives is `authoring.spec.ts`'s subject, not this one's. A shared
 * helper would be a second copy of that test for every reader to reconcile.
 */
async function deleteThroughAdmin(page: Page, title: string): Promise<void> {
  await page.goto('/admin/posts')

  const row = page.getByRole('row', { name: title })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(row).toBeHidden()
}

test.afterEach(() => {
  // The admin delete removes the file too, so this is for the runs that never
  // reached it. A row left pointing at a file this removed is the drift the
  // index reports on the next run's dashboard — which is why the delete is the
  // job and this is the backstop.
  for (const file of written) fs.rmSync(file, { force: true })
  written.clear()
})

test('opens a file the index has never seen, and a save makes the site serve it', async ({
  page,
}) => {
  const slug = uniqueSlug()
  const title = `E2E Unindexed ${slug}`
  const file = writePost(slug, {
    title,
    description: 'Written straight into the content tree.',
    body: 'The paragraph that was already in the file.',
  })

  // The premise, from both places that would know: the site has no page for it,
  // and the admin reports the disagreement without naming the file.
  const before = await page.goto(`/posts/${slug}`)
  expect(before?.status()).toBe(404)

  await signIn(page)
  await expect(page.getByText('The content index and the files on disk disagree')).toBeVisible()

  await page.goto(`/admin/posts/${slug}/edit`)

  // The notice, and the state it names rather than the other one — the two are
  // one file apart on disk and the author is owed the right sentence.
  await expect(page.getByText('This file is not in the content index')).toBeVisible()
  await expect(page.getByText('built from an earlier version of this file')).toHaveCount(0)

  // Revisions attach to the index row, and there is no row: the link is not
  // offered, rather than offered and answered with a 404.
  await expect(page.getByRole('link', { name: 'Revisions' })).toHaveCount(0)

  // The buffer is the file's — there is no other state in existence.
  await expect(page.locator('.cm-content')).toContainText(
    'The paragraph that was already in the file.',
  )

  await typeBody(page, '\n\nA paragraph typed in the editor.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()

  // What the notice promised, both halves of it. The link is back because the
  // save built the row this document had none of...
  await expect(page.getByText('This file is not in the content index')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Revisions' })).toBeVisible()

  // ...and the site serves it, which is the half only the index could make
  // possible: the file was on disk and unreadable to a reader a moment ago.
  await page.goto(`/posts/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.locator('[data-article-body]')).toContainText(
    'A paragraph typed in the editor.',
  )

  await deleteThroughAdmin(page, title)
  fs.rmSync(file, { force: true })
  written.delete(file)
})

test('says the site is rendering the row while the file has moved on', async ({ page }) => {
  const slug = uniqueSlug()
  const title = `E2E Stale ${slug}`
  const changed = `${title} changed on disk`
  const file = writePost(slug, {
    title,
    description: 'The description the index read.',
    body: 'The state the index read.',
  })

  await signIn(page)

  // Let the index read the file, from the screen that owns the operation.
  await page.goto('/admin/system')
  await page.getByRole('button', { name: 'Reconcile now' }).click()
  await expect(page.getByText('Scanned', { exact: true })).toBeVisible()

  // In agreement, so there is nothing to say and nothing to hide. Asserted
  // because the notice below has to be a state the editor reaches, not the
  // state it is always in.
  await page.goto(`/admin/posts/${slug}/edit`)
  await expect(page.getByText('built from an earlier version of this file')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Revisions' })).toBeVisible()

  // Changed outside the admin, with the index left as it was.
  writePost(slug, {
    title: changed,
    description: 'The description written on disk.',
    body: 'A paragraph written outside the admin.',
  })

  await page.goto(`/admin/posts/${slug}/edit`)
  await expect(page.getByText('built from an earlier version of this file')).toBeVisible()

  // The buffer is the file — the newer of the two, and the one a save writes.
  // Both halves of it: the prose in the writing pane and the frontmatter in the
  // metadata pane, which on the touch project is a pane of its own.
  await expect(page.locator('.cm-content')).toContainText('A paragraph written outside the admin.')
  await showMetadata(page)
  await expect(page.locator('#fm-title')).toHaveValue(changed)

  // The claim the notice makes, checked where a reader can see it: the title
  // comes from the index and the prose from the file, so the page renders the
  // older title above the newer text. A notice that said the site was showing
  // the old *document* would be describing a bug that does not exist.
  await page.goto(`/posts/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.locator('[data-article-body]')).toContainText(
    'A paragraph written outside the admin.',
  )

  // And a save brings the two back together, which the title shows.
  await page.goto(`/admin/posts/${slug}/edit`)
  await typeBody(page, '\n\nA paragraph added in the editor.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
  await expect(page.getByText('built from an earlier version of this file')).toHaveCount(0)

  await page.goto(`/posts/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: changed })).toBeVisible()

  await deleteThroughAdmin(page, changed)
  fs.rmSync(file, { force: true })
  written.delete(file)
})
