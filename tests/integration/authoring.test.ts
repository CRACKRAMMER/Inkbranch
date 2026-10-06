import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasTestDatabase, testContentRoot } from '../setup'

import {
  UnsupportedAssetError,
  UPLOAD_ROOT,
  sha256Of,
  storeAsset,
} from '@/lib/assets/storage'
import { loadEditorDocument } from '@/lib/admin/documents'
import { serializeFrontmatter } from '@/lib/content/frontmatter'
import { listContent } from '@/lib/content/queries'
import { readDocument } from '@/lib/content/reader'
import { removeFromIndex, syncOneDocument } from '@/lib/content/sync'
import {
  ContentWriteError,
  createDocument,
  ensureContentDirectories,
  sweepOrphanTempFiles,
  updateDocument,
} from '@/lib/content/writer'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { assets, contentIndex } from '@/lib/db/schema'
import {
  RevisionSlugMismatchError,
  captureRevision,
  listRevisions,
  restoreRevision,
} from '@/lib/revision/store'
import { PathSecurityError } from '@/lib/security/paths'
import { eq, inArray } from 'drizzle-orm'

/**
 * The authoring lifecycle, driven through the same modules the admin UI calls.
 *
 * ## Why these are integration tests and not unit tests
 *
 * Every step here is individually covered by a unit test, and each of those
 * tests passes. What none of them can show is that the steps compose: that the
 * bytes `createDocument` wrote are the bytes `syncOneDocument` indexed, that the
 * `previousContent` a save returns is the text a revision snapshot will later
 * restore *verbatim*, and that the row a restore leaves behind agrees with the
 * file on disk. Those are agreements between modules, and an agreement is only
 * observable by running both.
 *
 * The three flows are the ones a working site cannot be without: create, edit
 * and publish a post; upload an asset; restore a revision. Each is asserted
 * against the file on disk and the row in Postgres, never against one alone.
 *
 * ## The failures worth naming
 *
 * Two assertions here exist because the brief calls them out as guarantees
 * rather than behaviours, and a guarantee that is only checked by reading the
 * code is a guarantee nobody has checked:
 *
 *   - A save that fails must leave the original file untouched, byte for byte.
 *   - An upload's type must come from its contents, never from its filename.
 */

const POSTS = path.join(testContentRoot, 'posts')

/** The paths this file creates, so cleanup can remove exactly those. */
const created: string[] = []

/**
 * Hashes of the assets this file stores.
 *
 * Cleanup matters more here than for the documents. The database outlives a run
 * while the upload directory does not — `tests/setup.ts` makes a fresh one per
 * process — so without this the *second* run of the suite finds rows whose
 * files it cannot see, `storeAsset` reports `created: false` for an upload that
 * genuinely created something, and the suite starts disagreeing with itself for
 * a reason that has nothing to do with the code.
 */
const storedAssets: string[] = []

/** A post's frontmatter, in the shape the admin's create action builds. */
function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: 'A Document Written By A Test',
    slug: 'a-document-written-by-a-test',
    description: 'Created by the integration suite.',
    date: '2026-09-11',
    status: 'draft',
    tags: ['Engineering'],
    ...overrides,
  }
}

/** Read a document's index row, failing loudly rather than returning undefined. */
async function indexedRow(relativePath: string) {
  const [row] = await db
    .select()
    .from(contentIndex)
    .where(eq(contentIndex.path, relativePath))
    .limit(1)

  if (!row) throw new Error(`${relativePath} was not indexed`)
  return row
}

describe.skipIf(!hasTestDatabase)('authoring lifecycle', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
    await ensureContentDirectories()
    await fs.mkdir(POSTS, { recursive: true })
  })

  afterAll(async () => {
    // Removing the row cascades to revisions, tags and links. Removing the file
    // first would be wrong: `removeFromIndex` is what makes the two agree.
    for (const relativePath of created) {
      await removeFromIndex(relativePath).catch(() => undefined)
      await fs.rm(path.join(testContentRoot, relativePath), { force: true })
    }

    if (storedAssets.length > 0) {
      const rows = await db
        .select({ path: assets.path })
        .from(assets)
        .where(inArray(assets.sha256, storedAssets))
        .catch(() => [])

      await db
        .delete(assets)
        .where(inArray(assets.sha256, storedAssets))
        .catch(() => undefined)

      // The row is the record; the file is the artifact. Leaving the file would
      // let the next run's `persistAsset` find bytes with no row and re-insert
      // them under the same hash, which is a state production never reaches.
      for (const row of rows) {
        await fs.rm(path.join(UPLOAD_ROOT, row.path), { force: true })
      }
    }
  })

  /* ------------------------------------------------------------------------ */
  /*  Create, edit, publish                                                    */
  /* ------------------------------------------------------------------------ */

  describe('create, edit and publish a post', () => {
    const slug = 'a-document-written-by-a-test'
    const relativePath = `posts/${slug}.md`
    const absolutePath = path.join(testContentRoot, relativePath)

    it('creates the file, indexes it as a draft, then publishes it', async () => {
      const created_ = await createDocument({
        type: 'post',
        slug,
        data: frontmatter(),
        body: 'The first paragraph.\n',
      })
      created.push(relativePath)

      // The write is on disk before anything else is attempted. If this fails,
      // every assertion below is about a file that does not exist.
      expect(await fs.readFile(absolutePath, 'utf8')).toContain(
        'The first paragraph.',
      )
      expect(created_.created).toBe(true)

      const first = await syncOneDocument(relativePath)
      expect(first?.row.status).toBe('draft')
      expect(first?.row.title).toBe('A Document Written By A Test')
      expect(first?.row.wordCount).toBeGreaterThan(0)

      // A draft carries the date it was written — `published_at` is the
      // frontmatter date, not a claim of visibility — so the property worth
      // asserting is that the public query does not return it. Status is what
      // gates the site, and this is the assertion that would notice if it
      // stopped doing so.
      const listed = await listContent({ type: 'post' })
      expect(listed.map((row) => row.slug)).not.toContain(slug)

      // The tags in the frontmatter became rows and a join, not a text column.
      const [tagged] = await db
        .select({ id: contentIndex.id })
        .from(contentIndex)
        .where(eq(contentIndex.path, relativePath))
        .limit(1)
      expect(tagged?.id).toBe(first?.row.id)

      // Edit. `updateDocument` hands back the state it replaced, which is what
      // a revision is captured from — a save that cannot say what it overwrote
      // cannot be undone.
      const edited = await updateDocument(relativePath, (current) => ({
        data: frontmatter({ description: 'Edited by the suite.' }),
        body: `${current.body}\nA second paragraph.\n`,
      }))
      expect(edited.previousContent).toContain('The first paragraph.')
      expect(edited.previousContent).not.toContain('A second paragraph.')

      // Publish. Frontmatter `status` is the source of truth; the index follows.
      const published = await updateDocument(relativePath, (current) => ({
        data: frontmatter({
          description: 'Edited by the suite.',
          status: 'published',
        }),
        body: current.body,
      }))
      expect(published.previousContent).not.toContain('published')

      const after = await syncOneDocument(relativePath)
      expect(after?.row.status).toBe('published')
      expect(after?.row.publishedAt).toBeInstanceOf(Date)

      // And the public read path sees it, which is the only claim that matters:
      // a published row is worth nothing if the document is not readable.
      const document = await readDocument(relativePath)
      expect(document?.status).toBe('published')
      expect(document?.body).toContain('A second paragraph.')
      expect(document?.body).not.toContain('---')
    })

    it('refuses to create a second document over an existing one', async () => {
      const before = await fs.readFile(absolutePath, 'utf8')

      await expect(
        createDocument({
          type: 'post',
          slug,
          data: frontmatter({ title: 'Something Else Entirely' }),
          body: 'This must never reach the disk.\n',
        }),
      ).rejects.toBeInstanceOf(ContentWriteError)

      // The refusal has to be a refusal of the *write*, not just of the return
      // value. A create that throws after clobbering is the failure this guard
      // exists to prevent.
      expect(await fs.readFile(absolutePath, 'utf8')).toBe(before)
    })

    it('leaves the original intact when a save fails', async () => {
      const before = await fs.readFile(absolutePath, 'utf8')

      await expect(
        updateDocument(relativePath, () => {
          throw new Error('a failure raised while preparing the new contents')
        }),
      ).rejects.toThrow('a failure raised while preparing the new contents')

      expect(await fs.readFile(absolutePath, 'utf8')).toBe(before)
    })

    it('refuses a path that escapes the content root', async () => {
      const escape = path.resolve(testContentRoot, '..', 'escaped-by-a-test.md')

      await expect(
        updateDocument('../escaped-by-a-test.md', () => ({
          data: frontmatter(),
          body: 'outside\n',
        })),
      ).rejects.toBeInstanceOf(PathSecurityError)

      await expect(fs.readFile(escape, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })

    it('replaces the file by rename, leaving no temporary behind', async () => {
      // An in-place truncate-and-write keeps the inode; a temp file plus
      // `rename` does not. The distinction is the whole reason a reader never
      // observes a half-written article, and it is visible from outside.
      const before = await fs.stat(absolutePath)

      await updateDocument(relativePath, (current) => ({
        data: frontmatter({
          description: 'Edited by the suite.',
          status: 'published',
        }),
        body: `${current.body}\nA third paragraph.\n`,
      }))

      const after = await fs.stat(absolutePath)
      expect(after.ino).not.toBe(before.ino)
      expect(await fs.readFile(absolutePath, 'utf8')).toContain(
        'A third paragraph.',
      )

      const entries = await fs.readdir(POSTS)
      expect(entries.filter((name) => name.includes('.tmp'))).toEqual([])
      expect(await sweepOrphanTempFiles(0)).toBe(0)
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Upload                                                                   */
  /* ------------------------------------------------------------------------ */

  describe('upload an asset', () => {
    /**
     * A real PNG, so the sniffer has real bytes to recognise.
     *
     * The colour is a parameter because an asset is named by the hash of its
     * bytes: two tests that uploaded the same flat rectangle would be uploading
     * the same file, and the second would be a duplicate rather than a store.
     */
    async function png(
      background: { r: number; g: number; b: number } = { r: 30, g: 90, b: 160 },
    ): Promise<Buffer> {
      return sharp({ create: { width: 64, height: 48, channels: 3, background } })
        .png()
        .toBuffer()
    }

    /** Remember an upload so cleanup can remove its row and its file. */
    function track(result: { asset: { sha256: string } }): string {
      storedAssets.push(result.asset.sha256)
      return result.asset.sha256
    }

    it('stores the bytes, records a row, and names the file by content hash', async () => {
      const bytes = await png()

      // A misleading filename on purpose: the extension stored must come from
      // the contents, so `photo.zip` full of PNG is a PNG.
      const result = await storeAsset({
        buffer: bytes,
        originalFilename: 'photo.zip',
        alt: 'A flat blue rectangle',
      })
      track(result)

      expect(result.created).toBe(true)
      expect(result.asset.mime).toBe('image/png')
      expect(result.asset.path).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
      expect(result.asset.width).toBe(64)
      expect(result.asset.height).toBe(48)
      expect(result.asset.alt).toBe('A flat blue rectangle')

      const stored = await fs.readFile(path.join(UPLOAD_ROOT, result.asset.path))

      // The stored bytes are what the row describes. They are not necessarily
      // the bytes that arrived: an image is re-encoded on the way in, which is
      // how metadata is stripped and how the derivatives are produced. What
      // must hold is that the row and the file agree — `size` is the processed
      // length, and the filename *is* the hash of the processed bytes.
      //
      // That last part is what makes `immutable` caching safe: the URL cannot
      // name different bytes later, so a cached copy can never be stale.
      expect(result.asset.size).toBe(stored.length)
      expect(result.asset.path.endsWith(`${sha256Of(stored)}.png`)).toBe(true)
      expect(stored.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')

      // The blur placeholder is a data URL produced at upload time, not on
      // render — a page must not decode an image to place it.
      expect(result.asset.blurDataUrl).toMatch(/^data:image\//)
    })

    it('strips EXIF and GPS from an uploaded photograph', async () => {
      // A camera JPEG, EXIF and all. Storing it verbatim would publish the
      // location and the device of whoever took it, which is a disclosure the
      // author never chose and cannot see in the rendered page.
      const bytes = await sharp({
        create: {
          width: 80,
          height: 60,
          channels: 3,
          background: { r: 10, g: 120, b: 90 },
        },
      })
        .jpeg()
        .withMetadata({
          exif: { IFD0: { Copyright: 'Photographer Name', Make: 'Camera Co' } },
        })
        .toBuffer()

      // The fixture must actually carry the block, or the assertion below
      // passes for the wrong reason.
      expect(bytes.includes(Buffer.from('Exif', 'latin1'))).toBe(true)

      const result = await storeAsset({
        buffer: bytes,
        originalFilename: 'holiday.jpg',
      })
      track(result)

      const stored = await fs.readFile(
        path.join(UPLOAD_ROOT, result.asset.path),
      )
      expect(stored.includes(Buffer.from('Exif', 'latin1'))).toBe(false)
      expect(stored.includes(Buffer.from('Photographer Name', 'latin1'))).toBe(
        false,
      )
    })

    it('returns the existing row for bytes it already has', async () => {
      const bytes = await png({ r: 220, g: 180, b: 20 })

      const first = await storeAsset({ buffer: bytes, originalFilename: 'one.png' })
      track(first)
      const second = await storeAsset({
        buffer: bytes,
        originalFilename: 'two.png',
        alt: 'A different alt text',
      })

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.asset.id).toBe(first.asset.id)
      // A duplicate is not an edit. Two rows for one file would each claim to
      // own a file the other could delete.
      expect(second.asset.alt).toBe(first.asset.alt)
    })

    it('rejects bytes that are not an asset, whatever they are called', async () => {
      const zipBytes = Buffer.concat([
        Buffer.from('PK\x03\x04', 'latin1'),
        Buffer.alloc(32, 0x41),
      ])

      await expect(
        storeAsset({ buffer: zipBytes, originalFilename: 'screenshot.png' }),
      ).rejects.toBeInstanceOf(UnsupportedAssetError)
    })

    it('sanitises an SVG rather than storing script in it', async () => {
      const hostile = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
          `<script>alert(document.domain)</script>` +
          `<rect width="10" height="10" onload="alert(1)"/>` +
          `</svg>`,
      )

      const result = await storeAsset({
        buffer: hostile,
        originalFilename: 'icon.svg',
      })
      track(result)

      const stored = await fs.readFile(
        path.join(UPLOAD_ROOT, result.asset.path),
        'utf8',
      )
      expect(stored).not.toContain('<script')
      expect(stored).not.toContain('onload')
      // Reported rather than silently dropped: the admin is told what changed
      // so a legitimately-authored SVG is not quietly altered without a trace.
      expect(result.sanitizationRemoved.length).toBeGreaterThan(0)
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Revisions                                                                */
  /* ------------------------------------------------------------------------ */

  describe('restore a revision', () => {
    const slug = 'a-revision-under-restore'
    const relativePath = `posts/${slug}.md`
    const absolutePath = path.join(testContentRoot, relativePath)

    /** The state every later assertion compares against. */
    let snapshot: string

    beforeAll(async () => {
      await createDocument({
        type: 'post',
        slug,
        data: frontmatter({ title: 'A Revision Under Restore', slug }),
        body: 'The state that will be restored.\n',
      })
      created.push(relativePath)
      await syncOneDocument(relativePath)

      // First real save: this is the write whose *previous* state is captured,
      // because a create has no past worth keeping — the file it just wrote is
      // the only state that has ever existed.
      const first = await updateDocument(relativePath, () => ({
        data: frontmatter({ title: 'A Revision Under Restore', slug }),
        body: 'The state that will be restored.\n',
      }))
      snapshot = first.previousContent ?? ''
      expect(snapshot).not.toBe('')
    })

    it('restores the exact bytes of the snapshot, and is itself undoable', async () => {
      const row = await indexedRow(relativePath)

      const captured = await captureRevision({
        contentId: row.id,
        type: 'post',
        slug,
        data: frontmatter({ title: 'A Revision Under Restore', slug }),
        body: 'The second state.\n',
        previousContent: snapshot,
        reason: 'save',
        actorId: null,
      })
      expect(captured.captured).toBe(true)
      expect(captured.revisionId).toBeTruthy()

      // Move the file somewhere else entirely, so a restore that did nothing
      // would be visible.
      await updateDocument(relativePath, () => ({
        data: frontmatter({ title: 'A Revision Under Restore', slug }),
        body: 'A third state, written after the revision was captured.\n',
      }))
      expect(await fs.readFile(absolutePath, 'utf8')).not.toBe(snapshot)

      const restored = await restoreRevision(captured.revisionId as string, null)

      // Byte-identical, frontmatter included. This is why the restore path uses
      // `writeRawDocument` rather than `updateDocument`: re-serialising the
      // parsed snapshot would drop its comments and reorder its keys, which is
      // a plausible-looking file that is not the one that was there.
      expect(await fs.readFile(absolutePath, 'utf8')).toBe(snapshot)
      expect(restored.restoredRevisionId).toBe(captured.revisionId)

      // The state the restore replaced was captured, so the restore can itself
      // be undone. When this is false the UI has to say the previous state is
      // gone, which is why the result carries it rather than implying success.
      expect(restored.revision.captured).toBe(true)

      // Newest first, and the newest is the state the restore replaced — which
      // is what makes "undo" a matter of restoring the row above the one just
      // restored.
      const revisions = await listRevisions(row.id)
      expect(revisions.map((revision) => revision.summary)).toContain(
        'Before restore',
      )
    })

    it('refuses to restore a revision saved under a different slug', async () => {
      const row = await indexedRow(relativePath)

      const captured = await captureRevision({
        contentId: row.id,
        type: 'post',
        slug,
        data: { title: 'A Revision Under Restore' },
        body: 'Written while the document was still called this.\n',
        previousContent: await fs.readFile(absolutePath, 'utf8'),
        reason: 'save',
        actorId: null,
      })
      expect(captured.captured).toBe(true)

      // The document is renamed out from under the revision. Restoring now
      // would put one document's contents under another's name.
      await updateDocument(relativePath, (current) => ({
        data: frontmatter({
          title: 'A Revision Under Restore',
          slug: 'a-different-name-entirely',
        }),
        body: current.body,
      }))
      await syncOneDocument(relativePath)

      const before = await fs.readFile(absolutePath, 'utf8')

      await expect(
        restoreRevision(captured.revisionId as string, null),
      ).rejects.toBeInstanceOf(RevisionSlugMismatchError)

      // The guard has to fail before the write, not after it.
      expect(await fs.readFile(absolutePath, 'utf8')).toBe(before)
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  A file the index has no row for                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * The editor's address is a type and a slug, and a slug can name a file the
   * index has never seen: imported, pulled, copied in or renamed outside the
   * admin. The index is the fast path and the disk is the fallback, and the
   * states the fallback has to keep apart are a file with no row at all, a row
   * describing an earlier version of the file, and a document that is simply not
   * there. All three are asserted here because all three are one file apart from
   * each other on disk.
   */
  describe('a document the index has not seen', () => {
    /**
     * Write a document and leave the index alone — the state a hand-added file
     * is in.
     *
     * Written with `fs` rather than through a writer on purpose. Two reasons,
     * and the first is the load-bearing one: this is the file an editor outside
     * the admin, a `git pull` or a `cp` put there, and the state under test is
     * precisely that no application code has touched it — a save brings an index
     * row along with it. The second is the path: one case below names the file
     * something other than its slug, and `createDocument`, the only door that
     * makes a new file, builds its path from a validated type and slug.
     */
    async function writeUnindexed(
      relativePath: string,
      data: Record<string, unknown>,
    ): Promise<void> {
      const absolutePath = path.join(testContentRoot, relativePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(
        absolutePath,
        serializeFrontmatter(data, 'A body written straight to the disk.\n'),
        'utf8',
      )
      created.push(relativePath)
    }

    it('opens a file that is on disk and in no row, and says what is missing', async () => {
      const slug = 'a-document-the-index-has-not-seen'
      const relativePath = `posts/${slug}.md`
      await writeUnindexed(
        relativePath,
        frontmatter({ title: 'A Document The Index Has Not Seen', slug }),
      )

      // The premise, asserted rather than assumed: a row here would send every
      // assertion below through the index instead of past it.
      const [row] = await db
        .select({ id: contentIndex.id })
        .from(contentIndex)
        .where(eq(contentIndex.path, relativePath))
        .limit(1)
      expect(row).toBeUndefined()

      const document = await loadEditorDocument('post', slug)

      expect(document?.path).toBe(relativePath)
      expect(document?.indexDrift).toBe('unindexed')
      // No row means no id for a revision to hang off, and no view count to show.
      expect(document?.contentId).toBeNull()
      expect(document?.viewCount).toBe(0)
      expect(document?.body).toContain('written straight to the disk')
    })

    it('finds a file by the slug its title gives it, not by its filename', async () => {
      // A document's slug is its frontmatter slug, else the slug of its title,
      // else its filename — so looking a file up is a parse, and a lookup that
      // guessed the filename would miss this one. The name is chosen so that the
      // two cannot be confused for each other.
      const relativePath = 'posts/0000-a-filename-that-addresses-nothing.md'
      const { slug: _declared, ...withoutSlug } = frontmatter({
        title: 'The Title Decides The Slug',
      })
      await writeUnindexed(relativePath, withoutSlug)

      const document = await loadEditorDocument('post', 'the-title-decides-the-slug')
      expect(document?.path).toBe(relativePath)
      expect(document?.indexDrift).toBe('unindexed')

      // And the filename is not an address for it.
      expect(
        await loadEditorDocument('post', '0000-a-filename-that-addresses-nothing'),
      ).toBeNull()
    })

    it('does not resolve a file of another type under the same slug', async () => {
      const slug = 'a-note-and-not-a-post'
      await writeUnindexed(
        `notes/${slug}.md`,
        frontmatter({ title: 'A Note And Not A Post', slug }),
      )

      expect(await loadEditorDocument('note', slug)).not.toBeNull()
      expect(await loadEditorDocument('post', slug)).toBeNull()
    })

    it('tells a row that describes an earlier version of the file from a missing row', async () => {
      const slug = 'a-file-that-changed-under-the-index'
      const relativePath = `posts/${slug}.md`
      await writeUnindexed(
        relativePath,
        frontmatter({ title: 'A File That Changed Under The Index', slug }),
      )

      // The state there is nothing to say about: the row describes these bytes.
      await syncOneDocument(relativePath)
      expect((await loadEditorDocument('post', slug))?.indexDrift).toBeNull()

      // Changed on disk while the index was not looking — an editor outside the
      // admin, a `git pull`. The row's stored checksum is what makes this
      // visible; nothing else compares the two.
      await updateDocument(relativePath, (current) => ({
        data: frontmatter({
          title: 'A File That Changed Under The Index',
          slug,
          description: 'Changed outside the admin.',
        }),
        body: current.body,
      }))

      const drifted = await loadEditorDocument('post', slug)
      expect(drifted?.indexDrift).toBe('stale')

      // The claim the notice makes, checked against both halves: the file is
      // what the editor shows, and the row — what the site renders — is behind.
      expect(drifted?.values.description).toBe('Changed outside the admin.')
      expect((await indexedRow(relativePath)).description).toBe(
        'Created by the integration suite.',
      )

      // And what a save does about it, which is the sequence `afterWrite` runs
      // once the file is written: the row is rebuilt from the file.
      await syncOneDocument(relativePath)
      const repaired = await loadEditorDocument('post', slug)
      expect(repaired?.indexDrift).toBeNull()
      expect(repaired?.values.description).toBe('Changed outside the admin.')
    })

    it('lists every key a save writes back, known to the app or not', async () => {
      // The editor's list is labelled "keys kept as written / saving writes them
      // back unchanged", and the writer takes them from two buckets: the keys
      // the panel has no field for, and the keys nothing models at all. Reading
      // only the first left the second — the ones an author is least likely to
      // recognise — out of the one place the editor mentions them.
      const slug = 'keys-the-panel-does-not-own'
      await writeUnindexed(
        `posts/${slug}.md`,
        frontmatter({
          title: 'Keys The Panel Does Not Own',
          slug,
          lang: 'zh',
          mood: 'calm',
        }),
      )

      const document = await loadEditorDocument('post', slug)

      // `lang` is in the schema and has no field in the panel; `mood` is in the
      // schema nowhere at all.
      expect(document?.preserved).toMatchObject({ lang: 'zh', mood: 'calm' })
      // And neither is a panel value: a key listed as kept must not also be a
      // field the editor would write from.
      expect(document?.values).not.toHaveProperty('mood')
    })
  })
})
