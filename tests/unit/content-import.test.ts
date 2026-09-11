import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IMPORT_LIMITS,
  ImportScanError,
  applyImport,
  collectExistingContent,
  importReportLines,
  inspectImportEntries,
  scanImportArchive,
  scanImportDirectory,
  scanImportFiles,
  type ImportCandidate,
  type ImportEntryInput,
  type ImportInspectOptions,
  type ImportProblemCode,
  type ImportScanOptions,
} from '@/lib/content/import'
import { CONTENT_ROOT, LOCK_DIR, documentPath } from '@/lib/content/paths'

/**
 * The import engine.
 *
 * The contract these tests hold the implementation to:
 *
 * 1. **A scan writes nothing.** The plan is a description, not the first half of
 *    the work. Every write test below therefore asserts on the tree *before*
 *    `applyImport` has run.
 * 2. **A source is never modified**, not even when a fix is applied.
 * 3. **Nothing a caller supplies becomes a path.** A name like
 *    `../../etc/passwd.md` is refused and reported, and the containment does not
 *    rest on the screen: the destination comes from the slug.
 *
 * The content root is redirected to a throwaway directory by `tests/setup.ts`;
 * the assertion below turns "I forgot to redirect it" into a loud failure
 * instead of writes into the repository's real `content/` tree.
 */
if (!CONTENT_ROOT.startsWith(os.tmpdir())) {
  throw new Error(`Content tests refuse to run against ${CONTENT_ROOT}`)
}

let counter = 0
function unique(prefix = 'doc'): string {
  counter += 1
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`
}

const created: string[] = []

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })),
  )
  const locks = await fs.readdir(LOCK_DIR).catch(() => [] as string[])
  await Promise.all(
    locks.map((name) => fs.unlink(path.join(LOCK_DIR, name)).catch(() => undefined)),
  )
})

/** Track a document this test caused to exist, so `afterEach` can remove it. */
function track(relativePath: string): string {
  const absolute = documentPath(relativePath)
  created.push(absolute)
  return absolute
}

function entry(
  sourcePath: string,
  content: string,
  extra: Partial<ImportEntryInput> = {},
): ImportEntryInput {
  return {
    sourcePath,
    bytes: Buffer.from(content, 'utf8'),
    ...extra,
  }
}

const POST: ImportInspectOptions = { type: 'post' }

function codes(candidate: ImportCandidate): ImportProblemCode[] {
  return candidate.problems.map((problem) => problem.code)
}

function inspect(entries: ImportEntryInput[], options: ImportInspectOptions = POST) {
  return inspectImportEntries(entries, options)
}

/** The same entries as a plan, which is the shape an upload arrives in. */
function planFor(
  entries: readonly ImportEntryInput[],
  options: ImportScanOptions & { overwrite?: boolean } = POST,
) {
  return scanImportFiles(
    entries.map((item) => ({
      name: item.sourcePath,
      data: item.bytes ?? Buffer.alloc(0),
    })),
    options,
  )
}

function byPath(plan: { entries: ImportCandidate[] }, sourcePath: string): ImportCandidate {
  const found = plan.entries.find((candidate) => candidate.sourcePath === sourcePath)
  if (!found) throw new Error(`no entry for ${sourcePath} in ${plan.entries.map((e) => e.sourcePath).join(', ')}`)
  return found
}

function byName(sourcePath: string, entries: readonly ImportCandidate[]): ImportCandidate {
  const found = entries.find((candidate) => candidate.sourcePath === sourcePath)
  if (!found) throw new Error(`no entry for ${sourcePath}`)
  return found
}

const DATED = '---\ntitle: A Post\ndate: 2026-01-02\n---\n\nBody text.\n'

/** A post with a title of its own, so no two tests can collide on a slug. */
function datedPost(title: string, body = 'Body text.'): string {
  return `---\ntitle: ${title}\ndate: 2026-01-02\n---\n\n${body}\n`
}

/* -------------------------------------------------------------------------- */
/*  Path screens                                                               */
/* -------------------------------------------------------------------------- */

describe('path screens', () => {
  it('refuses an entry that climbs out of its directory', () => {
    const [candidate] = inspect([
      entry('../../etc/passwd.md', '# stolen'),
    ]) as [ImportCandidate]

    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('path-traversal')
    expect(candidate.problems[0]?.suggestion).toMatch(/relative path/i)
  })

  it('refuses an absolute path and a drive-letter path', () => {
    const candidates = inspect([
      entry('/etc/passwd.md', '# stolen'),
      entry('C:\\Windows\\evil.md', '# stolen'),
    ])

    for (const candidate of candidates) {
      expect(candidate.action).toBe('reject')
      expect(codes(candidate)).toContain('absolute-path')
    }
  })

  it('refuses a name with control characters and one nested too deeply', () => {
    const deep = `${Array.from({ length: IMPORT_LIMITS.maxPathDepth + 1 }, (_, i) => `d${i}`).join('/')}/x.md`
    const candidates = inspect([
      entry('bad\u0000name.md', '# x'),
      entry(deep, '# x'),
    ])

    for (const candidate of candidates) {
      expect(candidate.action).toBe('reject')
      expect(codes(candidate)).toContain('unsupported-entry')
    }
  })

  it('never derives a destination from the entry name', () => {
    const [candidate] = inspect([
      entry('../../etc/passwd.md', '# stolen'),
    ]) as [ImportCandidate]

    // Whatever it reports, the path it would use is built from a slug and stays
    // inside the content tree.
    expect(candidate.targetPath).not.toContain('..')
    expect(candidate.targetPath.startsWith('/')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Slugs                                                                      */
/* -------------------------------------------------------------------------- */

describe('slug conflicts', () => {
  it('keeps both files when two claim the same slug, and says which was renamed', () => {
    const candidates = inspect([
      entry('a.md', '---\ntitle: Shared\ndate: 2026-01-01\n---\n\none\n'),
      entry('b.md', '---\ntitle: Shared\ndate: 2026-01-01\n---\n\ntwo\n'),
    ])

    const [first, second] = candidates as [ImportCandidate, ImportCandidate]
    expect(first.slug).toBe('shared')
    expect(second.slug).toBe('shared-2')
    expect(codes(second)).toContain('duplicate-slug')
    expect(second.problems.find((p) => p.code === 'duplicate-slug')?.suggestion).toContain(
      'shared-2',
    )
    expect(new Set(candidates.map((c) => c.targetPath)).size).toBe(2)
  })

  it('resolves a duplicate the same way whatever order the entries arrive in', () => {
    const a = entry('a.md', '---\ntitle: Shared\ndate: 2026-01-01\n---\n\none\n')
    const b = entry('b.md', '---\ntitle: Shared\ndate: 2026-01-01\n---\n\ntwo\n')

    const forward = inspect([a, b]).map((c) => [c.sourcePath, c.slug])
    const backward = inspect([b, a]).map((c) => [c.sourcePath, c.slug])
    expect(forward).toEqual(backward)
  })

  it('reports a slug that is already in the tree', () => {
    const slugs = new Set(['posts/taken'])
    const candidates = inspect(
      [
        entry('taken.md', '---\ntitle: Taken\ndate: 2026-01-01\n---\n\nbody\n'),
        entry('free.md', '---\ntitle: Free\ndate: 2026-01-01\n---\n\nbody\n'),
      ],
      { type: 'post', existing: slugs },
    )

    expect(codes(byName('taken.md', candidates))).toContain('slug-conflict')
    // The collision is reported, never silently renamed: the operator asked for
    // this slug, and `taken-2` would be a document nobody named.
    expect(byName('taken.md', candidates).slug).toBe('taken')
    expect(codes(byName('free.md', candidates))).not.toContain('slug-conflict')
  })

  it('does not report an entry as conflicting with itself', () => {
    const candidates = inspect(
      [entry('self.md', '---\ntitle: Self\ndate: 2026-01-01\n---\n\nbody\n')],
      { type: 'post', existing: new Set(['posts/self']) },
    )

    // The tree it is being compared against *is* this file when a directory is
    // scanned, so the caller passes no `existing` set — but if it does, the
    // entry is still not in conflict with anything but itself.
    expect(candidates).toHaveLength(1)
    expect((candidates[0] as ImportCandidate).action).toBe('create')
  })
})

/* -------------------------------------------------------------------------- */
/*  Frontmatter                                                                */
/* -------------------------------------------------------------------------- */

describe('frontmatter problems', () => {
  it('reports YAML it cannot parse, with the line the block starts on', () => {
    const [candidate] = inspect([
      entry('broken.md', '---\ntitle: [unclosed\ndate: 2026-01-01\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('invalid-frontmatter')
    expect(candidate.problems[0]?.line).toBe(1)
  })

  it('reports a bad date by name, not as a schema error with no explanation', () => {
    const [candidate] = inspect([
      entry('bad-date.md', '---\ntitle: Bad\ndate: 2026-13-45\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    const problem = candidate.problems.find((p) => p.code === 'invalid-date')
    expect(problem).toBeDefined()
    expect(problem?.severity).toBe('warning')
    expect(problem?.suggestion).toMatch(/YYYY-MM-DD/)
    expect(problem?.line).toBe(3)
    // The date is a field the site cannot do without, so the schema refuses the
    // file — and the report says *why* in the author's own terms rather than
    // quoting "Invalid input: expected date, received undefined".
    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('invalid-schema')
    expect(candidate.status).toBe('draft')
  })

  it('suggests an exact date line when the date is missing', () => {
    const [candidate] = inspect([
      entry('undated.md', '---\ntitle: Undated\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    const problem = candidate.problems.find((p) => p.code === 'missing-date')
    expect(problem?.severity).toBe('warning')
    expect(problem?.suggestion).toContain('date: YYYY-MM-DD')
    expect(candidate.status).toBe('draft')
  })

  it('refuses a published document with no date, which the schema itself rejects', () => {
    const [candidate] = inspect([
      entry('liar.md', '---\ntitle: Liar\nstatus: published\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('invalid-schema')
  })

  it('names unknown frontmatter keys without treating them as errors', () => {
    const [candidate] = inspect([
      entry('extra.md', '---\ntitle: Extra\ndate: 2026-01-01\nvscode: thing\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    const problem = candidate.problems.find((p) => p.code === 'unknown-frontmatter-key')
    expect(problem?.severity).toBe('info')
    expect(candidate.action).toBe('create')
  })

  it('missing description is a warning with an actionable suggestion', () => {
    const [candidate] = inspect([entry('plain.md', DATED)]) as [ImportCandidate]
    const problem = candidate.problems.find((p) => p.code === 'missing-description')
    expect(problem?.severity).toBe('warning')
    expect(problem?.suggestion).toMatch(/excerpt|description/i)
  })

  it('refuses a post with no title, and offers the derived one as a fix', () => {
    const source = '---\ndate: 2026-01-01\n---\n\n# Derived Heading\n\nbody\n'

    const [withoutFix] = inspect([entry('untitled.md', source)]) as [ImportCandidate]
    expect(withoutFix.action).toBe('reject')
    expect(codes(withoutFix)).toContain('missing-title')
    expect(withoutFix.fixes).toEqual({})

    const [withFix] = inspect([entry('untitled.md', source)], {
      type: 'post',
      applyTitleFix: true,
    }) as [ImportCandidate]
    expect(withFix.action).toBe('create')
    expect(codes(withFix)).toContain('missing-title')
    expect(withFix.fixes.title).toBe('Derived Heading')
    expect(
      withFix.problems.find((p) => p.code === 'missing-title')?.severity,
    ).toBe('warning')
  })

  it('reports a missing title once, not once per schema issue', () => {
    // The schema refuses the file *and* has an opinion about the missing title.
    // Both used to be reported, so the count said "2 missing titles" about one
    // file and offered two different things to do about it.
    const [candidate] = inspect([
      entry('untitled.md', '---\ndate: 2026-01-01\n---\n\nbody\n'),
    ]) as [ImportCandidate]

    expect(candidate.problems.filter((p) => p.code === 'missing-title')).toHaveLength(1)
  })

  it('titles a note from its content instead of refusing it', () => {
    const [candidate] = inspect(
      [entry('note.md', '# A Note\n\nbody\n')],
      { type: 'note' },
    ) as [ImportCandidate]

    expect(candidate.action).toBe('create')
    expect(candidate.title).toBe('A Note')
    expect(
      candidate.problems.find((p) => p.code === 'missing-title')?.severity,
    ).toBe('info')
  })
})

/* -------------------------------------------------------------------------- */
/*  Files that are not text                                                    */
/* -------------------------------------------------------------------------- */

describe('file screens', () => {
  it('rejects bytes that are not UTF-8', () => {
    const [candidate] = inspect([
      { sourcePath: 'latin1.md', bytes: Buffer.from([0x74, 0x69, 0x74, 0xff, 0xfe, 0x6c, 0x65]) },
    ]) as [ImportCandidate]

    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('invalid-encoding')
  })

  it('rejects an empty file and a non-Markdown file', () => {
    const candidates = inspect([
      entry('empty.md', ''),
      entry('diagram.png', 'not really a png'),
    ])

    expect(codes(byName('empty.md', candidates))).toContain('empty-file')
    const image = byName('diagram.png', candidates)
    expect(codes(image)).toContain('unsupported-extension')
    expect(image.action).toBe('reject')
  })

  it('only notes a non-Markdown file when a directory is being scanned', () => {
    const [image] = inspect([entry('diagram.png', 'x')], {
      type: 'post',
      nonMarkdownSeverity: 'info',
    }) as [ImportCandidate]

    expect(image.problems.every((p) => p.severity === 'info')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  Caps                                                                       */
/* -------------------------------------------------------------------------- */

describe('caps', () => {
  it('refuses a file over the per-file limit', () => {
    const big = Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 1, 0x61)
    const [candidate] = inspect([{ sourcePath: 'big.md', bytes: big }]) as [ImportCandidate]

    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('oversized-file')
    expect(candidate.problems[0]?.message).toContain('over the')
  })

  it('stops reading past the file-count cap and says so', () => {
    const candidates = inspect(
      [entry('a.md', DATED), entry('b.md', DATED), entry('c.md', DATED)],
      { type: 'post', maxFiles: 2 },
    )
    const rejected = candidates.filter((c) => c.action === 'reject')
    expect(rejected).toHaveLength(1)
    expect(codes(rejected[0] as ImportCandidate)).toContain('too-many-files')
  })

  it('stops a batch that would exceed the total byte cap', () => {
    const chunk = `---\ntitle: ${'x'.repeat(60)}\ndate: 2026-01-01\n---\n\nbody\n`
    const candidates = inspect(
      [entry('a.md', chunk), entry('b.md', chunk), entry('c.md', chunk)],
      { type: 'post', maxBatchBytes: 220 },
    )
    const rejected = candidates.filter((c) => c.action === 'reject')
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    expect(codes(rejected[rejected.length - 1] as ImportCandidate)).toContain('batch-too-large')
  })

  it('refuses an archive with more entries than the cap', () => {
    const zip = buildZip(
      Array.from({ length: IMPORT_LIMITS.maxArchiveEntries + 1 }, (_, i) => ({
        name: `file-${i}.md`,
        data: DATED,
      })),
    )

    try {
      scanImportArchive(zip, { type: 'post' })
      throw new Error('expected the archive to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportScanError)
      expect((error as ImportScanError).code).toBe('archive-too-many-entries')
    }
  })

  it('refuses an archive that expands beyond the byte cap', () => {
    const zip = buildZip(
      [{ name: 'big.md', data: DATED, declaredBytes: IMPORT_LIMITS.maxArchiveUncompressedBytes + 1 }],
      { pad: 1024 },
    )

    try {
      scanImportArchive(zip, { type: 'post' })
      throw new Error('expected the archive to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportScanError)
      expect((error as ImportScanError).code).toBe('archive-too-large')
    }
  })

  it('refuses a zip bomb by its compression ratio', () => {
    // 1 MiB of one repeated byte: ~1 KiB on the wire, and the ratio check is the
    // only thing standing between it and a gigabyte of written files.
    const zip = buildZip([{ name: 'bomb.md', data: 'a'.repeat(1024 * 1024) }])

    try {
      scanImportArchive(zip, { type: 'post' })
      throw new Error('expected the archive to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportScanError)
      expect((error as ImportScanError).code).toBe('archive-bomb')
    }
  })

  it('refuses a decompressed entry that lies about its size', () => {
    // The central directory claims 10 bytes; the deflate stream holds 200 KB.
    // The declared size is what an attacker controls, so the bytes that came out
    // are checked against it rather than believed.
    const zip = buildZip([{ name: 'liar.md', data: 'a'.repeat(200_000), declaredBytes: 10 }])

    const plan = scanImportArchive(zip, { type: 'post' })
    const candidate = plan.entries[0] as ImportCandidate
    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('unreadable')
  })

  it('refuses an entry that expands past the per-file limit', () => {
    // Random bytes, so the archive is *not* a good compression ratio and the
    // per-file limit is what refuses it rather than the bomb check.
    const zip = buildZip([
      {
        name: 'huge.md',
        data: randomBytes(IMPORT_LIMITS.maxFileBytes + 4096).toString('base64'),
      },
    ])

    const plan = scanImportArchive(zip, { type: 'post' })
    const candidate = plan.entries[0] as ImportCandidate
    expect(candidate.action).toBe('reject')
    expect(codes(candidate)).toContain('oversized-file')
  })
})

/* -------------------------------------------------------------------------- */
/*  Archives                                                                   */
/* -------------------------------------------------------------------------- */

describe('archives', () => {
  it('reads stored and deflated entries', () => {
    const zip = buildZip([
      { name: 'posts/stored.md', data: DATED, method: 0 },
      { name: 'posts/deflated.md', data: DATED.replace('A Post', 'B Post') },
    ])

    const plan = scanImportArchive(zip, { type: 'post' })
    expect(plan.entries).toHaveLength(2)
    expect(plan.counts.create).toBe(2)
    expect(plan.entries.every((e) => e.bytes > 0)).toBe(true)
  })

  it('reports a traversal entry instead of importing it', () => {
    const zip = buildZip([
      { name: '../../etc/passwd.md', data: '# pwned' },
      { name: 'posts/ok.md', data: DATED },
    ])

    const plan = scanImportArchive(zip, { type: 'post' })
    const evil = plan.entries.find((e) => e.sourcePath.includes('passwd')) as ImportCandidate

    expect(evil.action).toBe('reject')
    expect(codes(evil)).toContain('path-traversal')
    expect(plan.counts.create).toBe(1)
  })

  it('reports a nested archive entry, which nothing here would unpack anyway', () => {
    const zip = buildZip([{ name: 'inner.zip', data: 'PK\u0003\u0004' }])
    const plan = scanImportArchive(zip, { type: 'post' })

    expect((plan.entries[0] as ImportCandidate).action).toBe('reject')
    expect(codes(plan.entries[0] as ImportCandidate)).toContain('unsupported-entry')
  })

  it('refuses a file that is not a ZIP at all', () => {
    try {
      scanImportArchive(Buffer.from('this is a markdown file, not an archive'), {
        type: 'post',
      })
      throw new Error('expected the archive to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportScanError)
      expect((error as ImportScanError).code).toBe('archive-unreadable')
    }
  })

  it('takes the type from the archive layout', () => {
    const zip = buildZip([
      { name: 'posts/one.md', data: DATED },
      { name: 'notes/two.md', data: '# Two\n\nbody\n' },
    ])

    const plan = scanImportArchive(zip, { type: 'post' })
    expect(byPath(plan, 'posts/one.md').type).toBe('post')
    expect(byPath(plan, 'notes/two.md').type).toBe('note')
    expect(byPath(plan, 'notes/two.md').typeSource).toBe('layout')
  })

  it('lets an explicit --type override the layout', () => {
    const zip = buildZip([{ name: 'posts/one.md', data: '# One\n\nbody\n' }])
    const plan = scanImportArchive(zip, { type: 'note', forceType: true })

    expect((plan.entries[0] as ImportCandidate).type).toBe('note')
    expect((plan.entries[0] as ImportCandidate).typeSource).toBe('flag')
  })
})

/* -------------------------------------------------------------------------- */
/*  Links                                                                      */
/* -------------------------------------------------------------------------- */

describe('link checks', () => {
  it('resolves a link to another file in the batch and reports one that does not', () => {
    const candidates = inspect(
      [
        entry(
          'a.md',
          '---\ntitle: A\ndate: 2026-01-01\n---\n\nSee [B](/posts/b) and [missing](/posts/nope).\n',
        ),
        entry('b.md', '---\ntitle: B\ndate: 2026-01-01\n---\n\nbody\n'),
      ],
      // An empty index: the batch is the only thing there is to resolve against.
      { type: 'post', knownTargets: new Set() },
    )

    const problems = byName('a.md', candidates).problems.filter((p) => p.code === 'broken-link')
    expect(problems).toHaveLength(1)
    expect(problems[0]?.message).toContain('/posts/nope')
    // The file's line, not the body's: the frontmatter is five lines.
    expect(problems[0]?.line).toBe(6)
  })

  it('reports a wiki link that resolves to nothing', () => {
    const candidates = inspect(
      [entry('a.md', '---\ntitle: A\ndate: 2026-01-01\n---\n\nSee [[Nowhere]].\n')],
      { type: 'post', knownTargets: new Set(['posts/nowhere-else']) },
    )

    expect(codes(byName('a.md', candidates))).toContain('broken-link')
  })

  it('says nothing about links when it was given no index to check against', () => {
    const candidates = inspect([
      entry('a.md', '---\ntitle: A\ndate: 2026-01-01\n---\n\nSee [x](/posts/anything).\n'),
    ])

    expect(codes(byName('a.md', candidates))).not.toContain('broken-link')
  })

  it('checks images once it knows what has been uploaded', () => {
    const body = '---\ntitle: A\ndate: 2026-01-01\n---\n\n![diagram](/uploads/2026/09/d.png)\n'

    const unchecked = inspect([entry('a.md', body)])
    expect(codes(byName('a.md', unchecked))).not.toContain('broken-image')

    const checked = inspect([entry('a.md', body)], {
      type: 'post',
      knownImages: new Set(['2026/09/other.png']),
    })
    const problem = byName('a.md', checked).problems.find((p) => p.code === 'broken-image')
    expect(problem?.severity).toBe('warning')
    expect(problem?.line).toBe(6)
  })
})

/* -------------------------------------------------------------------------- */
/*  Scanning a directory                                                       */
/* -------------------------------------------------------------------------- */

async function makeScannedTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myblog-import-'))
  await fs.mkdir(path.join(root, 'posts'), { recursive: true })
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'posts', 'one.md'), DATED)
  await fs.writeFile(path.join(root, 'notes', 'two.md'), '# Two\n\nbody\n')
  await fs.writeFile(path.join(root, 'diagram.png'), 'not really a png')
  await fs.symlink('/etc/passwd', path.join(root, 'escape.md'))
  return root
}

describe('scanImportDirectory', () => {
  it('walks a tree, infers types, and reports what it skipped', async () => {
    const root = await makeScannedTree()
    try {
      const plan = await scanImportDirectory(root, { type: 'post' })

      expect(plan.kind).toBe('directory')
      const paths = plan.entries.map((e) => e.sourcePath).sort()
      expect(paths).toEqual(['notes/two.md', 'posts/one.md'])
      expect(plan.entries.find((e) => e.slug === 'two')?.type).toBe('note')
      expect(plan.counts.create).toBe(2)

      const skipped = plan.problems.find((p) => p.code === 'unsupported-extension')
      expect(skipped?.path).toBe('diagram.png')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlink that points out of the scanned tree', async () => {
    const root = await makeScannedTree()
    try {
      const plan = await scanImportDirectory(root, { type: 'post' })
      const escape = plan.problems.find((p) => p.path === 'escape.md')

      expect(escape).toBeDefined()
      expect(escape?.code).toBe('path-traversal')
      expect(escape?.message).toMatch(/outside/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('writes nothing', async () => {
    const root = await makeScannedTree()
    try {
      const plan = await scanImportDirectory(root, { type: 'post' })
      expect(plan.counts.create).toBe(2)

      for (const candidate of plan.entries) {
        await expect(fs.stat(documentPath(candidate.targetPath))).rejects.toThrow()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('reports a directory it cannot read rather than returning an empty plan', async () => {
    await expect(
      scanImportDirectory(path.join(os.tmpdir(), 'myblog-does-not-exist-' + unique()), {
        type: 'post',
      }),
    ).rejects.toThrowError(ImportScanError)
  })
})

/* -------------------------------------------------------------------------- */
/*  Applying                                                                   */
/* -------------------------------------------------------------------------- */

describe('applyImport', () => {
  it('creates the file with the source bytes verbatim', async () => {
    const title = unique('Kept')
    // A frontmatter comment and an unknown key: neither survives a
    // re-serialisation, and both must survive an import.
    const source = `---\ntitle: ${title}\n# a comment the author wrote\nvscode: wordwrap\ndate: 2026-01-02\n---\n\nBody.\n`

    const plan = planFor([entry('kept.md', source)])
    const candidate = plan.entries[0] as ImportCandidate
    expect(candidate.action).toBe('create')

    const absolute = track(candidate.targetPath)
    await expect(fs.stat(absolute)).rejects.toThrow()

    const result = await applyImport(plan)
    expect(result.created).toBe(1)
    expect(result.failed).toBe(0)
    expect(await fs.readFile(absolute, 'utf8')).toBe(source)
  })

  it('is the only step that writes', async () => {
    const plan = planFor([entry('dry.md', datedPost(unique('Dry')))])
    const absolute = track((plan.entries[0] as ImportCandidate).targetPath)
    await expect(fs.stat(absolute)).rejects.toThrow()

    await applyImport(plan)
    await expect(fs.stat(absolute)).resolves.toBeDefined()
  })

  it('skips a document that already exists, and overwrites it only when told to', async () => {
    const first = planFor([entry('mine.md', datedPost(unique('Mine')))])
    await applyImport(first)
    const candidate = first.entries[0] as ImportCandidate
    const absolute = track(candidate.targetPath)

    const changed = datedPost(candidate.title, 'Replaced body.')
    const entries = [{ name: 'mine.md', data: Buffer.from(changed) }]
    const existing = new Set([`posts/${candidate.slug}`])

    const skipPlan = scanImportFiles(entries, { type: 'post', existing })
    expect((skipPlan.entries[0] as ImportCandidate).action).toBe('skip')
    const skipped = await applyImport(skipPlan)
    expect(skipped.skipped).toBe(1)
    expect(skipped.created).toBe(0)
    expect(await fs.readFile(absolute, 'utf8')).not.toBe(changed)

    const overwritePlan = scanImportFiles(entries, { type: 'post', existing, overwrite: true })
    expect((overwritePlan.entries[0] as ImportCandidate).action).toBe('overwrite')
    const overwritten = await applyImport(overwritePlan)
    expect(overwritten.overwritten).toBe(1)
    expect(overwritten.created).toBe(0)
    expect(await fs.readFile(absolute, 'utf8')).toBe(changed)
  })

  it('writes the derived title into the copy without touching the source', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myblog-import-fix-'))
    const sourcePath = path.join(root, 'untitled.md')
    const source = '---\ndate: 2026-01-02\n---\n\n# From The Heading\n\nbody\n'
    await fs.writeFile(sourcePath, source)

    try {
      const plan = await scanImportDirectory(root, { type: 'post', applyTitleFix: true })
      const candidate = plan.entries[0] as ImportCandidate
      expect(candidate.action).toBe('create')

      const absolute = track(candidate.targetPath)
      const result = await applyImport(plan, { applyFixes: true })

      expect(result.created).toBe(1)
      const written = await fs.readFile(absolute, 'utf8')
      expect(written).toContain('title: "From The Heading"')
      expect(written).toContain('date: "2026-01-02"')
      expect(written).toContain('body')
      // The source is not the copy: it is exactly as it was.
      expect(await fs.readFile(sourcePath, 'utf8')).toBe(source)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('reports a write that fails instead of claiming success', async () => {
    const source = datedPost(unique('Blocked'))
    const probe = planFor([entry('blocked.md', source)])
    const slug = (probe.entries[0] as ImportCandidate).slug
    const destination = documentPath(`posts/${slug}.md`)

    // A directory where the document should go, and a plan that says replace:
    // the atomic rename cannot put a file there, so the write genuinely fails.
    // (A plan that says *create* would skip instead, which is a different and
    // equally honest outcome — see the test above.)
    created.push(destination)
    await fs.mkdir(destination, { recursive: true })

    const plan = planFor([entry('blocked.md', source)], {
      type: 'post',
      existing: new Set([`posts/${slug}`]),
      overwrite: true,
    })
    expect((plan.entries[0] as ImportCandidate).action).toBe('overwrite')

    const result = await applyImport(plan)
    expect(result.failed).toBe(1)
    expect(result.created).toBe(0)
    expect(result.overwritten).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.files[0]?.outcome).toBe('failed')
    expect(result.files[0]?.message).toBeTruthy()
  })

  it('does not write a rejected file', async () => {
    const plan = scanImportFiles(
      [{ name: 'broken.md', data: Buffer.from('---\ntitle: [unclosed\n---\n\nbody\n') }],
      { type: 'post' },
    )
    const result = await applyImport(plan)

    expect(result.rejected).toBe(1)
    expect(result.created).toBe(0)
    expect(result.files).toHaveLength(0)
  })

  it('does not write anything out of an archive with a traversal entry', async () => {
    const zip = buildZip([
      { name: '../../etc/passwd.md', data: '# pwned' },
      { name: 'posts/harmless.md', data: DATED },
    ])
    const plan = scanImportArchive(zip, { type: 'post' })
    const created = plan.entries.filter((e) => e.action === 'create')

    for (const candidate of created) track(candidate.targetPath)
    const result = await applyImport(plan)

    expect(result.created).toBe(1)
    expect(result.rejected).toBe(1)
    for (const candidate of created) {
      expect(candidate.targetPath).not.toContain('..')
      expect(candidate.targetPath.startsWith('/')).toBe(false)
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Plan identity                                                              */
/* -------------------------------------------------------------------------- */

describe('the plan fingerprint', () => {
  it('is stable across scans of the same source and changes with the content', () => {
    const entries = [entry('a.md', DATED)]
    const first = planFor(entries)
    const second = planFor(entries)
    expect(first.fingerprint).toBe(second.fingerprint)

    const changed = planFor([entry('a.md', DATED.replace('Body text.', 'Other.'))])
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('does not depend on the order the source listed its entries', () => {
    const a = entry('a.md', DATED.replace('A Post', 'A'))
    const b = entry('b.md', DATED.replace('A Post', 'B'))

    expect(planFor([a, b]).fingerprint).toBe(planFor([b, a]).fingerprint)
  })

  it('changes when the decision changes, so a stale confirmation cannot be replayed', () => {
    const entries = [entry('a.md', DATED)]
    const existing = new Set(['posts/a-post'])

    const fresh = planFor(entries)
    const conflict = planFor(entries, { type: 'post', existing })

    expect(fresh.fingerprint).not.toBe(conflict.fingerprint)
  })
})

/* -------------------------------------------------------------------------- */
/*  Report                                                                     */
/* -------------------------------------------------------------------------- */

describe('importReportLines', () => {
  it('counts what will happen and what is wrong, in the shape the spec asks for', () => {
    const plan = planFor([
      entry('good.md', datedPost('Good', 'Body text here.')),
      entry('undated.md', '---\ntitle: Undated\n---\n\nbody\n'),
      entry('twin-one.md', datedPost('Twin')),
      entry('twin-two.md', datedPost('Twin')),
    ])

    const lines = importReportLines(plan).join('\n')
    expect(lines).toMatch(/^4 files scanned/m)
    expect(lines).toMatch(/✓ 4 to import/)
    expect(lines).toMatch(/⚠ \d+ missing dates/)
    expect(lines).toMatch(/⚠ 1 duplicate slugs/)
    expect(lines).toMatch(/words, about/)
  })

  it('marks a problem that stops an import differently from one that does not', () => {
    const plan = planFor([
      entry('broken.md', '---\ntitle: [unclosed\n---\n\nbody\n'),
      entry('undated.md', '---\ntitle: Undated\n---\n\nbody\n'),
    ])
    const lines = importReportLines(plan).join('\n')

    expect(lines).toMatch(/✗ 1 unparsable frontmatter/)
    expect(lines).toMatch(/⚠ \d+ missing dates/)
  })

  it('leads with the reason a file cannot be imported', () => {
    const plan = planFor([entry('broken.md', '---\ntitle: [unclosed\n---\n\nbody\n')])
    const lines = importReportLines(plan).join('\n')

    expect(lines).toMatch(/✗ 1 cannot be imported/)
    expect(lines).toMatch(/✗ 1 unparsable frontmatter/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Existing content                                                           */
/* -------------------------------------------------------------------------- */

describe('collectExistingContent', () => {
  it('reports the slugs and targets that already exist', async () => {
    const plan = planFor([entry('present.md', datedPost(unique('Present')))])
    const candidate = plan.entries[0] as ImportCandidate
    track(candidate.targetPath)
    await applyImport(plan)

    const existing = await collectExistingContent()
    expect(existing.slugs.has(`posts/${candidate.slug}`)).toBe(true)
    expect(existing.targets.has(`posts/${candidate.slug}`)).toBe(true)
    expect(existing.targets.has(`posts/${candidate.slug}.md`)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  A minimal ZIP writer, so the archive tests exercise the real reader         */
/* -------------------------------------------------------------------------- */

interface ZipSpec {
  name: string
  data: string
  /** 0 = stored, 8 = deflate. */
  method?: 0 | 8
  /**
   * What the central directory claims the entry expands to. A real archive
   * always tells the truth here; these tests need one that does not, because
   * the declared size is attacker-controlled and the reader must not trust it.
   */
  declaredBytes?: number
}

function buildZip(specs: ZipSpec[], options: { pad?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const pad = Buffer.alloc(options.pad ?? 0, 0x20)
  let offset = 0

  for (const spec of specs) {
    const raw = Buffer.from(spec.data, 'utf8')
    const method = spec.method ?? 8
    const stored = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(spec.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, stored, pad)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(spec.declaredBytes ?? raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + stored.length + pad.length
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(specs.length, 8)
  eocd.writeUInt16LE(specs.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, directory, eocd])
}
