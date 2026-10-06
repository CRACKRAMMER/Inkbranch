import { expect, test, type Page } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * Merging a tag, and the number the operator is asked to decide on.
 *
 * `tests/unit/tag-impact.test.ts` proves what each sentence says and
 * `tests/integration/tags.test.ts` proves the count matches the files; neither
 * can show that the dialog is wired to either. What is only visible from here is
 * that opening the dialog asks the server, that the sentence on screen is the
 * one the operator acts on, and that pressing the button underneath it rewrites
 * exactly the documents it named — the whole point of stating a number before a
 * destructive multi-file edit.
 *
 * ## Why the assertion is the exact number
 *
 * The corpus this spec publishes is the whole corpus — every spec that
 * publishes also deletes, so the next one starts from an empty content tree —
 * which is what lets the figures be exact. It matters more than usual here: the
 * dialog's sentence names a union of two tags, and the number it must *not* say
 * is the sum of the two counts on the page behind it. "At least two documents"
 * would pass on the wrong arithmetic.
 *
 * ## Why the publish helper is local
 *
 * `graph.spec.ts` has one of its own, and `support.ts` explains why: a shared
 * helper has to be true of every caller, and the two specs publish different
 * documents — this one sets two tags, that one sets one and links forward. What
 * they share is the flow, and the flow is four lines.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

/** Create and publish one document, through the editor an author uses. */
async function publish(
  page: Page,
  document: { slug: string; title: string; body: string; tags: string },
): Promise<void> {
  await page.goto('/admin/posts/new')
  await page.fill('#title', document.title)
  await page.fill('#slug', document.slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${document.slug}/edit`))

  await typeBody(page, document.body)
  await showMetadata(page)
  await page.fill('#fm-tags', document.tags)
  await page.selectOption('#fm-status', 'published')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
}

test('merges a tag after stating how many documents it will touch', async ({ page }) => {
  const run = uniqueSlug()
  const source = { name: `E2E Source ${run}`, slug: `e2e-source-${run}` }
  const target = { name: `E2E Target ${run}`, slug: `e2e-target-${run}` }
  const carriesBoth = { slug: `${run}-both`, title: `E2E Both ${run}` }
  const sourceOnly = { slug: `${run}-source-only`, title: `E2E Source Only ${run}` }

  await test.step('publishes one document carrying both tags, and one carrying only the source', async () => {
    await signIn(page)

    await publish(page, {
      ...carriesBoth,
      body: 'Carries the source and the destination, so the merge takes a tag away.',
      tags: `${source.name}, ${target.name}`,
    })
    await publish(page, {
      ...sourceOnly,
      body: 'Carries the source alone, so the merge replaces its tag.',
      tags: source.name,
    })
  })

  await test.step('states the union of the two tags, and how many already carry both', async () => {
    await page.goto('/admin/tags')
    await expect(page.getByRole('table')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.goto(`/admin/tags/${source.slug}`)
    for (const label of ['Rename', 'Delete', 'Merge']) {
      const trigger = page.getByRole('button', { name: label, exact: true })
      await trigger.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
    }
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog')
    // The dialog opens on whichever tag the list happens to lead with, which is
    // not the one this test is about.
    await dialog.getByLabel('Merge into').selectOption(target.slug)

    // Two documents carry one tag or the other, and one of them carries both.
    // The sum of the two figures in the list behind the dialog is 3 — 2 carrying
    // the source plus 1 carrying the destination — and 3 is the number this
    // sentence must never show: it counts the document that carries both twice.
    await expect(dialog.locator('[data-slot="field-description"]')).toHaveText(
      `${target.name} will end up on 2 documents — 1 of them already carries “${target.name}”, so for those this drops “${source.name}” rather than replacing it.`,
    )
  })

  await test.step('rewrites exactly the documents the sentence named, and lands on the survivor', async () => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click()

    // The tag this run was started from no longer exists, so its page cannot be
    // re-rendered — the operator is moved to the tag that survived instead, and
    // the page behind them reports what the tag it names is now on.
    await expect(page).toHaveURL(new RegExp(`/admin/tags/${target.slug}$`))
    await expect(page.getByRole('heading', { level: 1, name: target.name })).toBeVisible()

    // The table is named for the tag, so this is the destination's own list of
    // what carries it — the two documents, and nothing else.
    const documents = page.getByRole('table', {
      name: `Documents carrying the tag ${target.name}`,
    })
    await expect(documents.getByRole('link', { name: carriesBoth.title })).toBeVisible()
    await expect(documents.getByRole('link', { name: sourceOnly.title })).toBeVisible()
  })

  await test.step('leaves the destination on both documents and the source on neither', async () => {
    await page.goto(`/tags/${target.slug}`)
    await expect(page.getByRole('link', { name: carriesBoth.title })).toBeVisible()
    await expect(page.getByRole('link', { name: sourceOnly.title })).toBeVisible()

    // The tag was merged away rather than merely unused, so the URL it owned
    // stops resolving — the consequence the dialog is warning about, read where
    // a reader would find it.
    const response = await page.goto(`/tags/${source.slug}`)
    expect(response?.status()).toBe(404)
  })

  await test.step('deletes what it published', async () => {
    await page.goto('/admin/posts')

    for (const document of [carriesBoth, sourceOnly]) {
      await page
        .getByRole('row', { name: new RegExp(document.title) })
        .getByRole('button', { name: 'Delete' })
        .click()
      await page.getByRole('button', { name: 'Delete permanently' }).click()
      await expect(page.getByText('Document deleted')).toBeVisible()
    }
  })
})
