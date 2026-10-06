import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasTestDatabase, testContentRoot } from '../setup'
import { runMigrations } from '@/lib/db/migrate'

/**
 * Renaming and merging a tag — and the count the operator is shown first.
 *
 * A tag lives in the frontmatter of every document carrying it, so each
 * operation in `src/lib/admin/tags.ts` is a multi-file edit that the admin
 * decides about from a single number. The merge dialog states that number
 * ("“Linux” will end up on 3 documents"), and the sentence is only worth
 * reading if the number is the one the rewrite produces — so this file asserts
 * the count and the run against each other, over real Markdown files and a real
 * index, rather than against either alone.
 *
 * The tag names are unique to this file. Integration tests share one database,
 * and a count taken over a tag another file also uses would be a count of that
 * file's fixtures too.
 */

const POSTS = path.join(testContentRoot, 'posts')

const BOTH = 'posts/tag-carries-both.md'
const FROM_ONLY = 'posts/tag-carries-from-only.md'
const INTO_ONLY = 'posts/tag-carries-into-only.md'

const FROM = { slug: 'from-tag', name: 'From Tag' }
const INTO = { slug: 'into-tag', name: 'Into Tag' }
const RENAMED = { slug: 'renamed-tag', name: 'Renamed Tag' }

const FIXTURES: Record<string, string> = {
  [BOTH]: `---
title: Carries Both
date: 2026-09-11
tags: [From Tag, Into Tag]
---

Already carries the destination, so a merge takes a tag away from this one.
`,
  [FROM_ONLY]: `---
title: Carries From Only
date: 2026-09-11
tags: [From Tag]
---

The plain case: the tag is replaced.
`,
  [INTO_ONLY]: `---
title: Carries Into Only
date: 2026-09-11
tags: [Into Tag]
---

Carries the destination and nothing else, so no merge of the source should
touch this file at all.
`,
}

describe.skipIf(!hasTestDatabase)('tag operations with real files', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await fs.mkdir(POSTS, { recursive: true })
    for (const [relativePath, source] of Object.entries(FIXTURES)) {
      await fs.writeFile(path.join(testContentRoot, relativePath), source, 'utf8')
    }

    const { syncContent } = await import('@/lib/content/sync')
    const report = await syncContent({ hashAll: true })
    expect(report.errors).toEqual([])
  })

  afterAll(async () => {
    const { removeFromIndex, pruneOrphanTags } = await import('@/lib/content/sync')
    const { db } = await import('@/lib/db')
    const { tags } = await import('@/lib/db/schema')
    const { inArray } = await import('drizzle-orm')

    // The row first: `removeFromIndex` is what makes the index agree with the
    // filesystem, and it cascades to the tag links.
    for (const relativePath of Object.keys(FIXTURES)) {
      await removeFromIndex(relativePath).catch(() => undefined)
    }
    await db
      .delete(tags)
      .where(inArray(tags.slug, [FROM.slug, INTO.slug, RENAMED.slug]))
      .catch(() => undefined)
    await pruneOrphanTags().catch(() => undefined)

    await fs.rm(POSTS, { recursive: true, force: true })
  })

  async function read(relativePath: string): Promise<string> {
    return fs.readFile(path.join(testContentRoot, relativePath), 'utf8')
  }

  it('counts the union of the two tags, not the sum, and says how many overlap', async () => {
    const { tagChangeImpact } = await import('@/lib/admin/tags')

    // Three documents carry one tag or the other; two of them carry the source,
    // and one of those already carries the destination. The sum of the two
    // counts on the page (2 + 2) would be 4, which is why the dialog asks.
    expect(await tagChangeImpact(FROM.slug, INTO.slug)).toEqual({
      documents: 3,
      carrying: 2,
      overlapping: 1,
    })
  })

  it('rewrites exactly the documents the count named, and leaves the rest byte for byte', async () => {
    const { rewriteTag, tagChangeImpact } = await import('@/lib/admin/tags')

    const before = await tagChangeImpact(FROM.slug, INTO.slug)
    const report = await rewriteTag({ mode: 'merge', from: FROM, to: INTO })

    expect(report.failed).toEqual([])
    expect(report.sync.ok).toBe(true)
    expect(report.written.map((entry) => entry.path).sort()).toEqual([BOTH, FROM_ONLY])
    // The number the dialog showed is the number of files that changed.
    expect(report.written).toHaveLength(before.carrying)
    // Both halves of the destination, and the slug is the one the tag row will
    // have: the frontmatter rewrite only ever reads the name, so a report that
    // named the source's slug here would still write every file correctly and
    // send the operator to a tag that no longer exists.
    expect(report.to).toEqual({ slug: INTO.slug, name: INTO.name })

    const both = await read(BOTH)
    expect(both).toContain('Into Tag')
    expect(both).not.toContain('From Tag')
    // It carried both already: the merge takes one away rather than adding one.
    expect(both.match(/Into Tag/g)).toHaveLength(1)

    const fromOnly = await read(FROM_ONLY)
    expect(fromOnly).toContain('Into Tag')
    expect(fromOnly).not.toContain('From Tag')

    // Never carried the source, so no merge of it may touch this file.
    expect(await read(INTO_ONLY)).toBe(FIXTURES[INTO_ONLY])

    // A merge moves documents between tags; it cannot create or destroy one.
    const after = await tagChangeImpact(FROM.slug, INTO.slug)
    expect(after).toEqual({ documents: before.documents, carrying: 0, overlapping: 0 })
  })

  it('drops the tag row once nothing references it', async () => {
    const { db } = await import('@/lib/db')
    const { tags } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')

    const rows = await db.select().from(tags).where(eq(tags.slug, FROM.slug))
    expect(rows).toEqual([])
  })

  it('does not double count a tag merged into itself', async () => {
    const { tagChangeImpact } = await import('@/lib/admin/tags')

    // Every document carrying the destination overlaps with itself, which the
    // plain union/overlap arithmetic would report as three documents that would
    // each lose a tag. Nothing is lost when source and destination are the same.
    expect(await tagChangeImpact(INTO.slug, INTO.slug)).toEqual({
      documents: 3,
      carrying: 3,
      overlapping: 0,
    })
  })

  it('rewrites every carrier on a rename, and the new slug is the one that survives', async () => {
    const { rewriteTag, tagChangeImpact } = await import('@/lib/admin/tags')

    const before = await tagChangeImpact(INTO.slug, RENAMED.slug)
    expect(before).toEqual({ documents: 3, carrying: 3, overlapping: 0 })

    const report = await rewriteTag({ mode: 'rename', from: INTO, to: RENAMED })
    expect(report.failed).toEqual([])
    expect(report.written).toHaveLength(before.carrying)
    expect(report.to).toEqual(RENAMED)

    for (const relativePath of Object.keys(FIXTURES)) {
      const source = await read(relativePath)
      expect(source).toContain('Renamed Tag')
      expect(source).not.toContain('Into Tag')
    }
  })
})
