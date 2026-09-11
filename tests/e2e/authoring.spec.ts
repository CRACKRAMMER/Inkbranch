import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The authoring lifecycle, end to end, against a real server.
 *
 * One test with named steps rather than a serial `describe` with one test per
 * stage. The stages genuinely depend on each other — there is nothing to publish
 * until something has been written, and nothing to delete until something has
 * been published — so splitting them would produce a report where a failure in
 * the first stage is followed by four skipped tests that say nothing. `test.step`
 * keeps the per-stage reporting and the single browser session that the workflow
 * actually has.
 *
 * Every stage is asserted on what a reader or an author would see. The test
 * never reads the database or the filesystem: the question it answers is whether
 * the product works, and a suite that inspects the index directly can pass while
 * the page a reader loads is broken.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('an author writes, publishes, finds and deletes a post', async ({ page }) => {
  const slug = uniqueSlug()
  const title = `E2E Test Post ${slug}`
  // A word that appears only in this post, so the search assertion cannot pass
  // because of something else in the index.
  const marker = `zebrafish${slug.replace(/-/g, '')}`

  await test.step('signs in', async () => {
    await signIn(page)
  })

  await test.step('creates a draft', async () => {
    await page.goto('/admin/posts/new')
    await page.fill('#title', title)
    await page.fill('#slug', slug)
    await page.selectOption('#status', 'draft')
    await page.getByRole('button', { name: 'Create and edit' }).click()

    // Creating the document is a navigation to its editor. Landing anywhere else
    // means the file was not written.
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))
    await expect(page.locator('#fm-slug')).toHaveValue(slug)
  })

  await test.step('refuses to serve the draft', async () => {
    // The point of a draft. Asked before publishing so that the published check
    // below cannot pass just because the route serves anything it is given.
    const response = await page.goto(`/posts/${slug}`)
    expect(response?.status()).toBe(404)
  })

  await test.step('writes and publishes', async () => {
    await page.goto(`/admin/posts/${slug}/edit`)
    await typeBody(
      page,
      [
        `This paragraph exists to give the post a body worth rendering, and it contains the word ${marker}.`,
        '',
        '## A heading',
        '',
        '- a list item',
        '- another one',
        '',
        '```ts',
        'const answer: number = 42',
        '```',
      ].join('\n'),
    )

    await showMetadata(page)
    await page.selectOption('#fm-status', 'published')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // The status line reports the file, not just the draft, because autosave and
    // a real save are different things and the author needs to know which one
    // happened. Waiting on it is waiting for the write to have landed.
    await expect(page.getByText(/Saved to file/)).toBeVisible()
  })

  await test.step('renders the published post', async () => {
    await page.goto(`/posts/${slug}`)

    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()

    // Scoped to the rendered body. The page also carries a description derived
    // from the first paragraph, so an unscoped text match finds the marker twice
    // and fails on strict mode — which is the assertion being right for the
    // wrong reason rather than the page being wrong.
    const body = page.locator('[data-article-body]')
    await expect(body).toContainText(marker)
    // Markdown is rendered, not displayed: the heading and the list item become
    // real elements, and the fence becomes a Shiki-highlighted block.
    await expect(body.getByRole('heading', { level: 2, name: 'A heading' })).toBeVisible()
    await expect(body.locator('li', { hasText: 'another one' })).toBeVisible()
    await expect(body.locator('pre code')).toContainText('const answer')
  })

  await test.step('finds it in search', async () => {
    await page.goto(`/search?q=${encodeURIComponent(marker)}`)

    // Matched on the title, which only this post has. Asserting the marker is on
    // the page would also pass from the query being echoed back into the input.
    await expect(page.getByRole('link', { name: new RegExp(slug) })).toBeVisible()
  })

  await test.step('deletes it', async () => {
    await page.goto('/admin/posts')

    const row = page.getByRole('row', { name: new RegExp(title) })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Delete' }).click()

    // The confirmation is not decoration — the dialog says the revision history
    // goes with it — so the test goes through it rather than around it.
    await page.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(row).toBeHidden()
  })

  await test.step('stops serving the deleted post', async () => {
    const response = await page.goto(`/posts/${slug}`)
    expect(response?.status()).toBe(404)
  })
})
