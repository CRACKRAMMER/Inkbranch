import { expect, test, type Page } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The about page, end to end.
 *
 * Two claims, and neither is a claim about one file. The first is that the page
 * is assembled from settings: a paragraph typed into a textarea, a focus item
 * added as a row, a stack group, a currently row, a contact link — five
 * different editors, one settings row, one public page. The second is that the
 * last two of its seven blocks are not settings at all: Projects and Latest
 * writing are read from the content index, so the only way to prove them is to
 * publish a document through the admin and go looking for it.
 *
 * It also writes the kind of setting nothing else in this suite writes. Every
 * other spec touches a boolean toggle; the list editors here are where a person
 * actually spends their time, and they are the part of the form that had no
 * coverage before this spec existed.
 *
 * The documents are deleted at the end, so the single content tree this suite
 * shares is left as it was found. The settings are left as they are written
 * instead, because the page they configure is one no other spec reads — and
 * because removing them afterwards would mean a second pass through the same
 * form to prove nothing the save had not already proved. What keeps that from
 * accumulating is the empty-the-lists step: a second run replaces the first
 * run's rows rather than sitting next to them.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('the about page is assembled from settings and from the index', async ({ page }) => {
  const slug = uniqueSlug()
  // Two slugs, because the two documents are two documents: sharing one would
  // let a list that only ever read a single row pass for the right reason.
  const postSlug = slug
  const projectSlug = uniqueSlug()
  const postTitle = `E2E About Post ${slug}`
  const projectTitle = `E2E About Project ${slug}`

  /*
   * Every string carries the run's slug. The assertions below are all "this
   * value is on the page", and a value the seed happened to ship already would
   * make one of them pass without the settings having been read at all.
   */
  const profile = `A profile paragraph written for ${slug}, long enough to be a paragraph.`
  const focus = `Focus area ${slug}`
  const stackItem = `TypeScript ${slug}`
  const currentValue = `A book about ${slug}`
  const mailto = `mailto:${slug}@example.com`

  await test.step('fills in every block the settings hold', async () => {
    await signIn(page)
    await page.goto('/admin/settings')

    /*
     * Empty every list before filling it. The settings row outlives a run —
     * one row in a database the suite creates but does not wipe between specs —
     * so a second run must replace what the first left rather than append to
     * it. The save below is a patch of the keys that changed, so a stale row
     * would otherwise survive every future run and quietly accumulate.
     */
    for (const legend of ['Focus areas', 'Currently', 'Stack', 'Contact']) {
      await clearRows(fieldset(page, legend))
    }

    await page.fill('#setting-aboutProfile', profile)

    const focusList = fieldset(page, 'Focus areas')
    await focusList.getByRole('button', { name: 'Add a focus area' }).click()
    await field(focusList, 'Focus area').fill(focus)

    const currently = fieldset(page, 'Currently')
    await currently.getByRole('button', { name: 'Add a row' }).click()
    await field(currently, 'Label').fill('Reading')
    await field(currently, 'Value').fill(currentValue)

    const stack = fieldset(page, 'Stack')
    await stack.getByRole('button', { name: 'Add a group' }).click()
    await field(stack, 'Group').fill('Languages')
    await field(stack, 'Items, one per line').fill(stackItem)

    const contact = fieldset(page, 'Contact')
    await contact.getByRole('button', { name: 'Add a contact' }).click()
    await field(contact, 'Label').fill('Email')
    await field(contact, 'Destination').fill(mailto)

    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(/All changes saved at/)).toBeVisible()
  })

  await test.step('publishes one document of each kind', async () => {
    await publish(page, 'posts', postTitle, postSlug)
    await publish(page, 'projects', projectTitle, projectSlug)
  })

  await test.step('renders the blocks it was given', async () => {
    await page.goto('/about')

    /*
     * Scoped to `main`, because the footer carries the same contact list under
     * the same "Elsewhere" heading — a page-wide query for either finds two of
     * them. The footer is not a second about page, and the assertions below are
     * about the one the reader came for.
     */
    const about = page.getByRole('main')

    await expect(about.getByRole('heading', { level: 1, name: 'About' })).toBeVisible()
    await expect(about.getByText(profile)).toBeVisible()

    // The authored blocks. Each one came from a different editor above, and
    // each is asserted by its value rather than by its heading, because a
    // heading with nothing under it is exactly the failure worth catching.
    await expect(about.getByRole('heading', { name: 'Uses', exact: true })).toBeVisible()
    await expect(about.getByText('Languages')).toBeVisible()
    await expect(about.getByText(stackItem)).toBeVisible()
    await expect(about.getByText(focus)).toBeVisible()
    await expect(about.getByText(currentValue)).toBeVisible()
    await expect(about.getByRole('link', { name: 'Email' })).toHaveAttribute('href', mailto)

    // The aside's four headings are the other four blocks of the brief. Three
    // of them ("Now", "Focus", "Elsewhere") hold the values asserted above;
    // "Here" is counts, and it is asserted by its links.
    //
    // `exact: true`, because a heading name is matched as a substring: "Here"
    // finds "Elsewhere" as readily as it finds itself.
    for (const block of ['Now', 'Focus', 'Elsewhere', 'Here']) {
      await expect(about.getByRole('heading', { name: block, exact: true })).toBeVisible()
    }
  })

  await test.step('lists the documents that were just published', async () => {
    const projects = page.locator('#projects')
    const writing = page.locator('#writing')

    await expect(projects.getByRole('link', { name: projectTitle })).toBeVisible()
    await expect(writing.getByRole('link', { name: postTitle })).toBeVisible()

    // The two lists are one query split in two, and the split is the claim: a
    // project is not writing, and an article is not a project. Without this,
    // two blocks that both rendered every row would pass.
    await expect(writing.getByRole('link', { name: projectTitle })).toHaveCount(0)
    await expect(projects.getByRole('link', { name: postTitle })).toHaveCount(0)
  })

  await test.step('deletes what it published', async () => {
    for (const [segment, title] of [
      ['posts', postTitle],
      ['projects', projectTitle],
    ] as const) {
      await page.goto(`/admin/${segment}`)
      await page.getByRole('row', { name: new RegExp(title) }).getByRole('button', { name: 'Delete' }).click()
      await page.getByRole('button', { name: 'Delete permanently' }).click()

      // The toast rather than the row disappearing: everything outside the
      // modal is `aria-hidden` while it is open, and `getByRole` cannot see an
      // `aria-hidden` subtree — a check on the row would pass before the
      // request had been sent. See the same note in feeds.spec.ts.
      await expect(page.getByText('Document deleted')).toBeVisible()
    }

    // And the public page agrees. It is rendered per request (the site layout
    // is `force-dynamic`), so this is a statement about the index rather than
    // about a cache.
    await page.goto('/about')
    await expect(page.getByRole('link', { name: postTitle })).toHaveCount(0)
    await expect(page.getByRole('link', { name: projectTitle })).toHaveCount(0)
  })
})

/**
 * The fieldset one of the settings form's list editors lives in.
 *
 * The editors are the same component five times over, so their controls are the
 * same controls five times over — five "Add a row" buttons, and inputs whose
 * labels are as generic as "Label". Scoping by the fieldset (whose accessible
 * name is its legend) is what makes those names unambiguous; a page-wide
 * `getByLabel('Label')` would be a strict-mode violation rather than a test.
 */
function fieldset(page: Page, legend: string) {
  return page.getByRole('group', { name: legend })
}

/**
 * One input inside a fieldset, by its label.
 *
 * `getByLabel` alone is not enough: matching is a case-insensitive substring,
 * and the row's own buttons are labelled with the row's value — `Remove focus
 * area 1` contains "Focus area". Asking for a textbox with that exact name
 * leaves only the field.
 */
function field(scope: ReturnType<typeof fieldset>, name: string) {
  return scope.getByRole('textbox', { name, exact: true })
}

/**
 * Removes every row from a list editor.
 *
 * Counted rather than looped until empty: a click that did not remove anything
 * would spin here until the test timed out, with nothing in the report to say
 * which click was the one that stopped working.
 */
async function clearRows(scope: ReturnType<typeof fieldset>): Promise<void> {
  const remove = scope.getByRole('button', { name: /^Remove / })
  const rows = await remove.count()
  for (let index = 0; index < rows; index += 1) {
    await remove.first().click()
  }
}

/**
 * Writes a document and publishes it, the way an author would.
 *
 * One helper for both types because the admin has one new-document form for all
 * three — the type is the segment in the URL, not a field. The four steps are
 * copied from `authoring.spec.ts` deliberately: this spec's job is the about
 * page, and a second authoring flow invented here would be a second thing to
 * keep working.
 */
async function publish(
  page: Page,
  segment: 'posts' | 'projects',
  title: string,
  slug: string,
): Promise<void> {
  await page.goto(`/admin/${segment}/new`)
  await page.fill('#title', title)
  await page.fill('#slug', slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()

  // Landing on the editor is the proof the file was written; anything else
  // means the create failed and every later assertion would be about nothing.
  await expect(page).toHaveURL(new RegExp(`/admin/${segment}/${slug}/edit`))

  await typeBody(page, `A document written so the about page has something to list.\n`)
  await showMetadata(page)
  await page.selectOption('#fm-status', 'published')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
}
