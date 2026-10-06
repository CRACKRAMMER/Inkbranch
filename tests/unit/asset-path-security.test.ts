import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { GET } from '@/app/api/assets/[...path]/route'
import { UPLOAD_ROOT, UPLOAD_TMP_DIR, persistAsset, sha256Of, storedRelativePath } from '@/lib/assets/storage'
import { prepareSvg } from '@/lib/assets/svg'
import { assertNoSymlinkPath, PathSecurityError } from '@/lib/security/paths'

const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'inkbranch-asset-jail-'))
afterAll(async () => { await fs.rm(outside, { recursive: true, force: true }) })

function requestAsset(relative: string) {
  return GET(new Request(`http://localhost:3000/api/assets/${relative}`), {
    params: Promise.resolve({ path: relative.split('/') }),
  })
}

describe('asset filesystem jail', () => {
  it('retries initialization after the unsafe directory is corrected', async () => {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true })
    await fs.symlink(outside, UPLOAD_TMP_DIR)
    try {
      await expect(persistAsset({ buffer: Buffer.from('<svg><rect/></svg>'), originalFilename: 'first.svg' }))
        .rejects.toBeInstanceOf(PathSecurityError)
    } finally { await fs.unlink(UPLOAD_TMP_DIR) }
    const stored = await persistAsset({ buffer: Buffer.from('<svg><rect/></svg>'), originalFilename: 'retry.svg' })
    expect((await requestAsset(stored.path)).status).toBe(200)
  })

  it('serves a complete stored SVG with its sandbox and correct type', async () => {
    const asset = await persistAsset({
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="12"/></svg>'),
      originalFilename: 'safe.svg',
    })
    const response = await requestAsset(asset.path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(await response.text()).toContain('<rect')
  })

  it('never serves a temporary upload', async () => {
    await fs.mkdir(UPLOAD_TMP_DIR, { recursive: true })
    await fs.writeFile(path.join(UPLOAD_TMP_DIR, 'partial.svg'), '<svg/>')
    const response = await requestAsset('.tmp/partial.svg')
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a final or intermediate symlink instead of returning outside bytes', async () => {
    const name = `secret-${randomUUID()}`
    await fs.writeFile(path.join(outside, name), 'private fixture bytes')
    await fs.symlink(path.join(outside, name), path.join(UPLOAD_ROOT, name))
    await fs.symlink(outside, path.join(UPLOAD_ROOT, `${name}-directory`))
    for (const relative of [name, `${name}-directory/${name}`]) {
      const response = await requestAsset(relative)
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('private fixture bytes')
    }
  })

  it('refuses writing through a symlinked shard and leaves the outside tree alone', async () => {
    const bytes = prepareSvg(Buffer.from(`<svg><text>${randomUUID()}</text></svg>`)).svg
    const relative = storedRelativePath(sha256Of(bytes), '.svg')
    const [first, second] = relative.split('/')
    if (!first || !second) throw new Error('missing shard')
    const shard = path.join(UPLOAD_ROOT, first, second)
    await fs.mkdir(path.dirname(shard), { recursive: true })
    await fs.symlink(outside, shard)
    try {
      await expect(persistAsset({ buffer: bytes, originalFilename: 'unsafe.svg' }))
        .rejects.toMatchObject({ code: 'ASSET_STORE', cause: expect.any(PathSecurityError) })
      await expect(fs.stat(path.join(outside, path.basename(relative)))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.unlink(shard)
    }
  })

  it('checks the temporary directory again after initialization', async () => {
    const saved = `${UPLOAD_TMP_DIR}-saved`
    await fs.rename(UPLOAD_TMP_DIR, saved)
    await fs.symlink(outside, UPLOAD_TMP_DIR)
    try {
      await expect(persistAsset({ buffer: Buffer.from('<svg><circle/></svg>'), originalFilename: 'x.svg' }))
        .rejects.toBeInstanceOf(PathSecurityError)
    } finally {
      await fs.unlink(UPLOAD_TMP_DIR)
      await fs.rename(saved, UPLOAD_TMP_DIR)
    }
  })

  it.each(['temporary directory', 'upload root'] as const)('continues uploading after the %s is recreated', async (removed) => {
    await persistAsset({ buffer: Buffer.from(`<svg><text>${randomUUID()}</text></svg>`), originalFilename: 'before.svg' })
    await fs.rm(removed === 'upload root' ? UPLOAD_ROOT : UPLOAD_TMP_DIR, { recursive: true, force: true })
    const stored = await persistAsset({ buffer: Buffer.from(`<svg><text>${randomUUID()}</text></svg>`), originalFilename: 'after.svg' })
    expect((await requestAsset(stored.path)).status).toBe(200)
    expect(await fs.readdir(UPLOAD_TMP_DIR)).toEqual([])
  })

  it('permits a configured root link while refusing traversal below it', async () => {
    const link = path.join(outside, 'configured-root')
    await fs.symlink(UPLOAD_ROOT, link)
    await expect(assertNoSymlinkPath(link, path.join(link, 'new/file.svg')))
      .resolves.toBe(path.join(link, 'new/file.svg'))
    await expect(assertNoSymlinkPath(link, path.join(link, '../secret')))
      .rejects.toBeInstanceOf(PathSecurityError)
  })
})
