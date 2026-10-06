import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, testContentRoot } from '../setup'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { users, contentIndex, contentRevisions } from '@/lib/db/schema'
import * as writer from '@/lib/content/writer'
import * as sync from '@/lib/content/sync'
import { RECOVERY_DIR } from '@/lib/content/paths'
import { readDocument, scanContentFiles } from '@/lib/content/reader'
import { syncOneDocument } from '@/lib/content/sync'
import { bulkContentAction, createContentAction, deleteContentAction, saveContentAction } from '@/app/admin/actions/content'
import { formValuesFromFrontmatter } from '@/lib/admin/frontmatter-form'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { captureRevision } from '@/lib/revision/store'
import { restoreRevisionAction } from '@/app/admin/actions/revisions'
import * as adminQueries from '@/lib/admin/queries'

const guard = vi.hoisted(() => ({ actorId: '' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/admin/guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/admin/guard')>(),
  guardAction: async () => ({ user: { id: guard.actorId }, request: undefined }),
}))

const paths: string[] = []
async function document(slug: string, extension = 'md', status = 'draft', filename = slug) {
  const relative = `posts/${filename}.${extension}`
  const absolute = path.join(testContentRoot, relative)
  const raw = `---\ntitle: ${slug}\nslug: ${slug}\ndate: 2026-01-01\nstatus: ${status}\ntags: [Original]\n---\n\nOld body.\n`
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, raw)
  paths.push(relative)
  await syncOneDocument(relative)
  return { relative, absolute, raw }
}

describe.skipIf(!hasTestDatabase)('content actions preserve concurrent filesystem edits', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    guard.actorId = randomUUID()
    await db.insert(users).values({ id: guard.actorId, email: `${guard.actorId}@test.invalid`, name: 'Disposable author', passwordHash: 'unused-test-hash' })
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    for (const relative of paths) {
      await db.delete(contentIndex).where(eq(contentIndex.path, relative))
      await fs.rm(path.join(testContentRoot, relative), { force: true })
    }
    await db.delete(users).where(eq(users.id, guard.actorId))
  })

  it('publishes the freshly read body instead of overwriting an intervening edit', async () => {
    const fixture = await document('bulk-publish-concurrent')
    const update = writer.updateDocument
    vi.spyOn(writer, 'updateDocument').mockImplementationOnce(async (relative, mutate) => {
      await fs.writeFile(fixture.absolute, fixture.raw.replace('Old body.', 'External body.'))
      return update(relative, mutate)
    })
    const result = await bulkContentAction({ paths: [fixture.relative], action: 'publish' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.failed).toEqual([])
    const saved = await readDocument(fixture.relative)
    expect(saved?.status).toBe('published')
    expect(saved?.body).toContain('External body.')
    vi.restoreAllMocks()
  })

  it('adds a tag while preserving intervening body and tag edits', async () => {
    const fixture = await document('bulk-tag-concurrent')
    const update = writer.updateDocument
    vi.spyOn(writer, 'updateDocument').mockImplementationOnce(async (relative, mutate) => {
      await fs.writeFile(fixture.absolute, fixture.raw.replace('Old body.', 'External body.').replace('[Original]', '[Original, External]'))
      return update(relative, mutate)
    })
    const result = await bulkContentAction({ paths: [fixture.relative], action: 'add-tag', tag: 'Requested' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.failed).toEqual([])
    const saved = await readDocument(fixture.relative)
    expect(saved?.tags).toEqual(['Original', 'External', 'Requested'])
    expect(saved?.body).toContain('External body.')
    vi.restoreAllMocks()
  })

  it('edits an imported .MARKDOWN file and records an edit rather than a new publication', async () => {
    const fixture = await document('legacy-extension', 'MARKDOWN', 'published', 'legacy..filename')
    const current = await readDocument(fixture.relative)
    const parsed = parseFrontmatter(fixture.raw)
    const result = await saveContentAction({
      path: fixture.relative, baseChecksum: current!.checksum,
      values: formValuesFromFrontmatter(parsed.data, { status: 'published' }), body: 'Updated published body.\n',
    })
    expect(result.ok).toBe(true)
    expect((await readDocument(fixture.relative))?.body).toContain('Updated published body.')
    const revisions = await db.select().from(contentRevisions)
    expect(revisions.some((revision) => revision.summary.startsWith('Edited'))).toBe(true)
  })

  it('refuses concurrent renames of different documents to the same slug before changing both files', async () => {
    const fixtures = await Promise.all([document('rename-first'), document('rename-second')])
    const originalQuery = adminQueries.takenSlugs
    let checks = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const query = vi.spyOn(adminQueries, 'takenSlugs').mockImplementation(async (...args) => {
      const result = await originalQuery(...args)
      checks += 1
      if (checks === 2) release()
      await barrier
      return result
    })
    try {
      await Promise.all(fixtures.map(async (fixture) => {
        const current = await readDocument(fixture.relative)
        const values = formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' })
        return saveContentAction({
          path: fixture.relative, baseChecksum: current!.checksum,
          values: { ...values, slug: 'one-shared-slug' }, body: current!.body,
        })
      }))
    } finally {
      query.mockRestore()
    }
    const saved = await Promise.all(fixtures.map((fixture) => readDocument(fixture.relative)))
    expect(saved.filter((document) => document?.slug === 'one-shared-slug')).toHaveLength(1)
  })

  it('refuses a slug held by an external file that has not been indexed', async () => {
    const fixture = await document('indexed-original')
    const externalPath = 'posts/external-unindexed.md'
    paths.push(externalPath)
    await fs.writeFile(path.join(testContentRoot, externalPath),
      '---\ntitle: External\nslug: external-claimed-slug\ndate: 2026-01-01\n---\n\nExternal body.\n')
    const current = await readDocument(fixture.relative)
    const values = formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' })
    const result = await saveContentAction({
      path: fixture.relative, baseChecksum: current!.checksum,
      values: { ...values, slug: 'external-claimed-slug' }, body: current!.body,
    })
    expect(result.ok).toBe(false)
    expect(await fs.readFile(fixture.absolute, 'utf8')).toBe(fixture.raw)
  })

  it('reports a committed save, preserves its exact previous bytes privately, and recovers on checksum-safe retry', async () => {
    const fixture = await document('save-index-failure')
    const current = await readDocument(fixture.relative)
    const values = formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' })
    vi.spyOn(adminQueries, 'contentRowByPath').mockRejectedValueOnce(new Error('injected post-write database failure'))
    const failed = await saveContentAction({ path: fixture.relative, baseChecksum: current!.checksum, values, body: 'Committed new body.\n' })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('Expected a follow-up failure')
    expect(failed.code).toBe('content-committed')
    expect(failed.error).toContain('file was saved')
    expect(failed.error).not.toContain('Nothing was changed')
    const receipt = failed.committed![0]!
    const backup = path.join(testContentRoot, receipt.recoveryPath!)
    expect(await fs.readFile(backup, 'utf8')).toBe(fixture.raw)
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(RECOVERY_DIR)).mode & 0o777).toBe(0o700)
    expect((await readDocument(fixture.relative, { fresh: true }))?.checksum).toBe(receipt.checksum)
    vi.restoreAllMocks()
    const retried = await saveContentAction({ path: fixture.relative, baseChecksum: receipt.checksum!, values, body: 'Committed new body.\n' })
    expect(retried.ok).toBe(true)
    expect((await adminQueries.contentRowByPath(fixture.relative))?.checksum).toBe(receipt.checksum)
    const row = await adminQueries.contentRowByPath(fixture.relative)
    expect(await db.select().from(contentRevisions).where(eq(contentRevisions.contentId, row!.id))).toEqual([])
    // A later successful save must not remove a previous failed save's only copy.
    expect(await fs.readFile(backup, 'utf8')).toBe(fixture.raw)
  })

  it('refuses to modify the original when staging its previous bytes fails', async () => {
    const fixture = await document('recovery-preparation-failure')
    const current = await readDocument(fixture.relative)
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename).includes(`${path.sep}.recovery${path.sep}.tmp-`)) throw Object.assign(new Error('injected full recovery disk'), { code: 'ENOSPC' })
      return open(filename, flags, mode)
    })
    try {
      const result = await saveContentAction({
        path: fixture.relative, baseChecksum: current!.checksum,
        values: formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' }), body: 'Must not replace the original.\n',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.committed).toBeUndefined()
        expect(result.error).toContain('original file was not modified')
      }
      expect(await fs.readFile(fixture.absolute, 'utf8')).toBe(fixture.raw)
    } finally { vi.restoreAllMocks() }
  })

  it('retains previous bytes when revision capture returns a failure instead of throwing', async () => {
    const fixture = await document('revision-capture-failure')
    const current = await readDocument(fixture.relative)
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('injected revision transaction failure'))
    const result = await saveContentAction({
      path: fixture.relative, baseChecksum: current!.checksum,
      values: formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' }), body: 'Written despite failed history.\n',
    })
    vi.restoreAllMocks()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected a history failure')
    expect(result.code).toBe('content-committed')
    expect(await fs.readFile(path.join(testContentRoot, result.committed![0]!.recoveryPath!), 'utf8')).toBe(fixture.raw)
    expect((await readDocument(fixture.relative, { fresh: true }))?.body).toContain('Written despite failed history.')
  })

  it('never rolls back a newer external edit after the save has reached disk', async () => {
    const fixture = await document('external-edit-after-commit')
    const current = await readDocument(fixture.relative)
    const external = fixture.raw.replace('Old body.', 'Newer external body.')
    vi.spyOn(adminQueries, 'contentRowByPath').mockImplementationOnce(async () => {
      await fs.writeFile(fixture.absolute, external)
      throw new Error('injected index failure after an external edit')
    })
    const values = formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' })
    const result = await saveContentAction({ path: fixture.relative, baseChecksum: current!.checksum, values, body: 'Editor body.\n' })
    vi.restoreAllMocks()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected a follow-up failure')
    expect(await fs.readFile(fixture.absolute, 'utf8')).toBe(external)
    const receipt = result.committed![0]!
    expect(await fs.readFile(path.join(testContentRoot, receipt.recoveryPath!), 'utf8')).toBe(fixture.raw)
    const retried = await saveContentAction({ path: fixture.relative, baseChecksum: receipt.checksum!, values, body: 'Editor body.\n' })
    expect(retried.ok).toBe(false)
    if (!retried.ok) expect(retried.code).toBe('stale')
    expect(await fs.readFile(fixture.absolute, 'utf8')).toBe(external)
  })

  it('reports a file created before a sync failure and permits later index recovery', async () => {
    const relative = 'posts/create-sync-failure.md'
    paths.push(relative)
    vi.spyOn(sync, 'syncOneDocument').mockRejectedValueOnce(new Error('injected create sync failure'))
    const result = await createContentAction({ type: 'post', title: 'Create sync failure', slug: 'create-sync-failure', status: 'draft', date: '2026-01-01' })
    vi.restoreAllMocks()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected a sync failure')
    expect(result.code).toBe('content-committed')
    expect(result.committed![0]!.path).toBe(relative)
    expect((await readDocument(relative))?.slug).toBe('create-sync-failure')
    await syncOneDocument(relative)
    expect((await adminQueries.contentRowByPath(relative))?.checksum).toBe(result.committed![0]!.checksum)
  })

  it('reports a completed deletion and retains its bytes if index removal fails', async () => {
    const fixture = await document('delete-index-failure')
    vi.spyOn(sync, 'removeFromIndex').mockRejectedValueOnce(new Error('injected delete index failure'))
    const result = await deleteContentAction({ path: fixture.relative })
    vi.restoreAllMocks()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected an index failure')
    expect(result.error).toContain('file was deleted')
    expect(result.committed![0]!.operation).toBe('delete')
    expect(await fs.readFile(path.join(testContentRoot, result.committed![0]!.recoveryPath!), 'utf8')).toBe(fixture.raw)
    await expect(fs.stat(fixture.absolute)).rejects.toMatchObject({ code: 'ENOENT' })
    await sync.removeFromIndex(fixture.relative)
    expect(await adminQueries.contentRowByPath(fixture.relative)).toBeNull()
  })

  it('retains the replaced file and reports a committed restore when its undo revision fails', async () => {
    const fixture = await document('restore-undo-failure')
    const row = await adminQueries.contentRowByPath(fixture.relative)
    const captured = await captureRevision({
      contentId: row!.id, type: 'post', slug: 'restore-undo-failure',
      data: parseFrontmatter(fixture.raw).data, body: 'A different current body.\n',
      previousContent: fixture.raw, reason: 'save', actorId: guard.actorId,
    })
    expect(captured.captured).toBe(true)
    const newer = fixture.raw.replace('Old body.', 'File before restore.')
    await writer.writeRawDocument(fixture.relative, newer)
    await syncOneDocument(fixture.relative)
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('injected undo revision failure'))
    const result = await restoreRevisionAction({ revisionId: captured.revisionId! })
    vi.restoreAllMocks()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected a failed undo capture')
    expect(result.code).toBe('content-committed')
    const receipt = result.committed![0]!
    expect(result.detail).toContain(receipt.recoveryPath)
    expect(await fs.readFile(fixture.absolute, 'utf8')).toBe(fixture.raw)
    expect(await fs.readFile(path.join(testContentRoot, receipt.recoveryPath!), 'utf8')).toBe(newer)
    expect(await db.select().from(contentRevisions).where(eq(contentRevisions.contentId, row!.id))).toHaveLength(1)
  })

  it.each(['publish', 'unpublish', 'add-tag', 'delete'] as const)('reports partial bulk %s mutations with a recoverable previous file', async (action) => {
    const fixture = await document(`bulk-${action}-index-failure`, 'md', action === 'unpublish' ? 'published' : 'draft')
    if (action === 'delete') vi.spyOn(sync, 'removeFromIndex').mockRejectedValueOnce(new Error('injected bulk delete sync failure'))
    else vi.spyOn(sync, 'syncOneDocument').mockRejectedValueOnce(new Error('injected bulk write sync failure'))
    const result = await bulkContentAction({ paths: [fixture.relative], action, ...(action === 'add-tag' ? { tag: 'Requested' } : {}) })
    vi.restoreAllMocks()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected a per-file bulk report')
    expect(result.data.failed).toHaveLength(1)
    const failure = result.data.failed[0]!
    expect(failure.error).toContain(action === 'delete' ? 'file was deleted' : 'file was saved')
    expect(await fs.readFile(path.join(testContentRoot, failure.committed!.recoveryPath!), 'utf8')).toBe(fixture.raw)
  })

  it('cleans its own recovery snapshots after a normal save and intentional deletion', async () => {
    const fixture = await document('successful-recovery-cleanup')
    const before = new Set(await fs.readdir(RECOVERY_DIR))
    const current = await readDocument(fixture.relative)
    const result = await saveContentAction({
      path: fixture.relative, baseChecksum: current!.checksum,
      values: formValuesFromFrontmatter(parseFrontmatter(fixture.raw).data, { status: 'draft' }), body: 'Successful normal save.\n',
    })
    expect(result.ok).toBe(true)
    expect(new Set(await fs.readdir(RECOVERY_DIR))).toEqual(before)
    expect((await deleteContentAction({ path: fixture.relative })).ok).toBe(true)
    expect(new Set(await fs.readdir(RECOVERY_DIR))).toEqual(before)
    expect((await scanContentFiles()).some((file) => file.relativePath.includes('.recovery'))).toBe(false)
  })
})
