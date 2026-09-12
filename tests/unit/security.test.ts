import { describe, expect, it } from 'vitest'
import {
  PathSecurityError,
  assertInside,
  assertSafeSlug,
  checkArchiveBudget,
  checkArchiveEntry,
  isInside,
  resolveRelative,
  safeJoin,
  sanitizeFilename,
  toPosix,
} from '@/lib/security/paths'
import { sanitizeSvg, sniffMime } from '@/lib/security/mime'
import { safeTagColor } from '@/lib/utils/tag-color'
import {
  isValidSlug,
  slugFromFilename,
  slugify,
  tagSlug,
  uniqueSlug,
} from '@/lib/utils/slug'
import { stripMarkdown, textStats } from '@/lib/utils/text'

/**
 * The boundary between "input from the admin" and "the filesystem and the
 * browser".
 *
 * Every case here is a bug that would otherwise ship as a file write outside the
 * content root, a zip bomb, a stored XSS, or a slug that cannot be stored — so
 * the adversarial inputs are the point and the happy paths exist mostly to prove
 * the guards leave the feature usable.
 */

const ROOT = '/var/content'
/** Shares a prefix with ROOT; `startsWith` would happily accept it. */
const SIBLING = '/var/content-secrets'

describe('isInside', () => {
  it('accepts a path nested below the root', () => {
    expect(isInside(ROOT, `${ROOT}/posts/2026/hello.md`)).toBe(true)
  })

  it('accepts the root itself', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
  })

  it('accepts a path that differs only by a ./ segment or a trailing separator', () => {
    expect(isInside(ROOT, `${ROOT}/./posts/`)).toBe(true)
  })

  it('rejects a sibling directory whose name merely shares the root prefix', () => {
    expect(isInside(ROOT, `${SIBLING}/key.pem`)).toBe(false)
    // Same trap for a relative root: both sides resolve against the cwd first.
    expect(isInside('content', 'content-secrets/key.pem')).toBe(false)
    expect(isInside('content', 'content/posts/hello.md')).toBe(true)
  })

  it('rejects the parent of the root', () => {
    expect(isInside(ROOT, '/var')).toBe(false)
  })

  it('rejects a traversal that climbs out and lands in a sibling', () => {
    expect(isInside(ROOT, `${ROOT}/../content-secrets/key.pem`)).toBe(false)
    expect(isInside(ROOT, '../content-secrets/key.pem')).toBe(false)
  })

  it('rejects a target on an unrelated branch of the filesystem', () => {
    expect(isInside(ROOT, '/etc/passwd')).toBe(false)
  })

  it('accepts an in-root file whose name begins with two dots', () => {
    // `..foo.md` is a legal filename, not a traversal: only a whole `..` segment
    // climbs out, and a prefix check that cannot tell the two apart would make
    // the app refuse to touch its own content.
    expect(isInside(ROOT, `${ROOT}/..foo.md`)).toBe(true)
    expect(isInside(ROOT, `${ROOT}/..2026/post.md`)).toBe(true)
  })

  it('still rejects a traversal that passes through a two-dot-prefixed directory', () => {
    expect(isInside(ROOT, `${ROOT}/..foo/../../etc/passwd`)).toBe(false)
  })
})

describe('assertInside', () => {
  it('returns the resolved absolute path', () => {
    expect(assertInside(ROOT, `${ROOT}/posts/../hello.md`)).toBe(`${ROOT}/hello.md`)
  })

  it('accepts the root itself', () => {
    expect(assertInside(ROOT, ROOT, 'content root')).toBe(ROOT)
  })

  it('throws a PathSecurityError that names the label and both paths', () => {
    expect(() => assertInside(ROOT, `${SIBLING}/key.pem`, 'asset')).toThrow(
      PathSecurityError,
    )
    expect(() => assertInside(ROOT, `${SIBLING}/key.pem`, 'asset')).toThrow(
      /Refusing to touch asset outside its root/,
    )
    expect(() => assertInside(ROOT, `${SIBLING}/key.pem`, 'asset')).toThrow(
      new RegExp(SIBLING),
    )
  })
})

describe('safeJoin', () => {
  it('joins segments onto the root', () => {
    expect(safeJoin(ROOT, 'posts', '2026', 'hello.md')).toBe(
      `${ROOT}/posts/2026/hello.md`,
    )
    expect(safeJoin(ROOT)).toBe(ROOT)
  })

  it('rejects an absolute segment instead of silently rebasing it', () => {
    expect(() => safeJoin(ROOT, '/etc/passwd')).toThrow(PathSecurityError)
    expect(() => safeJoin(ROOT, 'posts', '/etc/passwd')).toThrow(/Absolute path segment/)
  })

  it('rejects a parent-traversal segment', () => {
    expect(() => safeJoin(ROOT, '..')).toThrow(/Parent traversal/)
    expect(() => safeJoin(ROOT, '..', 'etc')).toThrow(PathSecurityError)
  })

  it('rejects traversal hidden inside a longer segment or behind a backslash', () => {
    expect(() => safeJoin(ROOT, 'posts/../../etc/passwd')).toThrow(/Parent traversal/)
    expect(() => safeJoin(ROOT, '..\\..\\windows\\win.ini')).toThrow(/Parent traversal/)
  })

  it('ignores empty segments so an optional path component can be absent', () => {
    expect(safeJoin(ROOT, '', 'a.md')).toBe(`${ROOT}/a.md`)
  })

  it('keeps a name that begins with two dots inside the root', () => {
    expect(safeJoin(ROOT, '..2026', 'post.md')).toBe(`${ROOT}/..2026/post.md`)
    expect(isInside(ROOT, safeJoin(ROOT, '..foo.md'))).toBe(true)
  })

  it('contains a name carrying a NUL rather than letting it escape', () => {
    // Control characters are screened by `sanitizeFilename`/`checkArchiveEntry`;
    // this function's promise is only containment, and that must hold anyway.
    expect(isInside(ROOT, safeJoin(ROOT, 'a\u0000b.md'))).toBe(true)
  })
})

describe('resolveRelative', () => {
  it('resolves a POSIX relative path under the root', () => {
    expect(resolveRelative(ROOT, 'posts/2026/hello.md')).toBe(
      `${ROOT}/posts/2026/hello.md`,
    )
  })

  it('drops a redundant ./ segment', () => {
    expect(resolveRelative(ROOT, 'posts/./hello.md')).toBe(`${ROOT}/posts/hello.md`)
  })

  it('treats a leading separator as root-relative rather than as an escape', () => {
    expect(resolveRelative(ROOT, '/posts/hello.md')).toBe(`${ROOT}/posts/hello.md`)
    expect(isInside(ROOT, resolveRelative(ROOT, '/etc/passwd'))).toBe(true)
  })

  it('converts Windows separators before splitting', () => {
    expect(resolveRelative(ROOT, 'posts\\2026\\hello.md')).toBe(
      `${ROOT}/posts/2026/hello.md`,
    )
  })

  it('rejects a .. segment', () => {
    expect(() => resolveRelative(ROOT, '../secrets/key.pem')).toThrow(PathSecurityError)
    expect(() => resolveRelative(ROOT, 'a/../../b')).toThrow(/Parent traversal/)
  })

  it('rejects .. hidden behind backslashes', () => {
    expect(() => resolveRelative(ROOT, '..\\..\\etc\\passwd')).toThrow(/Parent traversal/)
  })

  it('rejects an empty or root-only relative path', () => {
    expect(() => resolveRelative(ROOT, '')).toThrow(/Empty relative path/)
    expect(() => resolveRelative(ROOT, '/')).toThrow(/Empty relative path/)
    expect(() => resolveRelative(ROOT, '\\')).toThrow(/Empty relative path/)
  })

  it('does not decode percent-escapes, so encoded traversal can only name an in-root file', () => {
    const resolved = resolveRelative(ROOT, '%2e%2e%2f%2e%2e%2fetc/passwd')
    expect(isInside(ROOT, resolved)).toBe(true)
    // The escape survives as a literal filename; it does not become a separator.
    expect(resolved).toBe(`${ROOT}/%2e%2e%2f%2e%2e%2fetc/passwd`)
  })
})

describe('toPosix', () => {
  it('leaves an already-POSIX path unchanged', () => {
    expect(toPosix('posts/2026/hello.md')).toBe('posts/2026/hello.md')
    expect(toPosix(toPosix('posts/hello.md'))).toBe('posts/hello.md')
  })

  it('does not fold backslashes on POSIX, where they are legal filename characters', () => {
    // The Windows branch is `path.sep`-driven and therefore unreachable here;
    // this documents that callers must not treat toPosix as sanitisation.
    expect(toPosix('a\\b.md')).toBe('a\\b.md')
  })
})

describe('sanitizeFilename', () => {
  it('strips directory components from a path', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\me\\note.md')).toBe('note.md')
    expect(sanitizeFilename('posts/2026/hello.md')).toBe('hello.md')
  })

  it('removes control characters, including NUL', () => {
    expect(sanitizeFilename('a\u0000b.txt')).toBe('ab.txt')
    expect(sanitizeFilename('a\u001f\u007fb.md')).toBe('ab.md')
  })

  it('replaces anything that would need escaping downstream with a single hyphen', () => {
    expect(sanitizeFilename('my photo (final)!.png')).toBe('my-photo-final-.png')
    expect(sanitizeFilename('a   b.md')).toBe('a-b.md')
    expect(sanitizeFilename('r%C3%A9sum%C3%A9.pdf')).toBe('r-C3-A9sum-C3-A9.pdf')
  })

  it('folds non-ASCII letters away, because the stored name is echoed into URLs', () => {
    expect(sanitizeFilename('résumé.pdf')).toBe('r-sum-.pdf')
  })

  it('keeps CJK, which the storage layer and URLs both carry fine', () => {
    expect(sanitizeFilename('我的 笔记.md')).toBe('我的-笔记.md')
  })

  it('strips leading dots so an upload cannot create a hidden file', () => {
    expect(sanitizeFilename('.env')).toBe('env')
    expect(sanitizeFilename('.gitignore')).toBe('gitignore')
  })

  it('strips trailing dots and hyphens, which Windows drops silently', () => {
    expect(sanitizeFilename('name...')).toBe('name')
    expect(sanitizeFilename('name-')).toBe('name')
  })

  it('falls back to a generated name when nothing usable is left', () => {
    for (const input of ['', '...', '.', ' ', '///', '\u0000']) {
      expect(sanitizeFilename(input)).toMatch(/^file-[a-z0-9]+$/)
    }
  })

  it('renames reserved Windows device names, keeping the extension', () => {
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      expect(sanitizeFilename(name)).toBe(`${name}-file`)
      expect(sanitizeFilename(`${name}.md`)).toBe(`${name}-file.md`)
    }
  })

  it('renames index/_index stems that would shadow a generated listing', () => {
    expect(sanitizeFilename('index.md')).toBe('index-file.md')
    expect(sanitizeFilename('_index.md')).toBe('_index-file.md')
    // Only the exact stem is special.
    expect(sanitizeFilename('index2.md')).toBe('index2.md')
    expect(sanitizeFilename('my-index.md')).toBe('my-index.md')
  })

  it('bounds the length while keeping the extension', () => {
    const long = sanitizeFilename(`${'x'.repeat(400)}.md`)
    expect(long).toHaveLength(120)
    expect(long.endsWith('.md')).toBe(true)

    const longCjk = sanitizeFilename(`${'中'.repeat(300)}.md`)
    expect(longCjk).toHaveLength(120)
    expect(longCjk.endsWith('.md')).toBe(true)
  })
})

describe('assertSafeSlug', () => {
  it('returns an ordinary slug unchanged', () => {
    expect(assertSafeSlug('hello-world')).toBe('hello-world')
    expect(assertSafeSlug('2026-09-11-linux')).toBe('2026-09-11-linux')
    expect(assertSafeSlug('这是一个标题')).toBe('这是一个标题')
  })

  it('rejects a slug carrying a path separator', () => {
    expect(() => assertSafeSlug('a/b')).toThrow(/path separator/)
    expect(() => assertSafeSlug('a\\b')).toThrow(/path separator/)
  })

  it('rejects the directory references . and ..', () => {
    expect(() => assertSafeSlug('.')).toThrow(/directory reference/)
    expect(() => assertSafeSlug('..')).toThrow(/directory reference/)
  })

  it('rejects control characters and NUL', () => {
    expect(() => assertSafeSlug('a\u0000b')).toThrow(PathSecurityError)
    expect(() => assertSafeSlug('a\u001bb')).toThrow(/control characters/)
    expect(() => assertSafeSlug('a\u007fb')).toThrow(/control characters/)
  })

  it('rejects an empty slug and one beyond the length budget', () => {
    expect(() => assertSafeSlug('')).toThrow(/empty or too long/)
    expect(() => assertSafeSlug('a'.repeat(201))).toThrow(/empty or too long/)
    expect(assertSafeSlug('a'.repeat(200))).toHaveLength(200)
  })
})

describe('checkArchiveEntry', () => {
  it('accepts ordinary entries, including nested directories', () => {
    expect(checkArchiveEntry('posts/hello.md')).toEqual({ ok: true })
    expect(checkArchiveEntry('posts/2026/09/hello.md')).toEqual({ ok: true })
    // A dotted name that is not itself an archive.
    expect(checkArchiveEntry('notes.zip.txt')).toEqual({ ok: true })
  })

  it('rejects absolute paths', () => {
    expect(checkArchiveEntry('/etc/passwd')).toEqual({
      ok: false,
      reason: 'absolute path',
    })
    expect(checkArchiveEntry('//server/share/x.md').ok).toBe(false)
    // A Windows UNC path is absolute too once the separators are folded.
    expect(checkArchiveEntry('\\\\server\\share\\x.md').ok).toBe(false)
  })

  it('rejects drive-letter paths', () => {
    expect(checkArchiveEntry('C:\\Windows\\win.ini').reason).toBe('drive-letter path')
    expect(checkArchiveEntry('C:/Windows/win.ini').ok).toBe(false)
    expect(checkArchiveEntry('c:relative.md').ok).toBe(false)
  })

  it('rejects a .. component in any position', () => {
    expect(checkArchiveEntry('a/../b').reason).toBe('parent traversal')
    expect(checkArchiveEntry('../escape.md').ok).toBe(false)
    expect(checkArchiveEntry('a/..').ok).toBe(false)
    expect(checkArchiveEntry('..\\..\\escape.md').ok).toBe(false)
  })

  it('accepts a name whose first segment merely begins with two dots', () => {
    // The counterpart of the `isInside` case: the entry is a legal filename, so
    // the path it extracts to must be one the containment check accepts.
    const entry = '..notes/hello.md'
    expect(checkArchiveEntry(entry)).toEqual({ ok: true })
    expect(isInside(ROOT, safeJoin(ROOT, ...entry.split('/')))).toBe(true)
  })

  it('rejects control characters in the entry name', () => {
    expect(checkArchiveEntry('a\u0001b.md').reason).toBe('control characters')
    expect(checkArchiveEntry('a\u0000.md').ok).toBe(false)
  })

  it('rejects an empty or self-referential entry name', () => {
    expect(checkArchiveEntry('').reason).toBe('empty entry name')
    expect(checkArchiveEntry('.').reason).toBe('empty entry name')
    expect(checkArchiveEntry('./').reason).toBe('empty entry name')
  })

  it('rejects entry names beyond the length cap', () => {
    expect(checkArchiveEntry('a'.repeat(512)).ok).toBe(true)
    expect(checkArchiveEntry('a'.repeat(513)).reason).toBe('path too long')
  })

  it('rejects nested archives', () => {
    for (const name of ['a.zip', 'b.tar', 'c.tar.gz', 'd.tgz', 'e.7z', 'F.RAR', 'g.bz2']) {
      expect(checkArchiveEntry(name).reason).toBe('nested archive')
    }
    expect(checkArchiveEntry('docs/release.zip').ok).toBe(false)
  })
})

describe('checkArchiveBudget', () => {
  const budget = (over: Partial<Parameters<typeof checkArchiveBudget>[0]> = {}) => ({
    compressedSize: 1000,
    declaredUncompressed: 50_000,
    entryCount: 10,
    ...over,
  })

  it('accepts an archive that expands to a plausible size', () => {
    expect(checkArchiveBudget(budget())).toEqual({ ok: true })
  })

  it('rejects an archive whose declared size exceeds the total budget', () => {
    expect(checkArchiveBudget(budget({ declaredUncompressed: 600 * 1024 * 1024 }))).toEqual({
      ok: false,
      reason: 'archive expands beyond the size limit',
    })
  })

  it('rejects a zip bomb by compression ratio', () => {
    // 1 KB declaring 300 MB: the ratio, not the total, is what gives it away.
    expect(checkArchiveBudget(budget({ declaredUncompressed: 300_000 }))).toEqual({
      ok: false,
      reason: 'compression ratio looks like a zip bomb',
    })
  })

  it('rejects an archive with too many entries', () => {
    // A hundred thousand empty files are individually harmless and collectively
    // not: the byte budget never fires, so the count has to be its own check.
    expect(checkArchiveBudget(budget({ declaredUncompressed: 100, entryCount: 100_000 }))).toEqual({
      ok: false,
      reason: 'archive contains too many entries',
    })
  })

  it('allows a ratio exactly at the limit', () => {
    expect(checkArchiveBudget(budget({ declaredUncompressed: 200_000 }))).toEqual({ ok: true })
  })

  it('skips the ratio check when the compressed size is unknown', () => {
    // Dividing by zero would make every streamed entry look like a bomb.
    expect(checkArchiveBudget(budget({ compressedSize: 0, declaredUncompressed: 10_000_000 })))
      .toEqual({ ok: true })
  })

  it('honours caller-supplied limits', () => {
    const limits = { maxEntries: 10, maxTotalBytes: 4096, maxRatio: 2 }
    expect(checkArchiveBudget(budget({ declaredUncompressed: 1500 }), limits)).toEqual({ ok: true })
    // Under the custom total, over the custom ratio: the ratio is what fires.
    expect(checkArchiveBudget(budget({ declaredUncompressed: 4000 }), limits).reason).toBe(
      'compression ratio looks like a zip bomb',
    )
    expect(checkArchiveBudget(budget({ declaredUncompressed: 8192 }), limits).reason).toBe(
      'archive expands beyond the size limit',
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  MIME sniffing and SVG sanitisation                                         */
/* -------------------------------------------------------------------------- */

/** Magic bytes followed by padding, the way the head of a real file looks. */
function head(...prefix: (number | string)[]): Buffer {
  const parts = prefix.map((part) =>
    typeof part === 'number' ? Buffer.from([part]) : Buffer.from(part, 'latin1'),
  )
  return Buffer.concat([...parts, Buffer.alloc(32)])
}

describe('sniffMime', () => {
  it('recognises PNG from its magic bytes', () => {
    expect(sniffMime(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      mime: 'image/png',
      ext: '.png',
      allowed: true,
    })
  })

  it('recognises JPEG from its magic bytes', () => {
    expect(sniffMime(head(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      mime: 'image/jpeg',
      ext: '.jpg',
      allowed: true,
    })
  })

  it('recognises both GIF revisions and rejects the others', () => {
    expect(sniffMime(head('GIF87a')).mime).toBe('image/gif')
    expect(sniffMime(head('GIF89a')).mime).toBe('image/gif')
    expect(sniffMime(head('GIF88a')).allowed).toBe(false)
  })

  it('recognises WebP only when the RIFF container really says WEBP', () => {
    expect(sniffMime(head('RIFF', 0, 0, 0, 0, 'WEBP')).ext).toBe('.webp')
    // A RIFF/WAVE audio file must not be stored as an image.
    expect(sniffMime(head('RIFF', 0, 0, 0, 0, 'WAVE')).allowed).toBe(false)
  })

  it('recognises the other servable formats', () => {
    expect(sniffMime(head(0x42, 0x4d)).mime).toBe('image/bmp')
    expect(sniffMime(head(0x49, 0x49, 0x2a, 0x00)).mime).toBe('image/tiff')
    expect(sniffMime(head(0, 0, 0, 0x20, 'ftypavif')).mime).toBe('image/avif')
    expect(sniffMime(head(0, 0, 0, 0x20, 'ftypisom')).mime).toBe('video/mp4')
    expect(sniffMime(head(0x1a, 0x45, 0xdf, 0xa3)).mime).toBe('video/webm')
    expect(sniffMime(head('%PDF-1.7')).mime).toBe('application/pdf')
  })

  it('rejects a truncated file that only looks like the start of an image', () => {
    // A 7-byte PNG header is not a PNG; a 2-byte JPEG header is not a JPEG.
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])).allowed).toBe(
      false,
    )
    expect(sniffMime(Buffer.from([0xff, 0xd8])).allowed).toBe(false)
  })

  it('decides from the bytes, never from the name a file claims', () => {
    // There is no filename parameter to be fooled by: the extension that is
    // stored is the one returned here, derived from the content.
    expect(sniffMime(head('this file is a PNG, promise\n'))).toEqual({
      mime: 'application/octet-stream',
      ext: '.bin',
      allowed: false,
    })
    expect(sniffMime(head('<html><body>not an image</body></html>')).allowed).toBe(false)
    expect(sniffMime(head('const x = 1\n')).allowed).toBe(false)
  })

  it('rejects an empty buffer', () => {
    expect(sniffMime(Buffer.alloc(0))).toEqual({
      mime: 'application/octet-stream',
      ext: '.bin',
      allowed: false,
    })
  })

  it('recognises SVG through its prologue rather than a fixed signature', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    expect(sniffMime(Buffer.from(svg))).toEqual({
      mime: 'image/svg+xml',
      ext: '.svg',
      allowed: true,
    })
    expect(sniffMime(Buffer.from(`<?xml version="1.0"?>\n${svg}`)).mime).toBe('image/svg+xml')
    expect(sniffMime(Buffer.from(`<!-- exported by a tool -->\n${svg}`)).mime).toBe(
      'image/svg+xml',
    )
    expect(sniffMime(Buffer.from(`<!DOCTYPE svg PUBLIC "x">\n${svg}`)).mime).toBe(
      'image/svg+xml',
    )
    expect(sniffMime(Buffer.from('<svg/>')).mime).toBe('image/svg+xml')
  })

  it('does not mistake other markup for SVG', () => {
    expect(sniffMime(Buffer.from('<svgfoo bar="1"/>')).allowed).toBe(false)
    expect(sniffMime(Buffer.from('my <svg> collection is nice')).allowed).toBe(false)
  })

  it('only scans the head, so a binary cannot smuggle in an <svg> far from the start', () => {
    const smuggled = Buffer.concat([
      Buffer.from(' '.repeat(4200)),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ])
    expect(sniffMime(smuggled).allowed).toBe(false)
  })
})

describe('sanitizeSvg', () => {
  it('removes script elements in every casing and closing style', () => {
    for (const source of [
      '<svg><script>alert(1)</script><rect/></svg>',
      '<svg><SCRIPT>alert(1)</SCRIPT><rect/></svg>',
      '<svg><script src="https://evil.test/x.js"><rect/></svg>',
      '<svg><script src="//evil.test/x.js"/><rect/></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed).toContain('script')
      expect(svg.toLowerCase()).not.toContain('<script')
      expect(svg).toContain('<rect/>')
    }
  })

  it('removes on* event handler attributes, quoted or not', () => {
    for (const source of [
      '<svg onload="alert(1)"><rect/></svg>',
      '<svg onload=alert(1)><rect/></svg>',
      '<svg ONLOAD="alert(1)"><rect/></svg>',
      '<svg><rect onClick="alert(1)"/></svg>',
      '<svg\tonload="alert(1)"><rect/></svg>',
      '<svg\nonload="alert(1)"><rect/></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed).toContain('event handler attributes')
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i)
    }
  })

  it('removes an on* handler glued to the tag with a slash', () => {
    // `<svg/onload=…>` is an attribute to the HTML parser, which is how a
    // sanitised icon gets read once it is inlined into a page.
    const { svg, removed } = sanitizeSvg('<svg/onload=alert(1)><rect/></svg>')
    expect(removed).toContain('event handler attributes')
    expect(svg).toBe('<svg><rect/></svg>')
  })

  it('removes javascript: URLs from href and src', () => {
    for (const source of [
      '<svg><a href="javascript:alert(1)"><text>hi</text></a></svg>',
      '<svg><a xlink:href="javascript:alert(1)"><text>hi</text></a></svg>',
      '<svg><a xlink:href="JaVaScRiPt:alert(1)"><text>hi</text></a></svg>',
      '<svg><image src="javascript:alert(1)"/></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed).toContain('javascript: URL')
      expect(svg.toLowerCase()).not.toContain('javascript')
    }
  })

  it('removes a javascript: URL hidden behind character references', () => {
    // The XML parser decodes these back into a scheme before the browser sees
    // the attribute, so a literal match is not enough.
    for (const source of [
      '<svg><a xlink:href="&#106;avascript:alert(1)"><text>hi</text></a></svg>',
      '<svg><a href="&#x6a;avascript:alert(1)"><text>hi</text></a></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed).toContain('javascript: URL')
      expect(svg.toLowerCase()).not.toContain('avascript')
    }
  })

  it('removes data:text/html and vbscript URLs', () => {
    expect(
      sanitizeSvg('<svg><a href="data:text/html;base64,PHNjcmlwdD4="/></svg>').removed,
    ).toContain('javascript: URL')
    expect(sanitizeSvg('<svg><a href="vbscript:msgbox(1)"/></svg>').removed).toContain(
      'javascript: URL',
    )
  })

  it('keeps same-origin and fragment references, which are not executable', () => {
    const { svg, removed } = sanitizeSvg(
      '<svg><image href="sprite.svg#icon"/><a xlink:href="#top"><text>hi</text></a></svg>',
    )
    expect(removed).toEqual([])
    expect(svg).toContain('sprite.svg#icon')
    expect(svg).toContain('#top')
  })

  it('removes foreignObject together with the markup it can host', () => {
    const { svg, removed } = sanitizeSvg(
      '<svg><foreignObject><body><script>alert(1)</script></body></foreignObject><rect/></svg>',
    )
    expect(removed).toContain('foreignObject')
    expect(svg.toLowerCase()).not.toContain('foreignobject')
    expect(svg.toLowerCase()).not.toContain('<script')
    expect(svg).toContain('<rect/>')
  })

  it('removes the other elements that execute or fetch', () => {
    for (const [tag, source] of [
      ['use', '<svg><use href="#x"/><rect/></svg>'],
      ['animate', '<svg><animate attributeName="x" values="0;1"/><rect/></svg>'],
      ['iframe', '<svg><iframe src="https://evil.test/"></iframe><rect/></svg>'],
      ['object', '<svg><object data="https://evil.test/"></object><rect/></svg>'],
      ['style', '<svg><style>* { fill: red }</style><rect/></svg>'],
    ] as const) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed).toContain(tag)
      expect(svg.toLowerCase()).not.toContain(`<${tag}`)
    }
  })

  it('removes external references but keeps the element they were on', () => {
    // Every absolute form is a beacon, and protocol-relative is the one that
    // reads as a relative path and is not one.
    for (const source of [
      '<svg><image href="https://evil.test/track.png" width="1" height="1"/></svg>',
      '<svg><image xlink:href="http://evil.test/track.png"/></svg>',
      '<svg><image href="//evil.test/track.png"/></svg>',
      '<svg><a href="//evil.test/x.svg#i"><text>hi</text></a></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(source)
      expect(removed, source).toContain('external reference')
      expect(svg, source).not.toContain('evil.test')
    }
    expect(sanitizeSvg('<svg><image href="https://evil.test/t.png"/></svg>').svg).toContain(
      '<image',
    )
  })

  it('removes a nested SVG carried in a data URL', () => {
    // `data:image/svg+xml` is another SVG, which makes this sanitizer the only
    // thing standing between the reader and whatever is inside it.
    const { svg, removed } = sanitizeSvg(
      '<svg><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
    )
    expect(removed).toContain('external reference')
    expect(svg).not.toContain('data:image/svg+xml')
  })

  it('keeps an embedded raster, which cannot phone home', () => {
    const { svg } = sanitizeSvg('<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')
    expect(svg).toContain('data:image/png;base64')
  })

  it('does not mistake an ordinary path for a script URL', () => {
    // The word "javascript" in a filename is not a scheme, and deleting the
    // artwork is a bug in its own right.
    const { svg, removed } = sanitizeSvg(
      '<svg><image href="images/javascript-logo.png"/><image src="./a-vbscript.svg"/></svg>',
    )
    expect(removed).toEqual([])
    expect(svg).toContain('javascript-logo.png')
    expect(svg).toContain('a-vbscript.svg')
  })

  it('removes a script URL split by a newline, which browsers ignore', () => {
    const { svg, removed } = sanitizeSvg('<svg><a href="java\nscript:alert(1)">x</a></svg>')
    expect(removed).toContain('javascript: URL')
    expect(svg).not.toContain('script:alert')
  })

  it('strips the DOCTYPE and stylesheet instructions but keeps the XML declaration', () => {
    const { svg } = sanitizeSvg(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<?xml-stylesheet href="https://evil.test/x.css"?>\n' +
        '<!DOCTYPE svg SYSTEM "https://evil.test/evil.dtd">\n' +
        '<svg><rect/></svg>',
    )
    expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(svg).not.toContain('DOCTYPE')
    expect(svg).not.toContain('xml-stylesheet')
    expect(svg).not.toContain('evil.test')
  })

  it('reports what it removed, without duplicates', () => {
    const { removed } = sanitizeSvg(
      '<svg onload="a()"><script>x</script><script>y</script><rect/></svg>',
    )
    expect(removed.filter((item) => item === 'script')).toHaveLength(1)
    expect(removed).toContain('event handler attributes')
  })

  it('returns a legitimate icon unchanged and usable', () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"><title>Chevron</title>' +
      '<path d="M6 9l6 6 6-6"/><circle cx="12" cy="12" r="1.5"/></svg>'
    const { svg, removed } = sanitizeSvg(icon)
    expect(removed).toEqual([])
    expect(svg).toBe(icon)
    expect(svg).toContain('<path')
    expect(svg).toContain('<circle')
  })

  it('does not mangle prose that merely contains the word "on"', () => {
    const { svg } = sanitizeSvg('<svg><text>turn it on when ready</text></svg>')
    expect(svg).toBe('<svg><text>turn it on when ready</text></svg>')
  })
})

describe('safeTagColor', () => {
  it('accepts the four hex lengths, in either case', () => {
    for (const value of ['#fff', '#FFF', '#0f172a', '#0F172A', '#0f172a80', '#ABCDEF12']) {
      expect(safeTagColor(value)).toBe(value)
    }
  })

  it('refuses a colour that is not a hex colour', () => {
    for (const value of [
      'red',
      'rgb(1, 2, 3)',
      'hsl(0 0% 0%)',
      'fff',
      '#fffff',
      '#fffffff',
      '#1234567',
      '#gggggg',
      '',
      '#',
    ]) {
      expect(safeTagColor(value)).toBeNull()
    }
  })

  it('refuses a value that tries to break out of the CSS declaration', () => {
    // Tag colours are interpolated into a style attribute, so a trailing `;`
    // or `}` would let a stored value add its own declarations.
    for (const value of ['#fff;', '#fff;}', '#fff!important', 'expression(alert(1))', 'url(x)']) {
      expect(safeTagColor(value)).toBeNull()
    }
  })

  it('returns the value it tested, so padding cannot smuggle anything past the check', () => {
    // The trimmed string is both what the pattern sees and what the caller
    // interpolates, which is what makes trimming safe rather than a bypass: a
    // padded hex comes back as the hex, and a padded injection comes back as
    // nothing at all.
    expect(safeTagColor(' #fff')).toBe('#fff')
    expect(safeTagColor('#fff\n')).toBe('#fff')
    expect(safeTagColor('#fff;background:url(https://evil.test/x)')).toBeNull()
  })

  it('answers null for a tag with no colour', () => {
    expect(safeTagColor(null)).toBeNull()
    expect(safeTagColor(undefined)).toBeNull()
    expect(safeTagColor('')).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Slugs and text measurement                                                 */
/* -------------------------------------------------------------------------- */

describe('slugify', () => {
  it('lowercases and hyphenates Latin titles', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('drops punctuation and collapses the separators it leaves behind', () => {
    expect(slugify('Hello, World! (2026) — edition')).toBe('hello-world-2026-edition')
    expect(slugify('  --hello--world--  ')).toBe('hello-world')
  })

  it('keeps CJK, kana and Hangul, which need no transliteration to be readable', () => {
    expect(slugify('这是一个 中文 标题')).toBe('这是一个-中文-标题')
    expect(slugify('日本語のタイトル')).toBe('日本語のタイトル')
    expect(slugify('한국어 제목')).toBe('한국어-제목')
  })

  it('replaces accented letters rather than approaching them halfway', () => {
    // There is no transliteration table here, so `é` becomes a separator and the
    // trailing one is trimmed; what matters is that the result is a valid slug.
    expect(slugify('Café Déjà Vu')).toBe('caf-d-j-vu')
    expect(isValidSlug(slugify('Café Déjà Vu'))).toBe(true)
  })

  it('normalises full-width Latin input before stripping it', () => {
    expect(slugify('Ｈｅｌｌｏ　Ｗｏｒｌｄ')).toBe('hello-world')
  })

  it('falls back when nothing survives, including for whitespace-only input', () => {
    expect(slugify('')).toBe('untitled')
    expect(slugify('   ')).toBe('untitled')
    expect(slugify('!!!')).toBe('untitled')
    expect(slugify('🎉🎉')).toBe('untitled')
    expect(slugify('!!!', 'custom-fallback')).toBe('custom-fallback')
  })

  it('bounds the length in characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(120)
  })

  it('bounds the length in bytes too, because Chinese costs three bytes a character', () => {
    const slug = slugify('中'.repeat(200))
    expect(Buffer.byteLength(slug, 'utf8')).toBeLessThanOrEqual(180)
    expect(slug).toHaveLength(60)
  })

  it('always produces something isValidSlug accepts', () => {
    for (const input of ['Hello World', '中文标题', 'Café', 'a'.repeat(300), '中'.repeat(300), '!!!']) {
      expect(isValidSlug(slugify(input))).toBe(true)
    }
  })
})

describe('slugFromFilename', () => {
  it('drops a leading date prefix', () => {
    expect(slugFromFilename('2026-09-11-linux-networking.md')).toBe('linux-networking')
    expect(slugFromFilename('2026_09_11_My Post.markdown')).toBe('my-post')
  })

  it('keeps the date when the name is nothing but a date', () => {
    expect(slugFromFilename('2026-09-11.md')).toBe('2026-09-11')
  })

  it('strips the Markdown extension whatever its case', () => {
    expect(slugFromFilename('Hello World.md')).toBe('hello-world')
    expect(slugFromFilename('Note.MDX')).toBe('note')
  })
})

describe('isValidSlug', () => {
  it('rejects a value that is empty, too long, or padded with separators', () => {
    expect(isValidSlug('')).toBe(false)
    expect(isValidSlug('-a')).toBe(false)
    expect(isValidSlug('a-')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('a'.repeat(121))).toBe(false)
  })

  it('rejects uppercase and path separators', () => {
    expect(isValidSlug('A')).toBe(false)
    expect(isValidSlug('a/b')).toBe(false)
    expect(isValidSlug('..')).toBe(false)
  })

  it('accepts CJK within the byte budget', () => {
    expect(isValidSlug('中文标题')).toBe(true)
    expect(isValidSlug('中'.repeat(61))).toBe(false)
  })
})

describe('tagSlug', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(tagSlug('Linux')).toBe('linux')
    expect(tagSlug('  Web   Dev ')).toBe('web-dev')
    expect(tagSlug('C++')).toBe('c')
  })

  it('keeps CJK tags addressable', () => {
    expect(tagSlug('中文标签')).toBe('中文标签')
  })

  it('keeps the same scripts as every other slug, kana included', () => {
    // `tagSlug` used to keep only ideographs, so a Japanese tag became `tag`
    // while the same word survived in an article slug. One definition of CJK,
    // in `CJK_RANGES`, is what stops that drifting apart again.
    expect(tagSlug('カタカナ')).toBe('カタカナ')
    expect(tagSlug('한국어')).toBe('한국어')
    // Extension A ideographs are CJK too, and were being dropped.
    expect(tagSlug('㐀字')).toBe('㐀字')
    // And the identical set is accepted by the slug validator.
    expect(isValidSlug(slugify('カタカナ')).valueOf()).toBe(true)
  })

  it('falls back for a name with nothing usable in it', () => {
    expect(tagSlug('---')).toBe('tag')
    expect(tagSlug('')).toBe('tag')
    expect(tagSlug('///')).toBe('tag')
  })
})

describe('uniqueSlug', () => {
  it('returns the base when it is free', () => {
    expect(uniqueSlug('post', new Set(['other']))).toBe('post')
    expect(uniqueSlug('post', new Set())).toBe('post')
  })

  it('appends the first free suffix', () => {
    expect(uniqueSlug('post', new Set(['post']))).toBe('post-2')
    expect(uniqueSlug('post', new Set(['post', 'post-2']))).toBe('post-3')
  })

  it('terminates and still returns an unused slug when the suffixes run out', () => {
    const taken = new Set<string>(['post'])
    for (let n = 2; n <= 999; n += 1) taken.add(`post-${n}`)
    const result = uniqueSlug('post', taken)
    expect(taken.has(result)).toBe(false)
    expect(result.startsWith('post-')).toBe(true)
  })
})

describe('textStats', () => {
  const words = (count: number): string => Array.from({ length: count }, () => 'word').join(' ')

  it('counts Latin words per whitespace-delimited token', () => {
    expect(textStats(words(12))).toEqual({
      words: 12,
      cjkChars: 0,
      latinWords: 12,
      readingTime: 1,
    })
  })

  it('reads Latin prose at roughly 220 words per minute', () => {
    expect(textStats(words(220)).readingTime).toBe(1)
    expect(textStats(words(440)).readingTime).toBe(2)
    expect(textStats(words(660)).readingTime).toBe(3)
  })

  it('counts CJK per character rather than per token', () => {
    expect(textStats('中'.repeat(120))).toEqual({
      words: 120,
      cjkChars: 120,
      latinWords: 0,
      readingTime: 1,
    })
  })

  it('reads CJK at roughly 400 characters per minute', () => {
    expect(textStats('中'.repeat(400)).readingTime).toBe(1)
    expect(textStats('中'.repeat(800)).readingTime).toBe(2)
    expect(textStats('中'.repeat(1200)).readingTime).toBe(3)
  })

  it('adds the two rates for a document that mixes scripts', () => {
    // The common case here: Chinese prose quoting English terms.
    expect(textStats(`${words(220)} ${'中'.repeat(800)}`).readingTime).toBe(3)
    expect(textStats(`${words(110)} ${'中'.repeat(200)}`).readingTime).toBe(1)
  })

  it('does not double count Latin runs inside a CJK paragraph', () => {
    const stats = textStats('中文English中文')
    expect(stats.cjkChars).toBe(4)
    expect(stats.latinWords).toBe(1)
    expect(stats.words).toBe(5)
  })

  it('treats kana and Hangul as CJK units', () => {
    expect(textStats('あいうえお').cjkChars).toBe(5)
    expect(textStats('한국어').cjkChars).toBe(3)
  })

  it('counts a hyphenated or apostrophised word once', () => {
    expect(textStats('state-of-the-art design').latinWords).toBe(2)
    expect(textStats("don't stop believing").latinWords).toBe(3)
  })

  it('does not count CJK punctuation as text', () => {
    expect(textStats('你好，世界。').cjkChars).toBe(4)
  })

  it('reports no words and a minimum of one minute for an empty document', () => {
    expect(textStats('')).toEqual({ words: 0, cjkChars: 0, latinWords: 0, readingTime: 1 })
    expect(textStats('   \n\n  ').readingTime).toBe(1)
  })
})

describe('stripMarkdown (what the stats are measured from)', () => {
  it('drops fenced code so source code is not counted as prose', () => {
    const stripped = stripMarkdown('Some prose.\n\n```ts\nconst alpha = 1\n```\n\nMore prose.')
    expect(stripped).toContain('Some prose.')
    expect(stripped).not.toContain('const alpha')
  })

  it('keeps link labels and image alt text but drops their targets', () => {
    expect(stripMarkdown('See [the docs](https://example.test/a) now.')).toBe(
      'See the docs now.',
    )
    expect(stripMarkdown('![a cat](/cat.png)')).toBe('a cat')
  })

  it('leaves the word count of a marked-up paragraph intact', () => {
    // Inline code is prose here, so its content is counted and only the
    // backticks go.
    const stats = textStats(stripMarkdown('# 标题\n\nHello **world** with `code`.'))
    expect(stats.cjkChars).toBe(2)
    expect(stats.latinWords).toBe(4)
  })
})
