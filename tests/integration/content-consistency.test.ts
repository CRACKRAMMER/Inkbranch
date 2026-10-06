import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, testContentRoot } from '../setup'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { contentIndex, contentRevisions, contentTags, contentLinks, tags } from '@/lib/db/schema'
import { syncContent, syncOneDocument, checkContentDrift } from '@/lib/content/sync'
import { captureRevision, restoreRevision } from '@/lib/revision/store'
import { env } from '@/env'

const raw = (slug: string, body = 'Original text.') =>
  `---\ntitle: ${slug}\nslug: ${slug}\ndate: 2026-01-01\ntags: [Safety]\n---\n\n${body}\n`

async function write(relative: string, content: string): Promise<void> {
  const absolute = path.join(testContentRoot, relative)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, content)
}

describe.skipIf(!hasTestDatabase)('content consistency and bounded reconciliation', () => {
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
  beforeEach(async () => {
    await db.delete(contentIndex)
    await fs.rm(path.join(testContentRoot, 'posts'), { recursive: true, force: true })
    await fs.rm(path.join(testContentRoot, 'notes'), { recursive: true, force: true })
    await fs.rm(path.join(testContentRoot, 'projects'), { recursive: true, force: true })
  })
  afterEach(async () => { await db.delete(contentIndex) })

  it('retains unscanned index rows and their revision history on a truncated sync', async () => {
    await write('posts/first.md', raw('first', 'Links to [[last]].'))
    await write('notes/last.md', raw('last'))
    await syncContent({ hashAll: true })
    const last = await syncOneDocument('notes/last.md')
    expect(last).not.toBeNull()
    const revision = await captureRevision({
      contentId: last!.row.id, type: 'note', slug: 'last', data: { title: 'last' },
      body: 'Replacement.', previousContent: raw('last'), reason: 'save',
    })
    expect(revision.captured).toBe(true)

    const report = await syncContent({ hashAll: true, maxFiles: 1 })
    expect(report.truncated).toBe(true)
    expect(report.deleted).toBe(0)
    expect(report.errors).toEqual([])
    expect((await db.select().from(contentIndex))).toHaveLength(2)
    expect((await db.select().from(contentRevisions).where(eq(contentRevisions.contentId, last!.row.id)))).toHaveLength(1)
    expect((await db.select().from(contentLinks)).every((link) => link.resolved)).toBe(true)
  })

  it('syncs a saved document beyond the scan cap without deleting its row', async () => {
    await write('posts/first.md', raw('first'))
    await write('notes/last.md', raw('last'))
    await syncContent({ hashAll: true })
    const limit = env.CONTENT_MAX_FILES
    env.CONTENT_MAX_FILES = 1
    try {
      await write('notes/last.md', raw('last', 'Updated content outside the scan.'))
      const synced = await syncOneDocument('notes/last.md')
      expect(synced?.document.body).toContain('Updated content outside the scan.')
      expect(synced?.row.checksum).toBe(synced?.document.checksum)
    } finally {
      env.CONTENT_MAX_FILES = limit
    }
  })

  it('keeps the document identity, history and links when its file is renamed', async () => {
    await write('posts/original.md', raw('stable-slug'))
    await write('notes/source.md', raw('source', '[[stable-slug]]'))
    await syncContent({ hashAll: true })
    const before = await syncOneDocument('posts/original.md')
    const revision = await captureRevision({
      contentId: before!.row.id, type: 'post', slug: 'stable-slug', data: { title: 'stable-slug' },
      body: 'New body.', previousContent: raw('stable-slug'), reason: 'save',
    })
    expect(revision.captured).toBe(true)
    await fs.rename(path.join(testContentRoot, 'posts/original.md'), path.join(testContentRoot, 'posts/renamed.md'))
    const report = await syncContent({ hashAll: true })
    expect(report.errors).toEqual([])
    const renamed = await syncOneDocument('posts/renamed.md')
    expect(renamed?.row.id).toBe(before?.row.id)
    expect((await db.select().from(contentRevisions).where(eq(contentRevisions.contentId, before!.row.id)))).toHaveLength(1)
    expect((await db.select().from(contentLinks)).every((link) => link.resolved)).toBe(true)
  })

  it('serializes concurrent full and targeted syncs without duplicate inserts or associations', async () => {
    await write('posts/target.md', raw('target'))
    await write('notes/source.md', raw('source', '[[target]]'))
    const reports = await Promise.all([
      syncContent({ hashAll: true }), syncContent({ hashAll: true }), syncOneDocument('notes/source.md'),
    ])
    expect(reports.slice(0, 2).every((report) => report && 'errors' in report && report.errors.length === 0)).toBe(true)
    expect((await db.select().from(contentIndex))).toHaveLength(2)
    expect((await db.select().from(contentTags))).toHaveLength(2)
    expect((await db.select().from(contentLinks))).toHaveLength(1)
    expect((await db.select().from(contentLinks))[0]?.resolved).toBe(true)
  })

  it('detects an external edit made within one second with the same byte size', async () => {
    await write('posts/rapid.md', raw('rapid', 'AAAA'))
    const file = path.join(testContentRoot, 'posts/rapid.md')
    const instant = new Date('2026-01-01T00:00:00.000Z')
    await fs.utimes(file, instant, instant)
    await syncContent({ hashAll: true })
    await write('posts/rapid.md', raw('rapid', 'BBBB'))
    const updated = new Date(instant.getTime() + 250)
    await fs.utimes(file, updated, updated)
    expect((await checkContentDrift()).drift).toBe(true)
    const report = await syncContent()
    expect(report.updated).toBe(1)
  })

  it('reconciles tags and links after a sync is interrupted after updating the checksum', async () => {
    await write('posts/source.md', raw('source'))
    await write('notes/target.md', raw('target'))
    await syncContent({ hashAll: true })
    await write('posts/source.md', raw('source', '[[target]]').replace('[Safety]', '[Newest]'))
    // The first delete is the tag-association refresh, after index row writes.
    const failure = vi.spyOn(db, 'delete').mockImplementationOnce(() => {
      throw new Error('simulated metadata interruption')
    })
    try {
      await expect(syncContent({ hashAll: true })).rejects.toThrow('simulated metadata interruption')
    } finally {
      failure.mockRestore()
    }
    const retry = await syncContent({ hashAll: true })
    expect(retry.errors).toEqual([])
    expect(retry.unchanged).toBe(2)
    const association = await db.select({ name: tags.name }).from(contentTags)
      .innerJoin(tags, eq(tags.id, contentTags.tagId))
      .innerJoin(contentIndex, eq(contentIndex.id, contentTags.contentId))
      .where(eq(contentIndex.path, 'posts/source.md'))
    expect(association.map((row) => row.name)).toEqual(['Newest'])
    expect((await db.select().from(contentLinks))).toMatchObject([{ resolved: true, targetKey: 'target' }])
  })

  it('refuses a malformed revision before modifying the readable original file', async () => {
    const original = raw('restore-safe')
    await write('posts/restore-safe.md', original)
    const synced = await syncOneDocument('posts/restore-safe.md')
    const revision = await captureRevision({
      contentId: synced!.row.id, type: 'post', slug: 'restore-safe', data: { title: 'Valid' },
      body: 'Valid replacement.', previousContent: '---\ntitle: [unterminated\n---\n\nMalformed snapshot.\n', reason: 'save',
    })
    expect(revision.captured).toBe(true)
    await expect(restoreRevision(revision.revisionId!)).rejects.toThrow('nothing was written')
    expect(await fs.readFile(path.join(testContentRoot, 'posts/restore-safe.md'), 'utf8')).toBe(original)
    expect((await syncOneDocument('posts/restore-safe.md'))?.row.checksum).toBe(synced?.row.checksum)
  })

  it('refuses an old revision slug claimed by another external file before writing or capturing a revision', async () => {
    const snapshot = raw('old-slug', 'State A.')
    await write('posts/restore-target.md', snapshot)
    const synced = await syncOneDocument('posts/restore-target.md')
    const revision = await captureRevision({
      contentId: synced!.row.id, type: 'post', slug: 'old-slug', data: { title: 'B' },
      body: 'State B.', previousContent: snapshot, reason: 'save',
    })
    expect(revision.captured).toBe(true)
    // External changes have not yet been synced: the database still says
    // old-slug, but the live target is new-slug and another file claims old-slug.
    const current = raw('new-slug', 'Current external edit.')
    const claimed = raw('old-slug', 'A separate external file.')
    await write('posts/restore-target.md', current)
    await write('posts/claimed.md', claimed)
    await expect(restoreRevision(revision.revisionId!)).rejects.toThrow('already uses the slug')
    expect(await fs.readFile(path.join(testContentRoot, 'posts/restore-target.md'), 'utf8')).toBe(current)
    expect(await fs.readFile(path.join(testContentRoot, 'posts/claimed.md'), 'utf8')).toBe(claimed)
    expect(await db.select().from(contentRevisions)).toHaveLength(1)
    const report = await syncContent({ hashAll: true })
    expect(report.errors).toEqual([])
    expect(report).toMatchObject({ added: 1, updated: 1 })
    expect((await db.select().from(contentIndex)).map((row) => row.slug).sort()).toEqual(['new-slug', 'old-slug'])
  })

  it('reconciles swapped external slugs in one pass while preserving both identities and revision histories', async () => {
    await write('posts/first.md', raw('first-slug'))
    await write('posts/second.md', raw('second-slug'))
    await syncContent({ hashAll: true })
    const initial = await db.select().from(contentIndex)
    for (const row of initial) {
      await captureRevision({
        contentId: row.id, type: 'post', slug: row.slug, data: { title: 'New' }, body: 'New body',
        previousContent: raw(row.slug), reason: 'save',
      })
    }
    await write('posts/first.md', raw('second-slug', 'First file changed externally.'))
    await write('posts/second.md', raw('first-slug', 'Second file changed externally.'))
    const report = await syncContent({ hashAll: true })
    expect(report).toMatchObject({ added: 0, updated: 2, deleted: 0, errors: [] })
    const updated = await db.select().from(contentIndex)
    expect(updated.find((row) => row.path === 'posts/first.md'))
      .toMatchObject({ id: initial.find((row) => row.path === 'posts/first.md')!.id, slug: 'second-slug' })
    expect(updated.find((row) => row.path === 'posts/second.md'))
      .toMatchObject({ id: initial.find((row) => row.path === 'posts/second.md')!.id, slug: 'first-slug' })
    expect(await db.select().from(contentRevisions)).toHaveLength(2)
    expect((await syncContent({ hashAll: true })).unchanged).toBe(2)
  })

  it('rolls back temporary slug names when reassignment is interrupted and recovers on retry', async () => {
    await write('posts/first.md', raw('first-slug'))
    await write('posts/second.md', raw('second-slug'))
    await syncContent({ hashAll: true })
    const original = await db.select().from(contentIndex)
    await write('posts/first.md', raw('second-slug'))
    await write('posts/second.md', raw('first-slug'))
    const runTransaction = db.transaction.bind(db)
    const failure = vi.spyOn(db, 'transaction').mockImplementationOnce((callback, options) =>
      runTransaction(async (transaction) => {
        const update = transaction.update.bind(transaction)
        let calls = 0
        const failingUpdate: typeof transaction.update = (table) => {
          calls += 1
          if (calls === 3) throw new Error('simulated reassignment interruption')
          return update(table)
        }
        const spy = vi.spyOn(transaction, 'update').mockImplementation(failingUpdate)
        try { return await callback(transaction) } finally { spy.mockRestore() }
      }, options),
    )
    try {
      await expect(syncContent({ hashAll: true })).rejects.toThrow('simulated reassignment interruption')
    } finally { failure.mockRestore() }
    const after = await db.select().from(contentIndex)
    expect(after.map((row) => [row.id, row.slug, row.checksum]).sort())
      .toEqual(original.map((row) => [row.id, row.slug, row.checksum]).sort())
    const retry = await syncContent({ hashAll: true })
    expect(retry).toMatchObject({ updated: 2, errors: [] })
  })
})
