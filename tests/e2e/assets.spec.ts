import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { E2E_UPLOAD_DIR, hasE2eDatabase } from './environment'
import { signIn, uniqueSlug } from './support'

/**
 * The asset thumbnail, end to end.
 *
 * §20 asks for one, and the library grid is the only thing that loads it, so
 * this walks the path a person does: upload a picture far too large for a grid
 * cell, then check that what the browser downloads is the scaled copy and not
 * the original. Every assertion is about a response that actually crossed the
 * wire — the unit suite already proves the file is written, and none of it
 * would notice a grid that still points at the 1200px original.
 *
 * A separate file from `authoring.spec.ts` because the two uploads are the two
 * sides of one rule. That test drops in a one-pixel PNG, which must *not* get a
 * thumbnail — a copy of it would be the same pixels under a second name — and
 * this one drops in a picture that must. Both rules need a test, and they need
 * different fixtures.
 */

test.skip(
  !hasE2eDatabase,
  'TEST_DATABASE_URL is not set, so the E2E suite has no database to run against.',
)

test('a picture too large for a grid cell is served to the library scaled down', async ({
  page,
}) => {
  const marker = uniqueSlug()
  const name = `${marker}.png`

  /*
   * Generated rather than committed, and a flat colour on purpose. The last
   * assertion is that the thumbnail is smaller than the original, and a picture
   * with detail in it would turn that into a test of the two encoders; a solid
   * one asks the question the product asks, which is whether the scaled copy is
   * a smaller download. 1200x800 is comfortably past the 480px box, so the
   * thumbnail is 480x320 — the dimensions asserted below.
   *
   * The colour is derived from the name because uploads are content-addressed:
   * a second run producing byte-identical bytes is deduplicated onto the first
   * run's row, which keeps the *first* run's filename, and this test would then
   * be looking for a figure labelled with a name that was never stored. One
   * byte of difference is enough, and it costs nothing to be sure.
   */
  const seed = [...marker].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const original = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: seed % 256, g: (seed * 7) % 256, b: (seed * 13) % 256 },
    },
  })
    .png()
    .toBuffer()

  await signIn(page)

  let originalUrl = ''
  let thumbnailUrl = ''

  await test.step('uploads it', async () => {
    await page.goto('/admin/assets')
    await expect(page.getByLabel('Files to upload', { exact: true })).toHaveAttribute('type', 'file')

    // Through the button a person clicks rather than by setting the hidden
    // input directly, so the picker wiring is part of what runs.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Choose files' }).click(),
    ])
    await chooser.setFiles({ name, mimeType: 'image/png', buffer: original })

    // The upload is a server action, and the panel it produces is the result:
    // the Markdown the editor would insert. Waiting for it is waiting for the
    // bytes to have been stored.
    const inserted = page.locator('code', { hasText: '/api/assets/' })
    await expect(inserted).toBeVisible()

    const markdown = (await inserted.textContent()) ?? ''
    originalUrl = markdown.match(/\/api\/assets\/[^\s)]+/)?.[0] ?? ''
    expect(originalUrl).toMatch(/\.png$/)
  })

  await test.step('serves it scaled to the grid', async () => {
    const figure = page.locator('figure').filter({ hasText: name })
    await expect(figure).toBeVisible()

    const image = figure.locator('img')
    thumbnailUrl = (await image.getAttribute('src')) ?? ''

    // A different file, not the same one addressed twice: content addressing
    // means a scaled copy cannot collide with its original, so an equal URL
    // here would mean no thumbnail was written at all.
    expect(thumbnailUrl).not.toBe(originalUrl)

    // And it is the scaled one, which is a fact about the decoded image rather
    // than about the path: a `src` that 404s and a `src` that is the original
    // both look fine to an attribute check.
    await expect
      .poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(480)
  })

  await test.step('costs less than the original', async () => {
    const [thumbnail, full] = await Promise.all([
      page.request.get(thumbnailUrl),
      page.request.get(originalUrl),
    ])

    expect(thumbnail.status()).toBe(200)
    expect(full.status()).toBe(200)
    expect((await thumbnail.body()).length).toBeLessThan((await full.body()).length)
  })

  await test.step('describes it on the asset page', async () => {
    await page.locator('figure').filter({ hasText: name }).getByRole('link', { name }).click()

    const section = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Thumbnail', exact: true }),
    })
    await expect(section).toBeVisible()

    // The dimensions of the file that was written, printed from the row rather
    // than measured here, so a grid that renders correctly from a row the page
    // describes wrongly is still a failure.
    await expect(section).toContainText('480 × 320')

    const stored = await section.locator('dd', { hasText: '/api/assets/' }).textContent()
    expect(stored?.trim()).toBe(thumbnailUrl)
  })

  await test.step('names it in the list view', async () => {
    // The list has no image column, so the badge is the only place a reader can
    // see that this asset has a thumbnail at all.
    await page.goto(`/admin/assets?layout=list&q=${marker}`)

    const row = page.getByRole('row', { name: new RegExp(name) })
    await expect(row).toContainText(`thumb 480×320`)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })

  await test.step('cancels deletion and returns keyboard focus to the asset action', async () => {
    const row = page.getByRole('row', { name: new RegExp(name) })
    const trigger = row.getByRole('button', { name: 'Delete', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/Nothing references it/)).toBeVisible()
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab')
      await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    expect((await page.request.get(originalUrl)).status()).toBe(200)
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(row).toBeVisible()
  })

  await test.step('deletes from the detail page and returns to the library', async () => {
    await page.getByRole('row', { name: new RegExp(name) }).getByRole('link', { name }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/Nothing references it/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForURL('/admin/assets')
    await expect(page.locator('figure').filter({ hasText: name })).toHaveCount(0)
    expect((await page.request.get(originalUrl)).status()).toBe(404)
    expect((await page.request.get(thumbnailUrl)).status()).toBe(404)
  })
})

test('default upload URLs use the sandboxed route and cannot expose private files', async ({ request }) => {
  const marker = uniqueSlug()
  const fixtureRoot = path.join(E2E_UPLOAD_DIR, marker)
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'inkbranch-e2e-asset-jail-'))
  const temporary = path.join(E2E_UPLOAD_DIR, '.tmp', `${marker}.svg`)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>'
  try {
    await fs.mkdir(fixtureRoot, { recursive: true })
    await fs.mkdir(path.dirname(temporary), { recursive: true })
    await fs.writeFile(path.join(fixtureRoot, 'safe.svg'), svg)
    await fs.writeFile(temporary, '<svg>partial private upload</svg>')
    await fs.writeFile(path.join(outside, 'private.txt'), 'private fixture outside upload tree')
    await fs.symlink(path.join(outside, 'private.txt'), path.join(fixtureRoot, 'linked.txt'))
    await fs.symlink(outside, path.join(fixtureRoot, 'linked-directory'))

    for (const prefix of ['/uploads', '/api/assets']) {
      const safe = await request.get(`${prefix}/${marker}/safe.svg`)
      expect(safe.status()).toBe(200)
      expect(await safe.text()).toBe(svg)
      expect(safe.headers()['content-type']).toBe('image/svg+xml')
      expect(safe.headers()['content-security-policy']).toBe("default-src 'none'; sandbox")
      expect(safe.headers()['x-content-type-options']).toBe('nosniff')

      for (const relative of [`${marker}/linked.txt`, `${marker}/linked-directory/private.txt`]) {
        const denied = await request.get(`${prefix}/${relative}`)
        expect(denied.status()).toBe(400)
        expect(await denied.text()).not.toContain('private fixture outside upload tree')
        expect(denied.headers()['cache-control']).toBe('no-store')
      }
      const partial = await request.get(`${prefix}/.tmp/${marker}.svg`)
      expect(partial.status()).toBe(404)
      expect(await partial.text()).not.toContain('partial private upload')
      expect(partial.headers()['cache-control']).toBe('no-store')

      const missing = await request.get(`${prefix}/${marker}/missing.svg`)
      expect(missing.status()).toBe(404)
      expect(missing.headers()['cache-control']).toBe('no-store')
    }
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
    await fs.rm(temporary, { force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})
