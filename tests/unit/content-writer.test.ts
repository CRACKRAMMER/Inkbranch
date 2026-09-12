import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFrontmatter } from '@/lib/content/frontmatter'
import { CONTENT_ROOT, LOCK_DIR, TMP_DIR, documentPath, lockPath } from '@/lib/content/paths'
import { readDocument } from '@/lib/content/reader'
import {
  ContentLockError,
  ContentWriteError,
  createDocument,
  deleteDocument,
  importDocument,
  sweepOrphanTempFiles,
  updateDocument,
  writeDocument,
  writeRawDocument,
} from '@/lib/content/writer'

/**
 * The write path.
 *
 * The contract these tests exist to hold the implementation to: **a failed save
 * never damages the file that was already there.** Everything else in the
 * content engine can be recovered from; a mangled article cannot.
 *
 * The content root is redirected to a throwaway directory by `tests/setup.ts`.
 * The assertion below turns "I forgot to redirect it" from a silent write into
 * the repository's real `content/` tree into a loud failure.
 */
if (!CONTENT_ROOT.startsWith(os.tmpdir())) {
  throw new Error(`Content tests refuse to run against ${CONTENT_ROOT}`)
}

/** Unique per call, so no two tests in this file can collide on a slug. */
let counter = 0
function uniqueSlug(prefix = 'doc'): string {
  counter += 1
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`
}

const documents: string[] = []

afterEach(async () => {
  // Documents written by the test that just ran, plus every lock file — the
  // timeout test deliberately leaves a lock behind, because a caller that never
  // acquired one has nothing to release it with.
  await Promise.all(documents.splice(0).map((file) => fs.unlink(file).catch(() => undefined)))
  const locks = await fs.readdir(LOCK_DIR).catch(() => [] as string[])
  await Promise.all(
    locks.map((name) => fs.unlink(path.join(LOCK_DIR, name)).catch(() => undefined)),
  )
})

describe('createDocument', () => {
  it('creates a file and reports it as new', async () => {
    const slug = uniqueSlug()
    const result = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Hello', date: '2024-01-01' },
      body: 'Body text.\n',
    })
    documents.push(result.absolutePath)

    expect(result.created).toBe(true)
    expect(result.previousContent).toBeNull()
    expect(result.relativePath).toBe(`posts/${slug}.md`)
    expect(result.byteSize).toBeGreaterThan(0)

    const onDisk = await fs.readFile(result.absolutePath, 'utf8')
    // The serializer quotes plain strings so that a title looking like a date
    // or a number stays a string when it is read back.
    expect(onDisk).toContain('title: "Hello"')
    expect(onDisk).toContain('Body text.')
  })

  it('refuses to overwrite an existing document', async () => {
    const slug = uniqueSlug()
    const first = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Original' },
      body: 'Original body.\n',
    })
    documents.push(first.absolutePath)

    await expect(
      createDocument({
        type: 'post',
        slug,
        data: { title: 'Replacement' },
        body: 'Replacement body.\n',
      }),
    ).rejects.toBeInstanceOf(ContentWriteError)

    // The point of the refusal: the original is still exactly what it was.
    const onDisk = await fs.readFile(first.absolutePath, 'utf8')
    expect(onDisk).toContain('Original body.')
    expect(onDisk).not.toContain('Replacement')
  })

  it('rejects a slug that could escape the content root', async () => {
    await expect(
      createDocument({
        type: 'post',
        slug: '../../etc/passwd',
        data: { title: 'x' },
        body: '',
      }),
    ).rejects.toThrow(/separator/)
  })
})

describe('writeDocument', () => {
  it('returns the previous contents so a revision can be recorded', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'v1' },
      body: 'First.\n',
    })
    documents.push(created.absolutePath)

    const second = await writeDocument({
      relativePath: created.relativePath,
      data: { title: 'v2' },
      body: 'Second.\n',
    })

    expect(second.previousContent).toContain('title: "v1"')
    expect(second.previousContent).toContain('First.')
    expect(second.created).toBe(false)
    expect(second.checksum).not.toBe(created.checksum)

    const onDisk = await fs.readFile(created.absolutePath, 'utf8')
    expect(onDisk).toContain('Second.')
    expect(onDisk).not.toContain('First.')
  })

  it('reports the same checksum when the bytes are unchanged', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Stable' },
      body: 'Same.\n',
    })
    documents.push(created.absolutePath)

    const again = await writeDocument({
      relativePath: created.relativePath,
      data: { title: 'Stable' },
      body: 'Same.\n',
    })

    expect(again.checksum).toBe(created.checksum)
  })

  it('leaves no temporary file behind after a successful write', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Clean' },
      body: 'Body.\n',
    })
    documents.push(created.absolutePath)

    const leftovers = (await fs.readdir(TMP_DIR)).filter((name) =>
      name.startsWith(`posts_${slug}`),
    )
    expect(leftovers).toEqual([])
  })

  it('writes after the working directories are cleared underneath it', async () => {
    // A content root can be emptied while a server is running: an operator
    // clearing it, a deploy mounting an empty volume, a harness rebuilding it
    // between runs. The directories a write needs are created by that write,
    // not remembered as created once per process — otherwise the first save
    // after the clear fails with ENOENT on a temp file whose directory is gone,
    // and the admin is told the server hit an unexpected error.
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Survivor' },
      body: 'First version.\n',
    })
    documents.push(created.absolutePath)

    await fs.rm(TMP_DIR, { recursive: true, force: true })

    const rewritten = await writeDocument({
      relativePath: created.relativePath,
      data: { title: 'Survivor' },
      body: 'Second version.\n',
    })

    expect(rewritten.previousContent).toContain('First version.')
    expect(await fs.readFile(created.absolutePath, 'utf8')).toContain('Second version.')
  })

  it('does not damage the file when the new content cannot be serialised', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Safe' },
      body: 'Untouched.\n',
    })
    documents.push(created.absolutePath)

    // A value that blows up when it is read. This stands in for any failure
    // between "start writing" and "rename into place": whatever goes wrong, the
    // rename must not happen.
    const unrepresentable: Record<string, unknown> = {}
    Object.defineProperty(unrepresentable, 'title', {
      enumerable: true,
      get() {
        throw new TypeError('cannot be represented')
      },
    })

    await expect(
      writeDocument({
        relativePath: created.relativePath,
        data: unrepresentable,
        body: 'Should never land.\n',
      }),
    ).rejects.toBeInstanceOf(ContentWriteError)

    const onDisk = await fs.readFile(created.absolutePath, 'utf8')
    expect(onDisk).toContain('Untouched.')
    expect(onDisk).not.toContain('Should never land.')
  })
})

describe('locking', () => {
  it('times out rather than interleaving with a live lock, and writes nothing', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Locked' },
      body: 'Original.\n',
    })
    documents.push(created.absolutePath)

    // A lock this young is never treated as stale, whatever pid it names, so
    // the write has to wait and then give up.
    await fs.writeFile(
      lockPath(created.relativePath),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    )

    await expect(
      writeDocument({
        relativePath: created.relativePath,
        data: { title: 'Racer' },
        body: 'Should never land.\n',
      }),
    ).rejects.toBeInstanceOf(ContentLockError)

    const onDisk = await fs.readFile(created.absolutePath, 'utf8')
    expect(onDisk).toContain('Original.')
    expect(onDisk).not.toContain('Should never land.')
  }, 20_000)

  it('steals a lock left behind by a process that is gone', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Abandoned' },
      body: 'Original.\n',
    })
    documents.push(created.absolutePath)

    const file = lockPath(created.relativePath)
    // A pid above `pid_max` cannot name a live process, and the mtime is past
    // the stale window: exactly the shape of a process that died mid-write.
    await fs.writeFile(file, JSON.stringify({ pid: 2 ** 30, at: '2020-01-01T00:00:00Z' }))
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(file, old, old)

    const result = await writeDocument({
      relativePath: created.relativePath,
      data: { title: 'Recovered' },
      body: 'New contents.\n',
    })

    expect(result.previousContent).toContain('Original.')
    expect(await fs.readFile(created.absolutePath, 'utf8')).toContain('New contents.')
  }, 20_000)

  it('does not lose an edit when many updates race', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Concurrent' },
      body: 'Start.\n',
    })
    documents.push(created.absolutePath)

    // Each update appends one line under the lock. If the read-modify-write
    // were not serialised, the later writer would read a stale body and the
    // earlier line would vanish.
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        updateDocument(created.relativePath, (current) => ({
          data: { ...current.extra, title: current.title },
          body: `${current.body.trimEnd()}\nline-${index}\n`,
        })),
      ),
    )

    const final = await fs.readFile(created.absolutePath, 'utf8')
    for (let index = 0; index < 6; index += 1) {
      expect(final).toContain(`line-${index}`)
    }
  }, 30_000)
})

describe('updateDocument', () => {
  it('hands the callback the freshly read document, not a cached one', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'First title' },
      body: 'Body.\n',
    })
    documents.push(created.absolutePath)

    const seen: string[] = []
    await updateDocument(created.relativePath, (current) => {
      seen.push(current.title)
      return { data: { ...current.extra, title: 'Second title' }, body: current.body }
    })
    await updateDocument(created.relativePath, (current) => {
      seen.push(current.title)
      return { data: { ...current.extra, title: current.title }, body: current.body }
    })

    expect(seen).toEqual(['First title', 'Second title'])
  })

  it('reports a missing document rather than creating one', async () => {
    await expect(
      updateDocument(`posts/${uniqueSlug('absent')}.md`, (current) => ({
        data: { title: current.title },
        body: current.body,
      })),
    ).rejects.toBeInstanceOf(ContentWriteError)
  })

  it('keeps unknown frontmatter keys across a metadata edit', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Has Extras' },
      body: 'Body.\n',
      extra: { customField: 'kept', another: 42 },
    })
    documents.push(created.absolutePath)

    await updateDocument(created.relativePath, (current) => ({
      data: { ...current.extra, title: 'Renamed' },
      body: current.body,
    }))

    const parsed = parseFrontmatter(await fs.readFile(created.absolutePath, 'utf8'))
    expect(parsed.data.customField).toBe('kept')
    expect(parsed.data.another).toBe(42)
    expect(parsed.data.title).toBe('Renamed')
  })
})

describe('deleteDocument', () => {
  it('returns the contents so a final revision can be kept', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Doomed' },
      body: 'Last words.\n',
    })

    const removed = await deleteDocument(created.relativePath)
    expect(removed?.content).toContain('Last words.')
    await expect(fs.stat(created.absolutePath)).rejects.toThrow()
  })

  it('returns null when there is nothing to delete', async () => {
    expect(await deleteDocument(`posts/${uniqueSlug('nothing')}.md`)).toBeNull()
  })
})

describe('writeRawDocument and importDocument', () => {
  it('reproduces raw bytes exactly, including a frontmatter comment', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: { title: 'Original' },
      body: 'Body.\n',
    })
    documents.push(created.absolutePath)

    // Deliberately awkward: a comment and a key order that a round trip
    // through the parser and serialiser would not reproduce.
    const raw = [
      '---',
      '# a comment the author wrote',
      'title: "Restored"',
      'tags: [a, b]',
      '---',
      '',
      'Restored body.',
      '',
    ].join('\n')

    await writeRawDocument(created.relativePath, raw)
    expect(await fs.readFile(created.absolutePath, 'utf8')).toBe(raw)
  })

  it('imports without touching the original bytes', async () => {
    const slug = uniqueSlug('imported')
    const raw = '---\ntitle: Imported\ncustom: kept\n---\n\nBody.\n'

    const result = await importDocument({
      type: 'post',
      slug,
      content: raw,
      overwrite: false,
    })
    documents.push(documentPath(result.relativePath))

    expect(result.skipped).toBe(false)
    expect(await fs.readFile(documentPath(result.relativePath), 'utf8')).toBe(raw)
  })

  it('skips an existing document unless overwrite is asked for', async () => {
    const slug = uniqueSlug('existing')
    const first = await importDocument({
      type: 'post',
      slug,
      content: '---\ntitle: First\n---\n\nOne.\n',
      overwrite: false,
    })
    documents.push(documentPath(first.relativePath))

    const skipped = await importDocument({
      type: 'post',
      slug,
      content: '---\ntitle: Second\n---\n\nTwo.\n',
      overwrite: false,
    })
    expect(skipped.skipped).toBe(true)
    expect(await fs.readFile(documentPath(first.relativePath), 'utf8')).toContain('One.')

    const replaced = await importDocument({
      type: 'post',
      slug,
      content: '---\ntitle: Second\n---\n\nTwo.\n',
      overwrite: true,
    })
    expect(replaced.skipped).toBe(false)
    expect(await fs.readFile(documentPath(first.relativePath), 'utf8')).toContain('Two.')
  })
})

describe('sweepOrphanTempFiles', () => {
  it('removes stale temporaries and keeps recent ones', async () => {
    await fs.mkdir(TMP_DIR, { recursive: true })
    const stale = path.join(TMP_DIR, 'stale-test.tmp')
    const fresh = path.join(TMP_DIR, 'fresh-test.tmp')
    await fs.writeFile(stale, 'x')
    await fs.writeFile(fresh, 'x')

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)

    const removed = await sweepOrphanTempFiles()

    expect(removed).toBeGreaterThanOrEqual(1)
    await expect(fs.stat(stale)).rejects.toThrow()
    // A young temp file may belong to a write that is still in flight.
    await expect(fs.stat(fresh)).resolves.toBeDefined()
    await fs.unlink(fresh)
  })
})

describe('readDocument', () => {
  it('parses frontmatter, body and derived metadata', async () => {
    const slug = uniqueSlug()
    const created = await createDocument({
      type: 'post',
      slug,
      data: {
        title: 'A Real Post',
        date: '2024-03-04',
        description: 'Short summary.',
        tags: ['typescript', 'postgres'],
      },
      body: '## Section one\n\nSome prose here.\n\n## Section two\n\nMore prose.\n',
    })
    documents.push(created.absolutePath)

    const document = await readDocument(created.relativePath)
    expect(document).not.toBeNull()
    expect(document?.title).toBe('A Real Post')
    expect(document?.type).toBe('post')
    expect(document?.tags).toEqual(['typescript', 'postgres'])
    // Slug precedence: an explicit `slug` wins, then the title, and the
    // filename is only the last resort. This file declares neither, so the
    // title decides — not the `doc-<n>-<random>` filename.
    expect(document?.slug).toBe('a-real-post')
    expect(document?.headings.map((heading) => heading.text)).toEqual([
      'Section one',
      'Section two',
    ])
    expect(document?.headings.map((heading) => heading.id)).toEqual([
      'section-one',
      'section-two',
    ])
    expect(document?.headings[0]?.level).toBe(2)
    expect(document?.wordCount).toBeGreaterThan(0)
    expect(document?.checksum).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns null for a file that is not there', async () => {
    expect(await readDocument(`posts/${uniqueSlug('missing')}.md`)).toBeNull()
  })

  it('refuses a path that leaves the content root', async () => {
    // Throwing, rather than returning null: a path like this is a bug or an
    // attack, and neither should look the same as "no such article".
    expect(() => documentPath('../../etc/passwd')).toThrow(/escapes the content root/)
  })

  it('recognises a file written with CRLF line endings', async () => {
    const slug = uniqueSlug('crlf')
    const relativePath = `posts/${slug}.md`
    documents.push(documentPath(relativePath))

    await fs.mkdir(path.dirname(documentPath(relativePath)), { recursive: true })
    await fs.writeFile(documentPath(relativePath), '---\r\ntitle: Windows\r\n---\r\n\r\nBody.\r\n')

    const document = await readDocument(relativePath)
    expect(document?.title).toBe('Windows')
    expect(document?.body).toContain('Body.')
  })
})

describe('status resolution', () => {
  /** Write a file directly, so frontmatter can be spelled exactly. */
  async function writeRaw(frontmatter: string): Promise<string> {
    const relativePath = `posts/${uniqueSlug('status')}.md`
    documents.push(documentPath(relativePath))
    await fs.mkdir(path.dirname(documentPath(relativePath)), { recursive: true })
    await fs.writeFile(documentPath(relativePath), `---\n${frontmatter}\n---\n\nBody.\n`)
    return relativePath
  }

  it('reads the most ordinary file there is', async () => {
    // A title and a body, no date. Before this rule existed, this file failed
    // validation with "status published requires a date" and could not be read
    // at all — which is a remarkable thing to do to the common case.
    const document = await readDocument(await writeRaw('title: Just A Title'))
    expect(document?.title).toBe('Just A Title')
    expect(document?.status).toBe('draft')
    expect(document?.publishedAt).toBeNull()
  })

  it('publishes an undated file as soon as it has a date', async () => {
    const document = await readDocument(await writeRaw('title: Dated\ndate: 2024-01-02'))
    expect(document?.status).toBe('published')
    expect(document?.publishedAt?.toISOString().slice(0, 10)).toBe('2024-01-02')
  })

  it('lets an explicit status override the date', async () => {
    const drafted = await readDocument(
      await writeRaw('title: Held Back\ndate: 2024-01-02\nstatus: draft'),
    )
    expect(drafted?.status).toBe('draft')

    const archived = await readDocument(
      await writeRaw('title: Old\ndate: 2024-01-02\nstatus: archived'),
    )
    expect(archived?.status).toBe('archived')
  })

  it('rejects a file that claims to be published without a date', async () => {
    // A genuine contradiction, and the one case where failing loudly is right:
    // the author has asserted something the rest of the system cannot honour.
    const relativePath = await writeRaw('title: Contradiction\nstatus: published')
    await expect(readDocument(relativePath)).rejects.toThrow(/requires a date/)
  })

  it('treats `draft: true` as a draft and `draft: false` as undecided', async () => {
    const flagged = await readDocument(await writeRaw('title: WIP\ndraft: true'))
    expect(flagged?.status).toBe('draft')

    // `draft: false` says "not a draft", not "publish this now". With no date
    // it stays a draft rather than failing validation.
    const cleared = await readDocument(await writeRaw('title: Cleared\ndraft: false'))
    expect(cleared?.status).toBe('draft')

    const dated = await readDocument(
      await writeRaw('title: Cleared\ndraft: false\ndate: 2024-03-04'),
    )
    expect(dated?.status).toBe('published')
  })
})

describe('frontmatter round trip through the writer', () => {
  it('survives write then read unchanged', async () => {
    const created = await createDocument({
      type: 'note',
      slug: uniqueSlug('roundtrip'),
      data: {
        title: 'Round Trip',
        date: '2024-05-06',
        tags: ['one', 'two'],
        seo: { noindex: true, description: 'Crawler summary.' },
      },
      body: 'Text.\n',
    })
    documents.push(created.absolutePath)

    const parsed = parseFrontmatter(await fs.readFile(created.absolutePath, 'utf8'))
    expect(parsed.data.title).toBe('Round Trip')
    expect(parsed.data.date).toBe('2024-05-06')
    expect(parsed.data.tags).toEqual(['one', 'two'])
    expect(parsed.data.seo).toEqual({ noindex: true, description: 'Crawler summary.' })
  })

  it('drops a defaults-only seo block rather than writing noise', async () => {
    const created = await createDocument({
      type: 'note',
      slug: uniqueSlug('nodefaults'),
      data: { title: 'Quiet', seo: { noindex: false } },
      body: 'Text.\n',
    })
    documents.push(created.absolutePath)

    const parsed = parseFrontmatter(await fs.readFile(created.absolutePath, 'utf8'))
    expect(parsed.data.seo).toBeUndefined()
  })
})
