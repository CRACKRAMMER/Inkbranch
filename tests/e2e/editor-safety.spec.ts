import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import sharp from 'sharp'
import { expect, test, type Page } from '@playwright/test'

import { E2E_CONTENT_DIR, e2eDatabaseUrl } from './environment'
import { showMetadata, signIn, typeBody, uniqueSlug } from './support'

async function create(page: Page, slug: string): Promise<void> {
  await signIn(page)
  await page.goto('/admin/posts/new')
  await page.fill('#title', `Editor safety ${slug}`)
  await page.fill('#slug', slug)
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}/edit`))
}

async function write(page: Page, text: string): Promise<void> {
  const panes = page.getByRole('group', { name: 'Editor pane' })
  if (await panes.isVisible()) await panes.getByRole('button', { name: 'Write', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved to file at/)).toBeVisible()
}

async function remove(page: Page, slug: string): Promise<void> {
  await page.goto('/admin/posts')
  const row = page.getByRole('row', { name: new RegExp(slug) })
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByText('Document deleted')).toBeVisible()
}

test('keeps text typed during a save dirty and writes it on the next save', async ({ page }) => {
  const slug = uniqueSlug()
  await create(page, slug)
  await write(page, 'Version A sent to disk.')
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const intercepted = new Promise<void>((resolve) => { reached = resolve })
  let delayed = false
  await page.route(`**/admin/posts/${slug}/edit`, async (route) => {
    if (route.request().method() !== 'POST' || delayed) return route.continue()
    delayed = true
    const response = await route.fetch()
    reached()
    await held
    await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await intercepted
    await write(page, 'Version B typed while the response is pending.')
    release()
    await expect(page.getByText('Unsaved changes — not yet written to the file')).toBeVisible()
    expect(fs.readFileSync(path.join(E2E_CONTENT_DIR, 'posts', `${slug}.md`), 'utf8')).toContain('Version A')
    await save(page)
    expect(fs.readFileSync(path.join(E2E_CONTENT_DIR, 'posts', `${slug}.md`), 'utf8')).toContain('Version B')
  } finally {
    release()
    await page.unroute(`**/admin/posts/${slug}/edit`)
  }
  await remove(page, slug)
})

test('records a draft without touching the file, restores A over B, then edits again', async ({ page }) => {
  const slug = uniqueSlug()
  await create(page, slug)
  await write(page, 'Version A to recover.')
  await showMetadata(page)
  await page.selectOption('#fm-status', 'published')
  await save(page)
  const file = path.join(E2E_CONTENT_DIR, 'posts', `${slug}.md`)
  const original = fs.readFileSync(file, 'utf8')

  await write(page, 'Unsaved draft buffer.')
  await expect(page.getByText(/Draft revision recorded/)).toBeVisible()
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  await write(page, 'Version B replacing A.')
  await save(page)

  await page.getByRole('link', { name: 'Revisions', exact: true }).click()
  const revision = page.locator('tbody tr').filter({ hasNot: page.getByText('autosave', { exact: true }) }).first().getByRole('link')
  await revision.click()
  await expect(page.locator('article')).toContainText('Version A to recover.')
  await page.getByRole('button', { name: /Restore revision/ }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText(/restored to the file/)).toBeVisible()

  await page.goto(`/posts/${slug}`)
  await expect(page.locator('[data-article-body]')).toContainText('Version A to recover.')
  const restored = fs.readFileSync(file, 'utf8')
  const client = new Client({ connectionString: e2eDatabaseUrl() })
  await client.connect()
  try {
    const index = await client.query('SELECT checksum FROM content_index WHERE slug = $1', [slug])
    expect(index.rows[0]?.checksum).toBe(createHash('sha256').update(restored).digest('hex'))
  } finally {
    await client.end()
  }
  await page.goto(`/admin/posts/${slug}/edit`)
  await write(page, 'Version C after restore.')
  await save(page)
  expect(fs.readFileSync(file, 'utf8')).toContain('Version C after restore.')
  await remove(page, slug)
})

test('renders interactive code and tabs in the editor preview', async ({ page }) => {
  const slug = uniqueSlug()
  await create(page, slug)
  await typeBody(page, '```ts\nconst answer = 42\n```\n\n::::tabs\n:::tab[One]\nFirst panel.\n:::\n:::tab[Two]\nSecond panel.\n:::\n::::')
  const panes = page.getByRole('group', { name: 'Editor pane' })
  if (await panes.isVisible()) await panes.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.locator('[data-editor-preview]')
  await expect(preview.locator('.code-block__copy')).toBeVisible()
  await preview.locator('.code-block__copy').click()
  await expect(preview.locator('.code-block')).toHaveAttribute('data-copied', 'true')
  await expect(preview.locator('.md-tabs')).toHaveAttribute('data-enhanced', 'true')
  await preview.getByRole('tab', { name: 'Two' }).click()
  await expect(preview.getByText('Second panel.')).toBeVisible()
  await expect(preview.getByText('First panel.')).toBeHidden()
  await preview.getByRole('tab', { name: 'Two' }).press('ArrowLeft')
  await expect(preview.getByRole('tab', { name: 'One' })).toBeFocused()
  await expect(preview.getByText('First panel.')).toBeVisible()
  await save(page)
  await remove(page, slug)
})

test('keeps diagram source readable when its deferred renderer cannot load', async ({ page }) => {
  const slug = uniqueSlug()
  await create(page, slug)
  await expect(page.locator('.cm-content')).toBeVisible()
  // The editor and its enhancer are already loaded. Only later JS requests,
  // including the Mermaid import, fail as they would on a broken connection.
  await page.route('**/_next/static/chunks/*.js', (route) => route.abort('failed'))
  await typeBody(page, '```mermaid\ngraph TD\n  Start --> Finish\n```')
  const panes = page.getByRole('group', { name: 'Editor pane' })
  if (await panes.isVisible()) await panes.getByRole('button', { name: 'Preview', exact: true }).click()
  const diagram = page.locator('[data-editor-preview] .mermaid-block')
  await expect(diagram).toHaveAttribute('data-error', 'true')
  await expect(diagram.locator('pre')).toBeVisible()
  await expect(diagram).toContainText('Start --> Finish')
  await page.unroute('**/_next/static/chunks/*.js')
  await save(page)
  await remove(page, slug)
})

test('uploads pasted and dropped images and inserts loadable Markdown URLs', async ({ page, context }) => {
  const slug = uniqueSlug()
  await create(page, slug)
  await write(page, 'Clipboard and drag images.\n\n')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const image = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#568192' } }).png().toBuffer()
  await page.bringToFront()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.evaluate(async (bytes) => {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(bytes)], { type: 'image/png' }) })])
  }, [...image])
  await page.keyboard.press('Control+v')
  await expect(page.locator('.cm-content')).toContainText('/api/assets/')

  await page.locator('.cm-content').evaluate((node, bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(bytes)], 'dropped-picture.png', { type: 'image/png' }))
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, [...image])
  await expect.poll(async () => ((await page.locator('.cm-content').innerText()).match(/!\[[^\]]*\]\(\/api\/assets\/[^)]+\)/g) ?? []).length).toBe(2)
  await showMetadata(page)
  await page.selectOption('#fm-status', 'published')
  await save(page)
  await page.goto(`/posts/${slug}`)
  const images = page.locator('[data-article-body] img')
  await expect(images).toHaveCount(2)
  for (const image of await images.all()) await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(20)
  await remove(page, slug)
})
