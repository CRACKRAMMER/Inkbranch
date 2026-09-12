import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'

import { hasE2eDatabase } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

/**
 * The formats an article's pictures are offered in, from the browser's side.
 *
 * ## What this covers that nothing else does
 *
 * `tests/integration/content-render.test.ts` proves the markup: the derivative
 * URLs on the row become `<source>` elements, best codec first, with the stored
 * original left alone as the `<img>`. What it cannot show is which file the
 * *browser* fetches — an offer of AVIF and a browser that takes it are two
 * separate facts, and the second one is the entire point of the exercise. So
 * the assertion here is `currentSrc`, the URL that was actually requested, plus
 * `naturalWidth` on the decoded result, which is what distinguishes the same
 * picture in another format from a smaller one at the right size.
 *
 * The last step is about the frame rather than the file: the wrapper the
 * renderer puts around every image is there for the CSS to draw a line around,
 * and whether it actually does is a fact about the rendered box rather than
 * about the markup.
 *
 * ## Why the fixture is noise, and why it is different every run
 *
 * A derivative is kept only when it is strictly smaller than the stored
 * original — that rule lives in `src/lib/assets/process.ts` and it is what stops
 * a `<picture>` from being a slower way to serve the same image. It would be
 * easy to draw a fixture that fails it, so the picture is one the formats
 * clearly win on: at 400x300 the noise is about 360 KB as PNG against 86 KB as
 * WebP and 77 KB as AVIF. That is also the shape of the thing the feature is
 * for — a photograph — rather than a claim about a 4 KB rectangle. (A flat
 * rectangle does produce both derivatives, incidentally: PNG cannot compress
 * noise, but it does not beat WebP on a solid colour either.)
 *
 * Random bytes rather than the same picture every run, because uploads are
 * stored under the hash of their contents: identical bytes are deduplicated
 * onto the row a previous run created, and a row written before this pipeline
 * existed would then be answering for the run that is supposedly testing it.
 * Random bytes are the cheapest way to be certain the row under test is one
 * this run wrote.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

/** A picture of pure entropy, at the size the derivative step is measured for. */
async function noisyPng(width = 400, height = 300): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

test('a photograph is offered in the modern formats, and the browser takes one', async ({
  page,
}) => {
  const slug = uniqueSlug()
  const title = `E2E Picture ${slug}`
  let originalUrl = ''

  await test.step('creates a draft', async () => {
    await signIn(page)

    await page.goto('/admin/posts/new')
    await page.fill('#title', title)
    await page.fill('#slug', slug)
    await page.selectOption('#status', 'draft')
    await page.getByRole('button', { name: 'Create and edit' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))
  })

  await test.step('drops a photograph into the body', async () => {
    await typeBody(page, 'A paragraph, and a picture underneath it.')

    // Through the picker rather than by writing the Markdown by hand, so the
    // upload, the sniffing and the URL the store returns are all part of what
    // runs. The caret is at the end of the paragraph, which is where the
    // markdown lands.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.keyboard.press('Control+Shift+I'),
    ])
    await chooser.setFiles({
      name: 'photograph.png',
      mimeType: 'image/png',
      buffer: await noisyPng(),
    })

    const source = page.locator('.cm-content')
    await expect(source).toContainText('![](/api/assets/')

    // The URL is read back out of the source rather than rebuilt from the
    // markdown the action returns: the claim under test includes that what the
    // editor inserted is what the store produced.
    originalUrl =
      ((await source.textContent()) ?? '').match(/!\[\]\((\/api\/assets\/[^\s)]+)\)/)?.[1] ?? ''
    expect(originalUrl).toMatch(/\.png$/)
  })

  await test.step('publishes it', async () => {
    await showMetadata(page)
    await page.selectOption('#fm-status', 'published')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/Saved to file/)).toBeVisible()
  })

  await test.step('serves it in the format the browser prefers', async () => {
    await page.goto(`/posts/${slug}`)
    const body = page.locator('[data-article-body]')

    const picture = body.locator('picture')
    await expect(picture).toHaveCount(1)

    // Both formats the store writes, best first. A browser takes the first
    // `<source>` it understands, so this order is what decides the download —
    // WebP listed first would be chosen on a browser that reads AVIF.
    const sources = picture.locator('source')
    await expect(sources).toHaveCount(2)
    await expect(sources.nth(0)).toHaveAttribute('type', 'image/avif')
    await expect(sources.nth(1)).toHaveAttribute('type', 'image/webp')

    const image = picture.locator('img')

    // The image is still the original, exactly as the author placed it. The
    // derivatives are an offer beside it; rewriting the `src` would trade a
    // file known to exist for one merely believed to.
    await expect(image).toHaveAttribute('src', originalUrl)

    // Lazy-loaded, so the fetch happens as it comes near the viewport — which
    // is what scrolling it into view asks for.
    await image.scrollIntoViewIfNeeded()

    // The file that was actually fetched. Everything above is markup, and
    // markup that offers AVIF to a browser which then downloads the PNG passes
    // every one of those assertions.
    await expect
      .poll(async () => image.evaluate((node) => (node as HTMLImageElement).currentSrc))
      .toMatch(/\.avif$/)

    // And it is the same picture, not a smaller one: a derivative is the stored
    // original re-encoded, so the size the row reported is the size on screen.
    await expect
      .poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(400)
    await expect(image).toHaveAttribute('width', '400')
    await expect(image).toHaveAttribute('height', '300')
  })

  await test.step('draws one frame, around the picture', async () => {
    /*
     * The wrapper `.md-image` is `inline-block` and the image inside it is a
     * block, so the wrapper's box is the picture's box. That is the assertion —
     * it is a CSS property with a visible consequence, and the consequence is
     * what a reader sees: an inline wrapper around a block image is split by
     * the block-in-inline rule, so its border is painted around the *inline*
     * box, which is two vertical rules taller than the image they were meant to
     * frame. The frame belongs to the image alone; two elements drawing it is a
     * line that reads as heavier than every other line on the page.
     */
    const body = page.locator('[data-article-body]')
    const round = (box: { x: number; y: number; width: number; height: number } | null) =>
      box && {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }

    const [wrapper, image] = await Promise.all([
      body.locator('.md-image').boundingBox(),
      body.locator('.md-image img').boundingBox(),
    ])

    expect(wrapper).not.toBeNull()
    expect(round(wrapper)).toEqual(round(image))
  })

  await test.step('deletes the article', async () => {
    await page.goto('/admin/posts')
    await page
      .getByRole('row', { name: new RegExp(title) })
      .getByRole('button', { name: 'Delete' })
      .click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(page.getByText('Document deleted')).toBeVisible()
  })
})
