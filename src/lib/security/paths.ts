import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * Filesystem path containment.
 *
 * Every path that originates from a request, a ZIP entry, or user input passes
 * through here before it reaches `fs`. The containment check uses
 * `path.relative`, never `String.startsWith`: `startsWith('/var/content')`
 * happily accepts `/var/content-secrets`, and that class of bug is exactly what
 * turns an upload form into arbitrary file write.
 */

export class PathSecurityError extends Error {
  readonly code = 'PATH_SECURITY'
  constructor(message: string) {
    super(message)
    this.name = 'PathSecurityError'
  }
}

/**
 * Join path segments under a directory that only exists at run time.
 *
 * ## Why this is a function and not a `path.join` at each call site
 *
 * The content tree and the upload tree are named by environment variables, so
 * neither `path.resolve(process.cwd(), env.CONTENT_DIR)` nor anything joined
 * onto the result can be resolved by the bundler's file tracer. Faced with a
 * path it cannot resolve, the tracer does the safe thing and assumes the whole
 * project is reachable — which put `src/`, `tests/`, the Dockerfile and the
 * author's `content/` into `.next/standalone`, and therefore into the runtime
 * image: a 79 MB image that ships the test suite and a copy of the blog it
 * serves.
 *
 * `turbopackIgnore` tells the tracer to stop here. It has no effect on the path
 * that is actually built, and no effect on containment — `assertInside` remains
 * the thing that decides whether a path may be used.
 *
 * It lives in a function so the suppression is stated once. The first attempt
 * put the comment on the two root definitions, which fixed those two warnings
 * and left every join *onto* those roots still opaque and still traced.
 *
 * ## Why `resolve` and not `join`
 *
 * These roots are *configurable*, and an absolute `CONTENT_DIR` is the normal
 * case in tests and a supported one in production. `path.join('/srv/app',
 * '/tmp/content')` is `/srv/app/tmp/content`; `path.resolve` gives
 * `/tmp/content`. `join` would silently reinterpret every absolute root as
 * relative to the working directory — and the symptom is not a crash but a
 * second tree, quietly created next to the code, with the test suite's
 * containment guards firing against it instead of against the real one.
 *
 * The calls that join a *relative* segment onto an already-absolute root agree
 * under both functions, which is why one implementation covers every call site.
 */
export function joinRuntimePath(root: string, ...segments: string[]): string {
  return path.resolve(/* turbopackIgnore: true */ root, ...segments)
}

/**
 * True when `target` resolves to `root` itself or something beneath it.
 * Both paths are resolved first, so `..`, symlink-free relative segments and
 * mixed separators are all normalised away before the comparison.
 */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)

  if (resolvedRoot === resolvedTarget) return true

  const rel = path.relative(resolvedRoot, resolvedTarget)
  // Empty means same path (already handled). The result escapes the root when it
  // is `..`, starts with a `..` *segment*, or is absolute. Checking for the
  // segment rather than the two-character prefix matters: `<root>/..foo` is a
  // legal filename inside the root, and `startsWith('..')` would reject it.
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  )
}

/** Throw unless `target` is `root` or beneath it. */
export function assertInside(
  root: string,
  target: string,
  label = 'path',
): string {
  const resolved = path.resolve(target)
  if (!isInside(root, resolved)) {
    throw new PathSecurityError(
      `Refusing to touch ${label} outside its root: ${resolved} is not inside ${path.resolve(root)}`,
    )
  }
  return resolved
}

/**
 * Reject symlinks below a configured storage root, including the target itself.
 * Lexical containment alone cannot stop `root/link/file` following a link to
 * another tree. The root is deployment configuration and may itself be a link;
 * every component supplied by content, database rows or requests must be plain.
 * Missing components are allowed so the same check protects new writes.
 * Call immediately before filesystem operations and again after mkdir.
 * Storage directories must be writable only by the application's trusted user;
 * Node has no portable openat primitive to defeat a hostile local rename race.
 */
export async function assertNoSymlinkPath(
  root: string,
  target: string,
  label = 'path',
): Promise<string> {
  const resolvedRoot = path.resolve(root)
  const resolved = assertInside(resolvedRoot, target, label)
  const relative = path.relative(resolvedRoot, resolved)
  let current = resolvedRoot
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new PathSecurityError(`Refusing ${label} through a symbolic link: ${current}`)
    }
  }
  return resolved
}

/**
 * Join `segments` onto `root` and prove the result stays inside.
 * Absolute segments and `..` are rejected rather than silently normalised, so a
 * caller passing `/etc/passwd` gets an error instead of a surprise.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!segment) continue
    if (path.isAbsolute(segment)) {
      throw new PathSecurityError(`Absolute path segment is not allowed: ${segment}`)
    }
    if (segment.split(/[/\\]/).includes('..')) {
      throw new PathSecurityError(`Parent traversal is not allowed: ${segment}`)
    }
  }
  return assertInside(root, path.join(root, ...segments))
}

/** Convert an OS path to the POSIX form we store in the database. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Resolve a path relative to `root` from a database-style POSIX string.
 *
 * A leading `/` is *rebased* rather than rejected — stored paths are written
 * both ways and `/uploads/a.png` plainly means the upload inside the upload
 * root, not the filesystem root. What is rejected is any `..` segment, which
 * `safeJoin` refuses, because that is the only way this can escape `root`.
 */
export function resolveRelative(root: string, relative: string): string {
  const normalised = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalised) {
    throw new PathSecurityError('Empty relative path')
  }
  const segments = normalised.split('/').filter((s) => s && s !== '.')
  return safeJoin(root, ...segments)
}

/* -------------------------------------------------------------------------- */
/*  Filenames                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Characters that are safe in a stored filename.
 * Deliberately conservative: the stored name is echoed back into URLs and
 * content files, so it must not need escaping anywhere downstream.
 */
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._一-鿿-]+/g
const MAX_FILENAME_LENGTH = 120

/**
 * Produce a safe, still-recognisable filename.
 *
 * Strips directory components, control characters, leading dots (which would
 * create hidden files) and reserved Windows device names, then bounds the
 * length while preserving the extension.
 */
export function sanitizeFilename(input: string): string {
  const basename = input.split(/[/\\]/).pop() ?? ''

  const cleaned = basename
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(UNSAFE_FILENAME_CHARS, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')

  if (!cleaned) return `file-${Date.now().toString(36)}`

  const ext = path.extname(cleaned).toLowerCase()
  const stem = cleaned.slice(0, cleaned.length - ext.length) || 'file'

  const isReserved =
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ||
    /^(index|_index)$/i.test(stem)
  const safeStem = isReserved ? `${stem}-file` : stem

  const budget = Math.max(1, MAX_FILENAME_LENGTH - ext.length)
  return `${safeStem.slice(0, budget)}${ext}`
}

/**
 * Validate a slug used as part of a filename or URL segment.
 * Rejects anything that is not a single, ordinary path component.
 */
export function assertSafeSlug(slug: string): string {
  if (!slug || slug.length > 200) {
    throw new PathSecurityError('Slug is empty or too long')
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('\0')) {
    throw new PathSecurityError(`Slug contains a path separator: ${slug}`)
  }
  if (slug === '.' || slug === '..') {
    throw new PathSecurityError('Slug cannot be a directory reference')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(slug)) {
    throw new PathSecurityError('Slug contains control characters')
  }
  return slug
}

/* -------------------------------------------------------------------------- */
/*  Archives                                                                   */
/* -------------------------------------------------------------------------- */

export interface ArchiveEntryCheck {
  ok: boolean
  reason?: string
}

/**
 * Screen a ZIP entry name before extraction.
 *
 * ZIP entries can carry absolute paths, `..` traversal and Windows drive
 * letters, and any of them turns "import a zip of markdown" into an arbitrary
 * filesystem write. All are rejected up front, before the entry is read.
 *
 * The name only. A directory entry's Unix mode also carries a symlink bit, and
 * whether to trust that bit is the extractor's decision, not this function's —
 * so the caller must additionally refuse to follow a link out of the staging
 * directory rather than assuming a name check is enough.
 */
export function checkArchiveEntry(entryName: string): ArchiveEntryCheck {
  if (!entryName || entryName === '.' || entryName === './') {
    return { ok: false, reason: 'empty entry name' }
  }

  const name = entryName.replace(/\\/g, '/')

  if (name.startsWith('/')) {
    return { ok: false, reason: 'absolute path' }
  }
  if (/^[a-zA-Z]:/.test(name)) {
    return { ok: false, reason: 'drive-letter path' }
  }
  if (name.split('/').includes('..')) {
    return { ok: false, reason: 'parent traversal' }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, reason: 'control characters' }
  }
  if (name.length > 512) {
    return { ok: false, reason: 'path too long' }
  }
  // Nested archives are not unpacked, so accepting them only wastes budget.
  if (/\.(zip|tar|gz|tgz|bz2|xz|rar|7z)$/i.test(name)) {
    return { ok: false, reason: 'nested archive' }
  }

  return { ok: true }
}

export interface ArchiveLimits {
  /** Entry count ceiling, counted from the central directory. */
  maxEntries: number
  /** Total decompressed bytes ceiling. */
  maxTotalBytes: number
  /** Decompressed-to-compressed ratio ceiling. */
  maxRatio: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 2000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 200,
}

export interface ArchiveBudget {
  /** Compressed size as uploaded. `0` when the source is a stream of unknown size. */
  compressedSize: number
  /** Sum of the uncompressed sizes the central directory declares. */
  declaredUncompressed: number
  /** Entry count the central directory declares. */
  entryCount: number
}

/**
 * Cap an archive's declared size before anything is extracted.
 *
 * A 10 KB file can expand to gigabytes, and the ratio check is what catches
 * that. The declared sizes come from the archive's own central directory and so
 * are attacker-controlled — this is a cheap first gate. The extractor must
 * still count bytes as they are written and stop when the running total passes
 * the same ceiling, because a header can simply lie.
 */
export function checkArchiveBudget(
  budget: ArchiveBudget,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveEntryCheck {
  if (budget.entryCount > limits.maxEntries) {
    return { ok: false, reason: 'archive contains too many entries' }
  }
  if (budget.declaredUncompressed > limits.maxTotalBytes) {
    return { ok: false, reason: 'archive expands beyond the size limit' }
  }
  if (
    budget.compressedSize > 0 &&
    budget.declaredUncompressed / budget.compressedSize > limits.maxRatio
  ) {
    return { ok: false, reason: 'compression ratio looks like a zip bomb' }
  }
  return { ok: true }
}
