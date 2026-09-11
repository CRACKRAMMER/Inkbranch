import { expect, test } from '@playwright/test'

import { hasE2eDatabase } from './environment'
import {
  jsonLdNodeOfType,
  jsonLdNodes,
  showMetadata,
  signIn,
  typeBody,
  uniqueSlug,
} from './support'

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

/**
 * A one-pixel PNG, as base64.
 *
 * Generated rather than committed: a binary fixture is a file nobody reviews
 * and one more thing in the tree, and this is a whole valid PNG in a line. It
 * has to be a real image — the upload path sniffs magic bytes and will refuse
 * anything else — which is also what makes it worth having in the test.
 */
const PNG_PIXEL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNQcEgAAAFEAME1cEXuAAAAAElFTkSuQmCC'

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

  await test.step('writes a body', async () => {
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
        '',
        // The next step inserts where typing left the caret, and a caret at the
        // end of a code fence puts what it inserts *inside* the block — a fence
        // line with anything after it is not a closing fence. This paragraph is
        // here so that the place the shortcuts act is ordinary prose.
        'A closing paragraph gives the shortcuts somewhere to land.',
      ].join('\n'),
    )
  })

  await test.step('inserts a link and an image from the keyboard', async () => {
    /*
     * Both halves of §17's key list that no other test reaches, and they are
     * asserted on the source rather than on the rendered page because that is
     * where they act: what the author sees after Ctrl+K is Markdown, and the
     * next thing they do is finish it by hand. A test that only checked the
     * rendered output would pass for a command that inserted the finished link
     * with a placeholder URL, which is the failure mode here — the destination
     * is the one part the editor cannot know.
     */
    const source = page.locator('.cm-content')

    /*
     * The caret is wherever typing left it — the end of the closing paragraph —
     * so the step starts by confirming the editor still owns focus instead of
     * clicking back into it. A click would be a second way of placing the caret,
     * and on the touch project it is a damaging one: measured there, a tap loses
     * the `Enter` that follows it 6 times out of 6, and 2 out of 6 without the
     * tap, against 0 on `chromium`. So nothing below presses it. The keys this
     * step is about are CodeMirror commands and every other keystroke is
     * ordinary typing, which is the same line `typeBody` draws for the same
     * reason: the event log shows `Enter` reaching the page as `keypress` plus
     * `beforeinput insertParagraph` — the browser's own contenteditable edit,
     * not the editor's keymap — and that is the half that goes missing.
     */
    await expect(source).toBeFocused()

    // Ctrl+K with nothing selected: the template arrives with its `text` half
    // selected, so the next keystroke replaces it.
    await page.keyboard.press('Control+k')
    await page.keyboard.type('the manual')
    await expect(source).toContainText('[the manual](url)')

    // The caret is on the destination, which is where a paste would land. It
    // walks in and types it instead of selecting, because the assertions above
    // are about positions and a selection would hide a caret in the wrong one.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Delete')
    await page.keyboard.type('https://example.com/docs')
    await expect(source).toContainText('[the manual](https://example.com/docs)')

    // Out of the parentheses before the next insert. The caret is still inside
    // the destination after typing one — that is where the author's next paste
    // would go, which is the point of leaving it there — so anything inserted
    // next lands in the URL. This test walked in deliberately and has to walk
    // back out deliberately. The image then goes on the link's own line, which
    // is what Markdown does with an image at the end of a sentence.
    await page.keyboard.press('ArrowRight')

    /*
     * Ctrl+Shift+I opens a real file dialog, which Playwright answers — so what
     * runs here is the picker, the upload action and the Markdown it returns,
     * with a real PNG and real magic-byte sniffing behind it. A one-pixel image
     * is a valid image: the bytes are generated rather than committed, so the
     * fixture is one line instead of a binary file nobody can review.
     */
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.keyboard.press('Control+Shift+I'),
    ])
    await chooser.setFiles({
      name: 'e2e-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_PIXEL_BASE64, 'base64'),
    })

    // The upload is an action, so the assertion waits for its result rather
    // than for the key: an image whose markdown never arrives is the failure
    // that a check on the key press would miss. The prefix is the route this
    // deployment serves uploads from, which is not `/uploads` here — the suite
    // points `UPLOAD_DIR` at a temp directory that no static handler serves.
    await expect(source).toContainText('![](/api/assets/')
  })

  await test.step('publishes it', async () => {
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

    // And what the two shortcuts inserted is real markup too: a link with the
    // destination that was typed into it, and an image the server is serving
    // from the uploads directory. The link is followed to its href and the
    // image is checked for actually loading, because a broken image is what an
    // upload that stored the markdown but not the bytes looks like.
    await expect(body.getByRole('link', { name: 'the manual' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    )
    const image = body.locator('img[src*="/api/assets/"]')
    await expect(image).toBeVisible()
    await expect
      .poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  })

  await test.step('names its author as the node the about page publishes', async () => {
    /*
     * The other end of the reference `about.spec.ts` asserts. Two pages, two
     * JSON-LD documents, one `@id`: a post whose author is a bare name is an
     * author nobody can resolve, and a post whose author id is *nearly* the
     * about page's — a different host, a trailing slash, a different fragment —
     * is the same failure with a shape that looks right in both documents read
     * separately. So the id is compared to the one the live about page actually
     * publishes rather than to a string this test builds.
     */
    await page.goto(`/posts/${slug}`)
    const article = jsonLdNodeOfType(await jsonLdNodes(page), 'BlogPosting')
    const author = article.author as Record<string, unknown>

    await page.goto('/about')
    const person = jsonLdNodeOfType(await jsonLdNodes(page), 'Person')

    expect(author['@id']).toBe(person['@id'])
    expect(author.name).toBe(person.name)
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
