import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasTestDatabase, testContentRoot } from '../setup'

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

describe.skipIf(!hasTestDatabase)('content sync with real files', () => {
  beforeAll(async () => {
    await fs.mkdir(POSTS, { recursive: true })
    await fs.mkdir(NOTES, { recursive: true })
    await fs.writeFile(path.join(POSTS, 'atomic-writes.md'), POST, 'utf8')
    await fs.writeFile(path.join(NOTES, 'why-not-catch.md'), NOTE, 'utf8')
  })

  afterAll(async () => {
    const { db } = await import('@/lib/db')
    const { contentIndex } = await import('@/lib/db/schema')
    const { inArray } = await import('drizzle-orm')

    await db
      .delete(contentIndex)
      .where(inArray(contentIndex.path, ['posts/atomic-writes.md', 'notes/why-not-catch.md']))

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
})
