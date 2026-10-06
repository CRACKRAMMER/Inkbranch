import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasTestDatabase, testContentRoot } from '../setup'
import { runMigrations } from '@/lib/db/migrate'

/**
 * End-to-end reconciliation: real Markdown files on disk, a real database
 * index, and `syncContent` as the only thing connecting them.
 *
 * The three defects this file exists to prevent were all invisible to unit
 * tests, because each was a disagreement *between* two components that are
 * individually correct — the extractor never saw the frontmatter, the resolver
 * never saw the candidates, and the stored column never agreed with the counter
 * beside it. Only running the real thing over real files catches that.
 */

const POSTS = path.join(testContentRoot, 'posts')
const NOTES = path.join(testContentRoot, 'notes')

/**
 * A note whose filename and title differ, which is the case that broke.
 *
 * The slug is derived from the title, so the document is reachable as
 * `notes/an-empty-catch-block-is-a-claim-that-nothing-can-go-wrong` — while
 * every human who writes a link to it will write `[[why-not-catch]]`, the name
 * of the file sitting right there in the directory.
 */
const NOTE = `---
title: An empty catch block is a claim that nothing can go wrong
date: 2026-05-19
tags: [Engineering]
---

Swallowing an error deletes information at the one moment it exists. See
[[atomic-writes]] for the same argument applied to the write path.
`

const POST = `---
title: Atomic File Writes
slug: atomic-writes
description: A summary that mentions [[why-not-catch]] in passing.
date: 2026-09-11
tags: [Linux, Systems]
---

The short version of [[why-not-catch]] is that a failure the UI can state
precisely is worth more than one it merely survives.

A link to a document that does not exist: [[no-such-note]].
`

/**
 * A document that names the same target three times, two ways.
 *
 * Written for the row count below: repetition is ordinary — a piece of writing
 * refers back to the same note in several sections — and the two spellings are
 * the case that has to stay two rows, because they resolve by different routes
 * and one can break while the other still works.
 */
const REPETITIVE = `---
title: Repetitive
date: 2026-09-12
tags: [Engineering]
---

Naming it as a wiki link twice: [[atomic-writes]] and again [[atomic-writes]],
and once by its route: [the post](/posts/atomic-writes).
`

describe.skipIf(!hasTestDatabase)('content sync with real files', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await fs.mkdir(POSTS, { recursive: true })
    await fs.mkdir(NOTES, { recursive: true })
    await fs.writeFile(path.join(POSTS, 'atomic-writes.md'), POST, 'utf8')
    await fs.writeFile(path.join(NOTES, 'why-not-catch.md'), NOTE, 'utf8')
    await fs.writeFile(path.join(NOTES, 'repetitive.md'), REPETITIVE, 'utf8')
  })

  afterAll(async () => {
    const { db } = await import('@/lib/db')
    const { contentIndex } = await import('@/lib/db/schema')
    const { inArray } = await import('drizzle-orm')

    await db
      .delete(contentIndex)
      .where(
        inArray(contentIndex.path, [
          'posts/atomic-writes.md',
          'notes/why-not-catch.md',
          'notes/repetitive.md',
        ]),
      )

    await fs.rm(POSTS, { recursive: true, force: true })
    await fs.rm(NOTES, { recursive: true, force: true })
  })

  it('resolves a wiki link written as the filename, not the derived slug', async () => {
    const { syncContent } = await import('@/lib/content/sync')

    const report = await syncContent({ hashAll: true })
    expect(report.errors).toEqual([])

    const { getContentLinks } = await import('./helpers')
    const links = await getContentLinks()

    const filenameLink = links.find(
      (link) => link.sourcePath === 'posts/atomic-writes.md' && link.href === 'why-not-catch',
    )

    expect(filenameLink).toBeDefined()
    expect(filenameLink?.targetPath).toBe('notes/why-not-catch.md')
  })

  it('stores `resolved` in agreement with the broken count it reports', async () => {
    const { syncContent } = await import('@/lib/content/sync')

    const report = await syncContent({ hashAll: true })
    const { getContentLinks } = await import('./helpers')
    const links = await getContentLinks()

    const brokenRows = links.filter((link) => !link.resolved)
    expect(brokenRows).toHaveLength(report.linksBroken)
    expect(brokenRows.map((row) => row.href)).toContain('no-such-note')
  })

  it('does not extract links from frontmatter', async () => {
    const { syncContent } = await import('@/lib/content/sync')
    await syncContent({ hashAll: true })

    const { getContentLinks } = await import('./helpers')
    const links = await getContentLinks()

    // The description contains `[[why-not-catch]]`. It is rendered as plain
    // text everywhere on the site, so a link row for it would describe
    // something no reader can click.
    const fromDescription = links.filter((link) => link.sourcePath === 'notes/why-not-catch.md')
    expect(fromDescription).toHaveLength(1)
    expect(fromDescription[0]?.href).toBe('atomic-writes')
  })

  it('writes one row per distinct link, however often a document repeats it', async () => {
    const { syncContent } = await import('@/lib/content/sync')
    await syncContent({ hashAll: true })

    const { getContentLinks } = await import('./helpers')
    const rows = (await getContentLinks()).filter(
      (row) => row.sourcePath === 'notes/repetitive.md',
    )

    // `notes/repetitive.md` names `atomic-writes` three times, two ways. The
    // same fact twice is not a second edge — two rows would list this document
    // twice in every backlink list, and count it twice in the graph. The two
    // spellings stay apart, which is why the row key is the (kind, target) pair
    // and not the target: a wiki link and a route resolve by different rules,
    // and one of them can break while the other still works.
    expect(rows.map((row) => row.kind).sort()).toEqual(['internal', 'wiki'])
    expect(rows.every((row) => row.resolved)).toBe(true)
  })

  it('resolves links by slug as well, for documents that declare one', async () => {
    const { syncContent } = await import('@/lib/content/sync')
    await syncContent({ hashAll: true })

    const { getContentLinks } = await import('./helpers')
    const links = await getContentLinks()

    const bySlug = links.find(
      (link) => link.sourcePath === 'notes/why-not-catch.md' && link.href === 'atomic-writes',
    )

    expect(bySlug?.targetPath).toBe('posts/atomic-writes.md')
  })

  /* ------------------------------------------------------------------------ */
  /*  Forward references                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * A link written before the document it names.
   *
   * This is the ordinary way to write: the note that follows on from a piece of
   * work names it while the piece of work is still being written. Resolution,
   * though, happens when a document is *saved*, against the index as it stands
   * — so the reference is written as a row with no target, and until now
   * nothing revisited it. Only the next full sync turned it into an edge.
   *
   * Every test here drives `syncOneDocument`, never `syncContent`, because that
   * is the distinction under test: a full sync re-resolves the whole corpus and
   * would pass whether or not the save path does anything.
   */
  describe('links written before their target existed', () => {
    const written: string[] = []

    /** Put one document on disk, and remember it for the cleanup below. */
    async function writeDocument(relativePath: string, body: string): Promise<void> {
      const absolute = path.join(testContentRoot, relativePath)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, body, 'utf8')
      written.push(relativePath)
    }

    const frontmatter = (title: string, date: string): string =>
      `---
title: ${title}
date: ${date}
tags: [Engineering]
---

`

    afterAll(async () => {
      const { db } = await import('@/lib/db')
      const { contentIndex } = await import('@/lib/db/schema')
      const { inArray } = await import('drizzle-orm')

      await db.delete(contentIndex).where(inArray(contentIndex.path, written))
    })

    it('resolves a wiki link when the target is written afterwards', async () => {
      const { syncOneDocument } = await import('@/lib/content/sync')
      const { getContentLinks } = await import('./helpers')

      await writeDocument(
        'notes/forward-source.md',
        frontmatter('Forward Source', '2026-06-01') +
          'Written first, naming [[forward-target]] before there is anything to name.\n',
      )
      await syncOneDocument('notes/forward-source.md')

      const link = async () =>
        (await getContentLinks()).find((row) => row.sourcePath === 'notes/forward-source.md')

      // The row exists and describes the reference correctly; it just points at
      // nothing, which is the state the reader-visible site was built on.
      expect(await link()).toMatchObject({ href: 'forward-target', targetPath: null, resolved: false })

      await writeDocument(
        'projects/forward-target.md',
        frontmatter('Forward Target', '2026-06-02') + 'The other half of the pair.\n',
      )
      // Nothing but the target's own save: no full sync, no import, no restart.
      await syncOneDocument('projects/forward-target.md')

      expect(await link()).toMatchObject({
        href: 'forward-target',
        targetPath: 'projects/forward-target.md',
        resolved: true,
      })
    })

    it('resolves a path link written before its target existed', async () => {
      const { syncOneDocument } = await import('@/lib/content/sync')
      const { getContentLinks } = await import('./helpers')

      await writeDocument(
        'notes/path-source.md',
        frontmatter('Path Source', '2026-06-03') +
          'A URL rather than a bracket: [the target](/posts/path-target).\n',
      )
      await syncOneDocument('notes/path-source.md')

      const link = async () =>
        (await getContentLinks()).find((row) => row.sourcePath === 'notes/path-source.md')

      // The two kinds are stored apart because they resolve by different rules,
      // so the reverse lookup has to cover this one as well as the wiki form.
      expect((await link())?.resolved).toBe(false)

      await writeDocument(
        'posts/path-target.md',
        frontmatter('Path Target', '2026-06-04') + 'Arrived late.\n',
      )
      await syncOneDocument('posts/path-target.md')

      expect(await link()).toMatchObject({ targetPath: 'posts/path-target.md', resolved: true })
    })

    it('does not take a link away from the document that already holds it', async () => {
      const { syncOneDocument } = await import('@/lib/content/sync')
      const { getContentLinks } = await import('./helpers')

      // One slug under two types. `[[shared-name]]` is genuinely ambiguous, and
      // the rule for settling it is directory order — `posts` before `notes` —
      // applied to whatever the index holds. What must not happen is the note's
      // arrival taking a row the post already holds.
      await writeDocument(
        'posts/shared-name.md',
        frontmatter('Shared Name Post', '2026-06-05') + 'The post.\n',
      )
      await syncOneDocument('posts/shared-name.md')

      await writeDocument(
        'notes/shared-source.md',
        frontmatter('Shared Source', '2026-06-06') + 'Names [[shared-name]] from a note.\n',
      )
      await syncOneDocument('notes/shared-source.md')

      const link = async () =>
        (await getContentLinks()).find((row) => row.sourcePath === 'notes/shared-source.md')

      expect((await link())?.targetPath).toBe('posts/shared-name.md')

      await writeDocument(
        'notes/shared-name.md',
        frontmatter('Shared Name Note', '2026-06-07') + 'The note, which loses the name.\n',
      )
      await syncOneDocument('notes/shared-name.md')

      expect(await link()).toMatchObject({
        targetPath: 'posts/shared-name.md',
        resolved: true,
      })
    })

    it('marks what pointed at a document unresolved when it is deleted, and resolves it again when it returns', async () => {
      const { removeFromIndex, syncOneDocument } = await import('@/lib/content/sync')
      const { getContentLinks } = await import('./helpers')

      await writeDocument(
        'notes/doomed-target.md',
        frontmatter('Doomed Target', '2026-06-08') + 'Here for now.\n',
      )
      await syncOneDocument('notes/doomed-target.md')

      await writeDocument(
        'notes/doomed-source.md',
        frontmatter('Doomed Source', '2026-06-09') + 'Points at [[doomed-target]].\n',
      )
      await syncOneDocument('notes/doomed-source.md')

      const link = async () =>
        (await getContentLinks()).find((row) => row.sourcePath === 'notes/doomed-source.md')

      expect((await link())?.resolved).toBe(true)

      await removeFromIndex('notes/doomed-target.md')

      // The foreign key nulls `target_id` on its own, but `resolved` is a
      // column of its own too — so without this the link checker would go on
      // reporting a link to a document that is not there as fine.
      expect(await link()).toMatchObject({ targetPath: null, resolved: false })

      await syncOneDocument('notes/doomed-target.md')

      // Selected on the null target rather than on `resolved`, which is what
      // makes a document that comes back able to reclaim its own backlinks.
      expect(await link()).toMatchObject({
        targetPath: 'notes/doomed-target.md',
        resolved: true,
      })
    })
  })
})
