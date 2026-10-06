import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'

import { env } from '@/env'
import { AssetInUseError, AssetQueryError, deleteAsset, findAssetReferences, findUnusedAssets } from '@/lib/assets/manage'
import { storeAsset } from '@/lib/assets/storage'
import { syncContent } from '@/lib/content/sync'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { assets, siteSettings, type AssetRow } from '@/lib/db/schema'
import { testContentRoot, hasTestDatabase } from '../setup'

describe.skipIf(!hasTestDatabase)('asset deletion verifies the Markdown source', () => {
  const created: string[] = []
  const files: string[] = []
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await fs.mkdir(path.join(testContentRoot, 'posts'), { recursive: true })
  })
  afterAll(async () => {
    if (created.length) await db.delete(assets).where(inArray(assets.id, created))
    await Promise.all(files.map((file) => fs.rm(file, { force: true })))
  })

  async function makeAsset(): Promise<AssetRow> {
    const stored = await storeAsset({
      buffer: Buffer.from(`<svg><text>${randomUUID()}</text></svg>`),
      originalFilename: 'delete-safety.svg',
    })
    created.push(stored.asset.id)
    return stored.asset
  }
  async function writeExternal(body: string, metadata = '') {
    const slug = `external-${randomUUID()}`
    const file = path.join(testContentRoot, 'posts', `${slug}.md`)
    files.push(file)
    await fs.writeFile(file, `---\ntitle: External file\nslug: ${slug}\ndescription: Unsynced file\nstatus: published\ndate: 2026-01-01\n${metadata}---\n${body}`)
    return file
  }
  async function expectIntact(asset: AssetRow) {
    expect(await db.select().from(assets).where(eq(assets.id, asset.id))).toHaveLength(1)
    expect(await fs.readFile(path.join(env.UPLOAD_DIR, asset.path))).not.toHaveLength(0)
  }

  it('protects an asset newly referenced by an unsynced Markdown image', async () => {
    const asset = await makeAsset()
    const file = await writeExternal(`![unsynced reference](${asset.url})`)
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally { await fs.rm(file) }
  })

  it('protects CommonMark reference images in an unsynced file', async () => {
    const asset = await makeAsset()
    const file = await writeExternal(`![unsynced reference][image]\n\n[image]: ${asset.url}`)
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally { await fs.rm(file) }
  })

  it('protects the conventional upload alias after the configured prefix changes', async () => {
    const asset = await makeAsset()
    const file = await writeExternal(`![Legacy asset](/uploads/${asset.path})`)
    const oldPrefix = env.UPLOAD_URL_PREFIX
    env.UPLOAD_URL_PREFIX = '/api/assets'
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally {
      env.UPLOAD_URL_PREFIX = oldPrefix
      await fs.rm(file)
    }
  })

  it('protects the fixed asset API alias with the conventional upload prefix configured', async () => {
    const asset = await makeAsset()
    const file = await writeExternal(`![API alias](/api/assets/${asset.path})`)
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally { await fs.rm(file) }
  })

  it.each([
    ['video source', (url: string) => `::video{src="${url}"}`],
    ['video poster', (url: string) => `::video{src="/media/different.webm" poster="${url}"}`],
    ['HTML media source', (url: string) => `<video\n src="${url}" controls></video>`],
    ['HTML audio source', (url: string) => `<audio src="${url}" controls></audio>`],
    ['nested media source', (url: string) => `<audio controls><source src="${url}" type="audio/ogg"></audio>`],
    ['HTML video poster', (url: string) => `<video src="/media/different.webm" poster="${url}"></video>`],
    ['picture source set', (url: string) => `<picture><source srcset="${url} 1x, /media/other.png 2x"><img src="/media/fallback.png"></picture>`],
    ['image source set', (url: string) => `<img src="/media/fallback.png" srcset="${url} 2x" alt="Responsive image">`],
    ['local HTML frame', (url: string) => `<iframe src="${url}" title="Local asset"></iframe>`],
    ['local embed', (url: string) => `::embed{src="${url}" title="Local asset"}`],
    ['percent-encoded asset URL', (url: string) => `![Encoded URL](${url.replace(/\./g, '%2E')})`],
    ['same-origin body URL', (url: string) => `![Absolute URL](${new URL(`${url}?cache=1`, env.SITE_URL).toString()})`],
  ])('protects a %s reference in an unsynced file', async (_name, body) => {
    const asset = await makeAsset()
    const file = await writeExternal(body(asset.url))
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally { await fs.rm(file) }
  })

  it('includes synced media references in the usage list and excludes them from unused assets', async () => {
    const asset = await makeAsset()
    const file = await writeExternal(`::video{src="${asset.url}"}`)
    try {
      const result = await syncContent({ hashAll: true })
      expect(result.errors).toEqual([])
      const usage = await findAssetReferences(asset.id)
      expect(usage?.documents).toEqual(expect.arrayContaining([
        expect.objectContaining({ via: 'link', title: 'External file' }),
      ]))
      expect((await findUnusedAssets({ limit: 1000 })).map((row) => row.id)).not.toContain(asset.id)
    } finally {
      await fs.rm(file)
      await syncContent({ hashAll: true })
    }
  })

  it('protects frontmatter covers and OG images even with query strings', async () => {
    const asset = await makeAsset()
    for (const metadata of [`cover: ${asset.url}?width=300\n`, `seo:\n  ogImage: ${asset.url}\n`]) {
      const file = await writeExternal('No body image', metadata)
      try {
        await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
        await expectIntact(asset)
      } finally { await fs.rm(file) }
    }
  })

  it.each(['cover', 'ogImage'] as const)('reports a synced %s using a same-origin URL with query and fragment', async (field) => {
    const asset = await makeAsset()
    const href = new URL(`${asset.url}?width=300#image`, env.SITE_URL).toString()
    const metadata = field === 'cover' ? `cover: ${href}\n` : `seo:\n  ogImage: ${href}\n`
    const file = await writeExternal('Metadata reference', metadata)
    try {
      const result = await syncContent({ hashAll: true })
      expect(result.errors).toEqual([])
      expect((await findAssetReferences(asset.id))?.documents).toEqual(expect.arrayContaining([
        expect.objectContaining({ via: field, title: 'External file' }),
      ]))
      expect((await findUnusedAssets({ limit: 1000 })).map((row) => row.id)).not.toContain(asset.id)
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally {
      await fs.rm(file)
      await syncContent({ hashAll: true })
    }
  })

  it('protects and reports a site avatar using an absolute URL with query', async () => {
    const asset = await makeAsset()
    const [previous] = await db.select().from(siteSettings).limit(1)
    const id = previous?.id ?? 'default'
    try {
      await db.insert(siteSettings).values({
        id, avatarUrl: new URL(`${asset.url}?width=80`, env.SITE_URL).toString(),
      }).onConflictDoUpdate({ target: siteSettings.id, set: {
        avatarUrl: new URL(`${asset.url}?width=80`, env.SITE_URL).toString(),
      } })
      expect((await findAssetReferences(asset.id))?.usedAsSiteAvatar).toBe(true)
      expect((await findUnusedAssets({ limit: 1000 })).map((row) => row.id)).not.toContain(asset.id)
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(asset)
    } finally {
      if (previous) await db.update(siteSettings).set({ avatarUrl: previous.avatarUrl }).where(eq(siteSettings.id, id))
      else await db.delete(siteSettings).where(eq(siteSettings.id, id))
    }
  })

  it('does not treat an external URL with a matching asset path as a local reference', async () => {
    const asset = await makeAsset()
    const file = await writeExternal('External image', `cover: https://foreign.example${asset.url}\n`)
    try {
      const result = await syncContent({ hashAll: true })
      expect(result.errors).toEqual([])
      expect((await findAssetReferences(asset.id))?.documents).toEqual([])
      expect((await findUnusedAssets({ limit: 1000 })).map((row) => row.id)).toContain(asset.id)
    } finally {
      await fs.rm(file)
      await syncContent({ hashAll: true })
    }
  })

  it('protects references to an image derivative rather than the original', async () => {
    const stored = await storeAsset({
      buffer: await sharp({ create: {
        width: 1000, height: 800, channels: 3,
        background: { r: 25, g: 125, b: 200 },
      } }).png().toBuffer(), originalFilename: 'derived-delete-safety.png',
    })
    created.push(stored.asset.id)
    const variant = stored.asset.variants[0]
    if (!variant) throw new Error('fixture did not produce a derivative')
    const file = await writeExternal(`<img src="${variant.url}" alt="derivative">`)
    try {
      await expect(deleteAsset(stored.asset.id)).rejects.toBeInstanceOf(AssetInUseError)
      await expectIntact(stored.asset)
    } finally { await fs.rm(file) }
  })

  it('refuses an incomplete scan even when the force flag is supplied', async () => {
    const asset = await makeAsset()
    const first = await writeExternal('one')
    const second = await writeExternal('two')
    const oldLimit = env.CONTENT_MAX_FILES
    env.CONTENT_MAX_FILES = 1
    try {
      await expect(deleteAsset(asset.id, { force: true })).rejects.toBeInstanceOf(AssetQueryError)
      await expectIntact(asset)
    } finally {
      env.CONTENT_MAX_FILES = oldLimit
      await fs.rm(first)
      await fs.rm(second)
    }
  })

  it('refuses deletion when malformed Markdown prevents reference validation', async () => {
    const asset = await makeAsset()
    const file = await writeExternal('body')
    await fs.writeFile(file, '---\ntitle: [malformed\n---\n')
    try {
      await expect(deleteAsset(asset.id)).rejects.toBeInstanceOf(AssetQueryError)
      await expectIntact(asset)
    } finally { await fs.rm(file) }
  })
})
