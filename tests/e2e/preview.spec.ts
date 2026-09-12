import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_CONTENT_DIR,
  hasE2eDatabase,
} from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The draft preview, and the address the site answers with a 404.
 *
 * A draft is deliberately unreachable: the public page filters on status, so a
 * document that is not published has no address a reader can open — and no
 * address its *author* can open either. `authoring.spec.ts` asserts the first
 * half of that as a feature. This spec is the other half: the route under
 * `/api/preview` renders a document from disk whatever its status, which is what
 * makes it both the only way to read your own draft as a document and the only
 * route in the product that would serve something unpublished. Everything here
 * is about the two claims that follow from that: the author can reach it, and
 * nobody else can.
 *
 * ## What the link has to get right
 *
 * The preview names a **file**, not a document. Its two parameters are fed to
 * `buildRelativePath`, which is what keeps a query string from arriving at the
 * filesystem as a path — so the `slug` it wants is the filename's stem, while
 * every other address in the product names the document's *slug*. Those are not
 * the same word: renaming a slug edits the frontmatter and leaves the file where
 * it is, because a URL someone already shared has to keep working. The second
 * test below performs that rename and then reads the draft, so a link built from
 * the document's slug — the obvious mistake — fails as a 404 from the one page
 * that exists to show the author their own writing.
 *
 * ## The buffer is not the file
 *
 * The editor records autosaved *draft revisions* without writing the file, so a
 * preview taken mid-sentence would show the previous save. That is asserted
 * rather than assumed: while the buffer is ahead, the header says
 * "Preview after saving" instead of offering a link, and the link appears when
 * the file catches up.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

const POSTS = path.join(E2E_CONTENT_DIR, 'posts')

/** The files this spec created, so a run that fails partway still cleans up. */
const created = new Set<string>()

/**
 * Delete the document through the admin, which removes the file and the row.
 *
 * Local rather than in `support.ts`, as in `index-drift.spec.ts`: the deletion
 * is cleanup here, and the flow it drives belongs to `authoring.spec.ts`.
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
  for (const file of created) fs.rmSync(file, { force: true })
  created.clear()
})

test('reads a draft the site refuses to serve, after the slug stops matching the file', async ({
  page,
}) => {
  const slug = uniqueSlug()
  const renamed = `${slug}-renamed`
  const title = `E2E Preview ${slug}`
  const marker = `the paragraph only this draft has ${slug.replace(/-/g, '')}`

  created.add(path.join(POSTS, `${slug}.md`))

  await signIn(page)

  await page.goto('/admin/posts/new')
  await page.fill('#title', title)
  await page.fill('#slug', slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))

  // Typed and not saved. The preview reads the file, so the header says what it
  // would show rather than offering a link to a version that does not exist yet.
  await typeBody(page, marker)
  await expect(page.getByText('Preview after saving')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Preview', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Preview', exact: true })).toBeVisible()

  // Rename the slug. From here the document's address and its file's name are
  // two different words, and the editor has moved to the new one.
  await showMetadata(page)
  await page.fill('#fm-slug', renamed)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${renamed}/edit`))

  const previewHref = await page
    .getByRole('link', { name: 'Preview', exact: true })
    .getAttribute('href')
  // The old name — the file's — because that is what the route will look for.
  expect(previewHref).toBe(`/api/preview?type=post&slug=${slug}`)

  // The reason any of this exists: the site has nothing at either address.
  const refused = await page.goto(`/posts/${renamed}`)
  expect(refused?.status()).toBe(404)

  // And the draft reads as a document, title and prose, at the address the site
  // answered with a 404 a moment ago.
  await page.goto(`/admin/posts/${renamed}/edit`)
  const [opened] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Preview', exact: true }).click(),
  ])
  await opened.waitForLoadState()

  await expect(opened.locator('h1')).toHaveText(title)
  await expect(opened.locator('article')).toContainText(marker)
  // The banner, which is how the author can tell this apart from the site at a
  // glance: the type, and the status the public page filtered on.
  await expect(opened.locator('.banner')).toContainText('Draft preview')
  await expect(opened.locator('.banner')).toContainText('draft')
  await expect(opened.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  )
  await opened.close()

  await deleteThroughAdmin(page, title)
})

test('refuses a stranger, and returns the author to the draft after signing in', async ({
  page,
}) => {
  const slug = uniqueSlug()
  const title = `E2E Preview Gate ${slug}`
  const marker = `the sentence a stranger must not read ${slug.replace(/-/g, '')}`

  created.add(path.join(POSTS, `${slug}.md`))

  await signIn(page)

  await page.goto('/admin/posts/new')
  await page.fill('#title', title)
  await page.fill('#slug', slug)
  await page.selectOption('#status', 'draft')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await typeBody(page, marker)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file/)).toBeVisible()

  const previewHref = await page
    .getByRole('link', { name: 'Preview', exact: true })
    .getAttribute('href')
  expect(previewHref).toBe(`/api/preview?type=post&slug=${slug}`)

  // The same address with no session. The draft is not in what comes back, and
  // the address is carried to the sign-in page rather than dropped — which is
  // what makes the next step land on the draft instead of the dashboard.
  await page.context().clearCookies()
  const refused = await page.goto(previewHref!)
  expect(new URL(page.url()).pathname).toBe('/admin/login')
  expect(new URL(page.url()).searchParams.get('next')).toBe(previewHref)
  expect(await refused!.text()).not.toContain(marker)

  await page.fill('#email', E2E_ADMIN_EMAIL)
  await page.fill('#password', E2E_ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page).toHaveURL(new RegExp('/api/preview\\?type=post'))
  await expect(page.locator('h1')).toHaveText(title)
  await expect(page.locator('article')).toContainText(marker)

  // The route's other promise, on the response a crawler or a shared cache sees:
  // a draft is not to be indexed, and is not to be stored anywhere between here
  // and its author.
  //
  // Read off a navigation rather than off `page.request`, which cannot carry
  // this suite's session: an `APIRequestContext` applies RFC 6265 literally and
  // withholds a `Secure` cookie from an `http:` request, where Chromium exempts
  // `127.0.0.1` — so the same URL through `page.request` arrives signed out and
  // the 200 that comes back is the sign-in page, with none of these headers on
  // it. See `environment.ts` on why the server is configured with
  // `COOKIE_SECURE=1` over plain HTTP in the first place.
  const served = await page.goto(previewHref!)
  expect(served, 'the preview navigation returned no response').not.toBeNull()
  expect(served?.headers()['x-robots-tag']).toContain('noindex')
  expect(served?.headers()['cache-control']).toContain('no-store')

  await deleteThroughAdmin(page, title)
})
