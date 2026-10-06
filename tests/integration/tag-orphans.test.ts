import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { tagSlug } from '@/lib/utils/slug'
import { hasTestDatabase, testContentRoot } from '../setup'
import { runMigrations } from '@/lib/db/migrate'

/**
 * The tag nothing carries.
 *
 * A tag's row is a projection of the `tags:` arrays in the frontmatter, so it
 * is expected to appear when a document names it and to be rebuilt when one
 * renames it. What this file is about is the state the projection does not
 * cover — a row whose tag no document carries any more — and the two ways the
 * code got it wrong.
 *
 * The first is upstream, in `syncTags`: it clears a document's tag links and
 * then returns early when the batch has no tags to insert. A document that has
 * just dropped its *last* tag is exactly the document whose links need clearing,
 * so in a corpus where nothing is tagged the links stayed and the tag went on
 * being counted against a document that no longer named it.
 *
 * The second is in `rewriteTag`, and it destroyed data. Renaming a tag no
 * document carries rewrote no files, so the sync was skipped and the prune at
 * the end dropped the row — the only copy of the tag, including the `color` and
 * `description` that have no frontmatter counterpart. Nothing recreated it, and
 * the action reported success.
 *
 * Both are invisible to a unit test: the first needs a batch whose tag set is
 * empty, and the second needs a row that survived a sync.
 */

const POSTS = path.join(testContentRoot, 'posts')

// Unique to this file: integration suites share one database and `content_index`
// is keyed by path, so two files writing `posts/x.md` would be one document.
const KEEPS = 'posts/tag-orphan-keeps.md'
const DROPS = 'posts/tag-orphan-drops.md'

/**
 * Unique to this run, where the tag names are unique to this file.
 *
 * The audit log is append-only and the database outlives a run, so a row some
 * earlier run wrote for the same tag would satisfy an assertion about a row
 * this run is supposed to write — and did, before this marker existed. The
 * slugs are derived from the names rather than written beside them, so the two
 * cannot drift.
 */
const RUN = crypto.randomUUID().slice(0, 8)
const tagged = (name: string) => ({ name: `${name} ${RUN}`, slug: tagSlug(`${name} ${RUN}`) })

const KEPT = tagged('Orphan Kept Tag')
const DROPPED = tagged('Orphan Dropped Tag')
const RENAMED = tagged('Orphan Renamed Tag')
const RENAMED_FROM_KEPT = tagged('Orphan Kept Renamed')

const COLOUR = '#0f766e'
const DESCRIPTION = 'A description that only the row holds.'

function post(title: string, tags: string[], body = 'Body.'): string {
  const list = tags.length > 0 ? `[${tags.join(', ')}]` : '[]'
  return `---\ntitle: ${title}\ndate: 2026-09-13\ntags: ${list}\n---\n\n${body}\n`
}

describe.skipIf(!hasTestDatabase)('the tag nothing carries', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await fs.mkdir(POSTS, { recursive: true })
  })

  afterAll(async () => {
    const { removeFromIndex, pruneOrphanTags } = await import('@/lib/content/sync')
    const { db } = await import('@/lib/db')
    const { tags } = await import('@/lib/db/schema')
    const { inArray } = await import('drizzle-orm')

    for (const relativePath of [KEEPS, DROPS]) {
      await removeFromIndex(relativePath).catch(() => undefined)
    }
    await db
      .delete(tags)
      .where(
        inArray(tags.slug, [KEPT.slug, DROPPED.slug, RENAMED.slug, RENAMED_FROM_KEPT.slug]),
      )
      .catch(() => undefined)
    await pruneOrphanTags().catch(() => undefined)

    await fs.rm(POSTS, { recursive: true, force: true })
  })

  async function write(keeps: string[], drops: string[]) {
    await fs.writeFile(path.join(testContentRoot, KEEPS), post('Orphan Keeps', keeps), 'utf8')
    await fs.writeFile(path.join(testContentRoot, DROPS), post('Orphan Drops', drops), 'utf8')
    const { syncContent } = await import('@/lib/content/sync')
    return syncContent({ hashAll: true })
  }

  /** How many tag links the two documents of this file hold, between them. */
  async function links(): Promise<number> {
    const { db } = await import('@/lib/db')
    const { contentIndex, contentTags } = await import('@/lib/db/schema')
    const { inArray } = await import('drizzle-orm')

    const owned = await db
      .select({ id: contentIndex.id })
      .from(contentIndex)
      .where(inArray(contentIndex.path, [KEEPS, DROPS]))

    const rows = await db
      .select({ contentId: contentTags.contentId })
      .from(contentTags)
      .where(
        inArray(
          contentTags.contentId,
          owned.map((row) => row.id),
        ),
      )
    return rows.length
  }

  it('clears the links of a document that drops its last tag, with no tags left in the batch', async () => {
    const { listAdminTags } = await import('@/lib/admin/queries')

    // One document carries the tag; the other carries nothing, so once the
    // first gives its tag up the batch has no tags in it at all.
    await write([], [DROPPED.name])
    expect(await links()).toBe(1)

    // The state the defect needed: a link to clear, and no tag anywhere in the
    // batch to put back — which is what used to return before the clearing.
    await write([], [])
    expect(await links()).toBe(0)

    // And the visible half: the tag is still listed — nothing prunes on a sync —
    // but it is now honestly counted against no document.
    const listed = (await listAdminTags()).find((tag) => tag.slug === DROPPED.slug)
    expect(listed?.contentCount).toBe(0)
  })

  it('renames the row of a tag no document carries, and keeps what only the row holds', async () => {
    const { db } = await import('@/lib/db')
    const { tags, auditLogs } = await import('@/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { rewriteTag } = await import('@/lib/admin/tags')

    // Orphan it again, and give it the two things a rewrite cannot carry.
    await write([KEPT.name], [DROPPED.name])
    await write([KEPT.name], [])
    const before = (
      await db.select().from(tags).where(eq(tags.slug, DROPPED.slug)).limit(1)
    )[0]
    expect(before).toBeDefined()
    await db
      .update(tags)
      .set({ color: COLOUR, description: DESCRIPTION })
      .where(eq(tags.slug, DROPPED.slug))

    const report = await rewriteTag({
      mode: 'rename',
      from: DROPPED,
      to: RENAMED,
      actorId: null,
    })

    expect(report.written).toEqual([])

    // The tag survives the rename, under the name it was given, and it is the
    // same row — which is what carries the colour and the description. This is
    // the assertion the defect fails: the row was pruned and nothing recreated
    // it, so every line below found `undefined`.
    const renamed = (
      await db.select().from(tags).where(eq(tags.slug, RENAMED.slug)).limit(1)
    )[0]
    expect(renamed?.id).toBe(before?.id)
    expect(renamed?.name).toBe(RENAMED.name)
    expect(renamed?.color).toBe(COLOUR)
    expect(renamed?.description).toBe(DESCRIPTION)

    // The old name is gone rather than left beside the new one.
    expect(
      await db.select().from(tags).where(eq(tags.slug, DROPPED.slug)).limit(1),
    ).toEqual([])

    // And the report says which of the two things happened, because the page
    // renders that as a sentence: "Renamed in 0 documents" was what it said
    // before, about a tag that no longer existed.
    expect(report.renamedRow).toBe(true)

    // The operation is in the log even though no document was touched. The
    // per-document rows are written by the rewrite, so when there is no rewrite
    // this row is the only trace there is.
    const rows = await db
      .select({ action: auditLogs.action, metadata: auditLogs.meta })
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, 'tag'), eq(auditLogs.targetId, DROPPED.slug)))
    expect(rows.map((row) => row.action)).toContain('tag.rename')
    expect(rows.find((row) => row.action === 'tag.rename')?.metadata).toMatchObject({
      from: DROPPED.slug,
      to: RENAMED.slug,
      documents: 0,
    })
  })

  it('records the operation for a tag documents do carry, beside their own rows', async () => {
    const { db } = await import('@/lib/db')
    const { auditLogs } = await import('@/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { rewriteTag } = await import('@/lib/admin/tags')

    await write([KEPT.name], [])
    const report = await rewriteTag({
      mode: 'rename',
      from: KEPT,
      to: RENAMED_FROM_KEPT,
      actorId: null,
    })
    expect(report.written.map((entry) => entry.path)).toEqual([KEEPS])
    expect(report.renamedRow).toBe(false)

    const rows = await db
      .select({ action: auditLogs.action, targetType: auditLogs.targetType })
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, 'tag'), eq(auditLogs.targetId, KEPT.slug)))

    // Both halves: the operation, and one row per document it rewrote.
    expect(rows.map((row) => row.action)).toContain('tag.rename')
    expect(report.written.length).toBe(1)

    const perDocument = await db
      .select({ action: auditLogs.action, metadata: auditLogs.meta })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'post.update'))
    expect(
      perDocument.some(
        (row) =>
          (row.metadata as { via?: string; tag?: string } | null)?.via === 'tag.rename' &&
          (row.metadata as { tag?: string } | null)?.tag === KEPT.slug,
      ),
    ).toBe(true)

    // Not asserted above: the `tags` row for the destination, which the sync
    // creates from the rewritten document. Left to the afterAll list below.
    const { tags } = await import('@/lib/db/schema')
    const created = await db
      .select({ slug: tags.slug })
      .from(tags)
      .where(eq(tags.slug, RENAMED_FROM_KEPT.slug))
    expect(created.map((row) => row.slug)).toEqual([RENAMED_FROM_KEPT.slug])
  })
})
