import fs from 'node:fs/promises'
import os from 'node:os'
import { inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { CONTENT_ROOT } from '@/lib/content/paths'
import { checksumOf } from '@/lib/content/reader'
import { createDocument, updateDocument, type WriteResult } from '@/lib/content/writer'
import { db } from '@/lib/db'
import { contentIndex } from '@/lib/db/schema'
import {
  AUTOSAVE_REVISIONS_KEPT,
  AUTOSAVE_SUMMARY,
  DIFF_CONTEXT_LINES,
  MAX_EXACT_DIFF_LINES,
  RevisionCompareError,
  RevisionError,
  RevisionNotFoundError,
  RevisionSlugMismatchError,
  captureRevision,
  compareRevisions,
  diffLines,
  getRevision,
  listRevisions,
  listRevisionsQuery,
  restoreRevision,
  selectPrunableAutosaves,
  splitLines,
  type CaptureResult,
  type CaptureRevisionInput,
} from '@/lib/revision'
import { hasTestDatabase } from '../setup'

/**
 * Revision history.
 *
 * The diff is the part a person reads, and the storage is the part the project
 * rule is about, so the tests are split the same way: the diff and the retention
 * policy run everywhere, and anything that talks to Postgres runs only when a
 * test database is configured. A run pointed at the development database by
 * accident is exactly what the guard in `tests/setup.ts` exists to prevent.
 *
 * The content root is a throwaway directory set up by `tests/setup.ts`; the
 * assertion below turns "I forgot to redirect it" into a loud failure rather
 * than writes into the repository's real `content/` tree.
 */
if (!CONTENT_ROOT.startsWith(os.tmpdir())) {
  throw new Error(`Revision tests refuse to run against ${CONTENT_ROOT}`)
}

const UUID = '11111111-1111-4111-8111-111111111111'

/* -------------------------------------------------------------------------- */
/*  Line splitting and line endings                                            */
/* -------------------------------------------------------------------------- */

describe('splitLines', () => {
  it('treats an empty text as no lines at all', () => {
    // Not one empty line: otherwise clearing a file would compare as different
    // from a file that was never written.
    expect(splitLines('')).toEqual([])
  })

  it('does not count a trailing newline as a line of its own', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    // A blank line at the end is a real line, so it survives.
    expect(splitLines('a\nb\n\n')).toEqual(['a', 'b', ''])
  })

  it('normalises CRLF and lone CR to LF', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c'])
    expect(splitLines('a\rb')).toEqual(['a', 'b'])
  })
})

describe('diffLines line endings', () => {
  it('reports nothing between a CRLF file and its LF twin', () => {
    const lf = 'one\ntwo\nthree\n'
    const crlf = 'one\r\ntwo\r\nthree\r\n'
    expect(diffLines(crlf, lf).entries).toEqual([])
    expect(diffLines(crlf, lf).stats.additions).toBe(0)
  })

  it('finds the one edited line rather than reporting every line', () => {
    const result = diffLines('one\r\ntwo\r\nthree\r\n', 'one\ntwo changed\nthree\n')
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(1)
    expect(result.entries.filter((entry) => entry.kind === 'context')).toHaveLength(2)
  })

  it('ignores a trailing newline that appeared or vanished', () => {
    expect(diffLines('a\nb\n', 'a\nb').entries).toEqual([])
    expect(diffLines('a\nb', 'a\nb\n').stats.deletions).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/*  Diff shapes                                                                */
/* -------------------------------------------------------------------------- */

describe('diffLines', () => {
  it('reports nothing for two empty texts', () => {
    const result = diffLines('', '')
    expect(result.entries).toEqual([])
    expect(result.stats).toEqual({
      additions: 0,
      deletions: 0,
      context: 0,
      elided: 0,
      oldLines: 0,
      newLines: 0,
    })
    expect(result.strategy).toBe('exact')
  })

  it('reports nothing for identical texts', () => {
    const text = '# Title\n\nA paragraph.\n\n- one\n- two\n'
    const result = diffLines(text, text)
    // An empty entry list, not one "everything is unchanged" placeholder: a
    // viewer should be able to say these two revisions are the same file.
    expect(result.entries).toEqual([])
    expect(result.stats.oldLines).toBe(6)
    expect(result.stats.newLines).toBe(6)
  })

  it('reports a pure insertion with both line numbers', () => {
    const result = diffLines('alpha\nbeta\n', 'alpha\ninserted\nbeta\n')

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'context',
      'add',
      'context',
    ])
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(0)

    const inserted = result.entries[1]
    expect(inserted?.text).toBe('inserted')
    expect(inserted?.oldLine).toBeNull()
    expect(inserted?.newLine).toBe(2)

    // The line after the insertion moved down by one on the new side.
    expect(result.entries[2]?.oldLine).toBe(2)
    expect(result.entries[2]?.newLine).toBe(3)
  })

  it('reports a pure deletion', () => {
    const result = diffLines('alpha\ndoomed\nbeta\n', 'alpha\nbeta\n')

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'context',
      'remove',
      'context',
    ])
    expect(result.stats.additions).toBe(0)
    expect(result.stats.deletions).toBe(1)

    const removed = result.entries[1]
    expect(removed?.text).toBe('doomed')
    expect(removed?.oldLine).toBe(2)
    expect(removed?.newLine).toBeNull()
  })

  it('reports a replacement as a removal followed by an addition', () => {
    const result = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'context',
      'remove',
      'add',
      'context',
    ])
    // The same line number on both sides: the edit happened at line 2, the
    // lines after it did not move.
    expect(result.entries[1]?.oldLine).toBe(2)
    expect(result.entries[2]?.newLine).toBe(2)
  })

  it('collapses the unchanged run around a one-word edit in a long file', () => {
    const { before, after } = longDocument(400, 200)
    const result = diffLines(before, after)

    expect(result.strategy).toBe('exact')
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(1)

    // 399 unchanged lines, of which six are shown either side of the edit.
    expect(result.stats.context).toBe(DIFF_CONTEXT_LINES * 2 * 2)
    expect(result.stats.elided).toBe(399 - DIFF_CONTEXT_LINES * 4)
    expect(result.entries.length).toBeLessThan(20)

    const placeholders = result.entries.filter((entry) => (entry.elided ?? 0) > 0)
    expect(placeholders).toHaveLength(2)
    // The placeholder carries the number of the first line it stands for, so a
    // viewer can print "lines 4-196" without holding the whole file.
    expect(placeholders[0]?.oldLine).toBe(DIFF_CONTEXT_LINES + 1)
    expect(placeholders[0]?.elided).toBe(193)
    expect(placeholders[1]?.oldLine).toBe(204)
    expect(placeholders[1]?.elided).toBe(194)
    expect(placeholders[0]?.text).toBe('')

    const changes = result.entries.filter((entry) => entry.kind !== 'context')
    expect(changes.map((entry) => entry.kind)).toEqual(['remove', 'add'])
    expect(changes[0]?.text).toBe('line 200 of the article')
    expect(changes[1]?.text).toBe('line 200 EDITED')
  })

  it('honours an explicit context width', () => {
    const result = diffLines('a\nb\nc\nd\ne\nf\n', 'a\nb\nX\nd\ne\nf\n', { context: 0 })

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'context',
      'remove',
      'add',
      'context',
    ])
    expect(result.entries[0]?.elided).toBe(2)
    expect(result.entries[3]?.elided).toBe(3)
    expect(result.stats.context).toBe(0)
    expect(result.stats.elided).toBe(5)
  })
})

/* -------------------------------------------------------------------------- */
/*  Coarsening                                                                 */
/* -------------------------------------------------------------------------- */

describe('diffLines coarsening', () => {
  it('stays exact at the line bound and coarsens past it', () => {
    const atBound = diffLines(plainLines(MAX_EXACT_DIFF_LINES), plainLines(MAX_EXACT_DIFF_LINES, 5))
    expect(atBound.strategy).toBe('exact')

    const past = diffLines(plainLines(MAX_EXACT_DIFF_LINES + 1), plainLines(MAX_EXACT_DIFF_LINES + 1, 5))
    expect(past.strategy).toBe('coarse')
  })

  it('says it is coarse, and still finds a single edited line', () => {
    // Well past the bound: this is the input that must not become a
    // four-million-cell table on a request thread.
    const result = diffLines(plainLines(9000), plainLines(9000, 5000))

    expect(result.strategy).toBe('coarse')
    expect(result.stats.oldLines).toBe(9000)
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(1)
    expect(result.entries.filter((entry) => entry.kind === 'add')[0]?.text).toBe('line 5000 EDITED')
    expect(result.stats.elided).toBeGreaterThan(8000)
  })
})

/* -------------------------------------------------------------------------- */
/*  Retention policy                                                           */
/* -------------------------------------------------------------------------- */

describe('selectPrunableAutosaves', () => {
  const autosave = (revisionNo: number) => ({
    id: `auto-${revisionNo}`,
    revisionNo,
    summary: AUTOSAVE_SUMMARY,
  })
  const named = (revisionNo: number) => ({
    id: `named-${revisionNo}`,
    revisionNo,
    summary: 'Published',
  })

  it('keeps the newest autosaves and returns the rest', () => {
    const rows = [autosave(1), autosave(2), autosave(3), autosave(4)]
    expect(selectPrunableAutosaves(rows, 2)).toEqual(['auto-2', 'auto-1'])
  })

  it('returns nothing while the document is under the bound', () => {
    expect(selectPrunableAutosaves([autosave(1), autosave(2)], 5)).toEqual([])
  })

  it('never returns a save somebody made on purpose', () => {
    const rows = [named(1), autosave(2), autosave(3), autosave(4)]
    expect(selectPrunableAutosaves(rows, 1)).toEqual(['auto-3', 'auto-2'])
  })

  it('does not depend on the order the rows arrive in', () => {
    const rows = [autosave(3), autosave(1), autosave(4), autosave(2)]
    expect(selectPrunableAutosaves(rows, 2)).toEqual(['auto-2', 'auto-1'])
  })

  it('treats a bound of zero as keeping no autosaves', () => {
    const rows = [autosave(1), autosave(2)]
    expect(selectPrunableAutosaves(rows, 0)).toEqual(['auto-2', 'auto-1'])
  })
})

/* -------------------------------------------------------------------------- */
/*  Query shape                                                                */
/* -------------------------------------------------------------------------- */

describe('listRevisionsQuery', () => {
  it('names its columns instead of selecting the blobs', () => {
    // A list page that decompresses two hundred snapshots to print timestamps
    // is a page that times out, so the rule is enforced here rather than in a
    // comment. The query is built, never run; no connection is opened.
    const { sql } = listRevisionsQuery(UUID, { limit: 10, offset: 0 }).toSQL()

    expect(sql).toContain('content_revisions')
    expect(sql).not.toContain('snapshot')
  })
})

/* -------------------------------------------------------------------------- */
/*  Capture contracts that do not need a database                              */
/* -------------------------------------------------------------------------- */

describe('captureRevision input handling', () => {
  it('reports a create as having no previous state', async () => {
    const result = await captureRevision({
      contentId: UUID,
      type: 'post',
      slug: 'brand-new',
      data: { title: 'Brand new' },
      body: 'Body.\n',
      previousContent: null,
      reason: 'save',
    })

    // A file that has just been created is the only state that has ever
    // existed, and it is on disk. Copying it into Postgres is the one thing
    // revision storage must not do, so a create records nothing.
    expect(result.captured).toBe(false)
    expect(result.skipped).toBe('no-previous-state')
    expect(result.error).toBeNull()
  })

  it('refuses an input it cannot trust without throwing', async () => {
    // The cast is the point: a typed caller cannot write this, and the runtime
    // has to cope with a job, a script or a future caller that does.
    const invalid = {
      contentId: UUID,
      type: 'post',
      slug: 'x',
      data: {},
      body: '',
      previousContent: 'before\n',
      reason: 'whenever',
    } as unknown as CaptureRevisionInput

    const result = await captureRevision(invalid)

    expect(result.captured).toBe(false)
    expect(result.skipped).toBe('invalid-input')
    expect(result.error).toBeInstanceOf(RevisionError)
    expect(result.error?.message).toContain('reason')
  })
})

/* -------------------------------------------------------------------------- */
/*  Database-backed                                                            */
/* -------------------------------------------------------------------------- */

/**
 * These run only when `TEST_DATABASE_URL` is set. Fixtures use a unique slug
 * prefix and are removed afterwards, so the assertions are about the documents
 * this file created rather than about whatever else is in the database.
 */
describe.skipIf(!hasTestDatabase)('revisions against a database', () => {
  const RUN = `revtest-${Date.now().toString(36)}`
  const contentIds: string[] = []
  const files: string[] = []
  let counter = 0

  interface Fixture {
    contentId: string
    slug: string
    title: string
    relativePath: string
    absolutePath: string
    /** The file's contents as created, before any edit. */
    original: string
  }

  async function seedDocument(): Promise<Fixture> {
    counter += 1
    const slug = `${RUN}-${counter}`
    const title = `Seeded ${counter}`
    const written = await createDocument({
      type: 'post',
      slug,
      data: { title, date: '2024-01-01' },
      body: 'First version.\n',
    })
    files.push(written.absolutePath)

    const original = await fs.readFile(written.absolutePath, 'utf8')
    const [row] = await db
      .insert(contentIndex)
      .values({
        type: 'post',
        slug,
        path: written.relativePath,
        title,
        status: 'draft',
        checksum: checksumOf(original),
      })
      .returning({ id: contentIndex.id })

    if (!row) throw new Error(`Could not insert fixture ${slug}`)
    contentIds.push(row.id)

    return {
      contentId: row.id,
      slug,
      title,
      relativePath: written.relativePath,
      absolutePath: written.absolutePath,
      original,
    }
  }

  /** Contents a write replaced. A fixture always had contents, so null is a bug. */
  function previousText(result: WriteResult): string {
    if (result.previousContent === null) {
      throw new Error(`The write to ${result.relativePath} replaced nothing`)
    }
    return result.previousContent
  }

  function capture(
    fixture: Fixture,
    previousContent: string,
    reason: CaptureRevisionInput['reason'],
  ): Promise<CaptureResult> {
    return captureRevision({
      contentId: fixture.contentId,
      type: 'post',
      slug: fixture.slug,
      data: { title: `Edited ${fixture.slug}` },
      body: 'Edited body.\n',
      previousContent,
      reason,
    })
  }

  /** The id a capture produced, failing the test rather than returning null. */
  function idOf(result: CaptureResult): string {
    if (!result.captured || result.revisionId === null) {
      throw new Error(
        `Capture did not record a revision: ${
          result.error?.message ?? result.skipped ?? 'unknown'
        }`,
      )
    }
    return result.revisionId
  }

  afterAll(async () => {
    if (contentIds.length > 0) {
      await db.delete(contentIndex).where(inArray(contentIndex.id, contentIds))
    }
    await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)))
  })

  it('stores the state a save replaced, and returns it decompressed', async () => {
    const fixture = await seedDocument()

    const written = await updateDocument(fixture.relativePath, () => ({
      data: { title: fixture.title, date: '2024-01-01' },
      body: 'Second version.\n',
    }))

    const result = await capture(fixture, previousText(written), 'save')
    expect(result.captured).toBe(true)
    expect(result.error).toBeNull()
    expect(result.revisionNo).toBe(1)

    const stored = await getRevision(idOf(result))
    expect(stored.content).toBe(fixture.original)
    expect(stored.contentHash).toBe(checksumOf(fixture.original))
    expect(stored.byteSize).toBe(Buffer.byteLength(fixture.original, 'utf8'))
    // The title the snapshot carried, not the one the save gave the document.
    expect(stored.title).toBe(fixture.title)
    expect(stored.additions + stored.deletions).toBeGreaterThan(0)
  })

  it('lists metadata without touching the snapshots', async () => {
    const fixture = await seedDocument()
    const written = await updateDocument(fixture.relativePath, () => ({
      data: { title: 'Listed' },
      body: 'Listed body.\n',
    }))
    await capture(fixture, previousText(written), 'save')

    const rows = await listRevisions(fixture.contentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.summary).toBe('Changed title')
    expect(Object.keys(rows[0] ?? {})).not.toContain('snapshot')
    expect(Object.keys(rows[0] ?? {})).not.toContain('content')
  })

  it('does not record a second row when nothing changed between saves', async () => {
    const fixture = await seedDocument()
    const before = '---\ntitle: "Same"\ndate: "2024-01-01"\n---\n\nSame body.\n'

    const first = await capture(fixture, before, 'autosave')
    expect(first.captured).toBe(true)

    // Ctrl+S twice: the second save replaced the same state with the same
    // state, which is not a second version of anything.
    const again = await capture(fixture, before, 'autosave')
    expect(again.captured).toBe(false)
    expect(again.skipped).toBe('unchanged')
    expect(await listRevisions(fixture.contentId)).toHaveLength(1)
  })

  it('numbers concurrent saves without collision', async () => {
    const fixture = await seedDocument()

    // Five saves landing at once, each with contents of its own. The row lock
    // in the capture transaction is what keeps them from agreeing on the same
    // revision number; without it they either collide on the unique index or
    // prune each other's rows.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        capture(fixture, `---\ntitle: "v${index}"\n---\n\nConcurrent ${index}.\n`, 'autosave'),
      ),
    )

    expect(results.every((result) => result.captured)).toBe(true)
    const numbers = (await listRevisions(fixture.contentId)).map((row) => row.revisionNo)
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('bounds autosaves in the transaction that inserts them', async () => {
    const fixture = await seedDocument()

    for (let index = 0; index < AUTOSAVE_REVISIONS_KEPT + 3; index += 1) {
      const result = await capture(
        fixture,
        `---\ntitle: "v${index}"\n---\n\nBody ${index}.\n`,
        'autosave',
      )
      expect(result.captured).toBe(true)
    }

    const published = await capture(
      fixture,
      '---\ntitle: "Kept"\n---\n\nA publish that must survive.\n',
      'publish',
    )

    const rows = await listRevisions(fixture.contentId, { limit: 200 })
    const autosaves = rows.filter((row) => row.summary === AUTOSAVE_SUMMARY)

    expect(autosaves).toHaveLength(AUTOSAVE_REVISIONS_KEPT)
    expect(rows.some((row) => row.id === published.revisionId)).toBe(true)
    expect(rows.filter((row) => row.summary === 'Published')).toHaveLength(1)
    // Pruning happened on the inserting write, so no extra round trip is needed
    // for the bound to hold.
    expect(await listRevisions(fixture.contentId, { limit: 200 })).toHaveLength(
      AUTOSAVE_REVISIONS_KEPT + 1,
    )
  })

  it('restores through the writer, keeping the state it replaced', async () => {
    const fixture = await seedDocument()

    const second = await updateDocument(fixture.relativePath, () => ({
      data: { title: 'Second' },
      body: 'Second version.\n',
    }))
    const capturedFirst = await capture(fixture, previousText(second), 'save')

    await updateDocument(fixture.relativePath, () => ({
      data: { title: 'Third' },
      body: 'Third version.\n',
    }))
    const thirdText = await fs.readFile(fixture.absolutePath, 'utf8')

    const restored = await restoreRevision(idOf(capturedFirst), null)

    expect(await fs.readFile(fixture.absolutePath, 'utf8')).toBe(fixture.original)
    // A standard WriteResult, plus what the restore recorded on the way. The
    // contents it reports as replaced are the third version — the state the
    // restore itself overwrote, not the one that write had replaced.
    expect(restored.created).toBe(false)
    expect(restored.previousContent).toBe(thirdText)
    expect(restored.restoredRevisionId).toBe(capturedFirst.revisionId)

    expect(restored.revision.captured).toBe(true)
    const preRestore = await getRevision(idOf(restored.revision))
    expect(preRestore.content).toBe(thirdText)
    expect(preRestore.summary).toBe('Before restore')
  })

  it('refuses to restore a revision saved under a different slug', async () => {
    const fixture = await seedDocument()

    const stray = '---\ntitle: "Elsewhere"\nslug: "some-other-name"\n---\n\nBody.\n'
    const result = await capture(fixture, stray, 'save')

    await expect(restoreRevision(idOf(result), null)).rejects.toBeInstanceOf(
      RevisionSlugMismatchError,
    )
    // The file was not touched: a refusal here means no write happened.
    expect(await fs.readFile(fixture.absolutePath, 'utf8')).toBe(fixture.original)
  })

  it('differences two revisions of one document', async () => {
    const fixture = await seedDocument()

    const from = await capture(fixture, '---\ntitle: "A"\n---\n\nOne.\nTwo.\n', 'save')
    const to = await capture(fixture, '---\ntitle: "B"\n---\n\nOne.\nThree.\n', 'save')

    const comparison = await compareRevisions(idOf(from), idOf(to))
    expect(comparison.from.id).toBe(from.revisionId)
    expect(comparison.to.id).toBe(to.revisionId)
    expect(comparison.diff.stats.deletions).toBeGreaterThan(0)
    expect(comparison.diff.entries.length).toBeGreaterThan(0)
  })

  it('refuses to diff revisions of two different documents', async () => {
    const one = await seedDocument()
    const other = await seedDocument()

    const first = await capture(one, '---\ntitle: "A"\n---\n\nOne.\n', 'save')
    const second = await capture(other, '---\ntitle: "B"\n---\n\nTwo.\n', 'save')

    await expect(compareRevisions(idOf(first), idOf(second))).rejects.toBeInstanceOf(
      RevisionCompareError,
    )
  })

  it('reports a revision that is not there', async () => {
    await expect(getRevision('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      RevisionNotFoundError,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A file of `lines` lines, optionally with one word changed on `editLine`.
 * Built here rather than checked in so the shape of the change is obvious.
 */
function longDocument(lines: number, editLine: number): { before: string; after: string } {
  const before: string[] = []
  for (let index = 1; index <= lines; index += 1) {
    before.push(`line ${index} of the article`)
  }
  const after = [...before]
  after[editLine - 1] = `line ${editLine} EDITED`
  return { before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` }
}

function plainLines(count: number, editLine?: number): string {
  const lines: string[] = []
  for (let index = 1; index <= count; index += 1) {
    lines.push(index === editLine ? `line ${index} EDITED` : `line ${index}`)
  }
  return `${lines.join('\n')}\n`
}
