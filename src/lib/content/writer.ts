import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type ContentDocument,
  checksumOf,
  invalidateContentCache,
  readDocument,
} from './reader'
import { serializeFrontmatter } from './frontmatter'
import {
  CONTENT_ROOT,
  LOCK_DIR,
  TMP_DIR,
  buildRelativePath,
  documentPath,
  lockPath,
  requiredContentDirs,
  tempPath,
  typeDirectory,
} from './paths'
import { assertSafeSlug, toPosix } from '@/lib/security/paths'
import type { ContentType } from './schema'

/**
 * Writing documents safely.
 *
 * The contract, restated because it is the whole point of this module:
 *
 *   1. The original file is never opened for writing. A new file is written
 *      under `.tmp/`, fsynced, then `rename()`d over the target.
 *   2. `rename()` within one filesystem is atomic, so a concurrent reader sees
 *      either the complete old file or the complete new one.
 *   3. Before the rename, the previous contents are handed to the caller so a
 *      revision can be recorded. If that step fails, the write does not happen.
 *   4. If anything throws, the target is byte-for-byte what it was.
 *
 * The only way to break rule 4 is to lose power between `rename` and the
 * directory fsync, which is why the directory is fsynced.
 */

export class ContentWriteError extends Error {
  readonly code = 'CONTENT_WRITE'
  override readonly cause?: unknown
  readonly relativePath: string

  constructor(message: string, relativePath: string, cause?: unknown) {
    super(message)
    this.name = 'ContentWriteError'
    this.relativePath = relativePath
    this.cause = cause
  }
}

export class ContentLockError extends Error {
  readonly code = 'CONTENT_LOCK'
  constructor(
    message: string,
    readonly relativePath: string,
  ) {
    super(message)
    this.name = 'ContentLockError'
  }
}

export interface WriteResult {
  relativePath: string
  absolutePath: string
  checksum: string
  byteSize: number
  /** Contents of the previous version, or null when the file is new. */
  previousContent: string | null
  created: boolean
}

/* -------------------------------------------------------------------------- */
/*  Setup                                                                      */
/* -------------------------------------------------------------------------- */

let directoriesReady: Promise<void> | null = null

/** Create the working directories once per process. */
export function ensureContentDirectories(): Promise<void> {
  directoriesReady ??= (async () => {
    for (const dir of requiredContentDirs()) {
      await fs.mkdir(dir, { recursive: true })
    }
    await sweepOrphanTempFiles()
  })()
  return directoriesReady
}

/**
 * Remove leftovers in `.tmp/`.
 *
 * A temp file is orphaned only when a process died between writing it and
 * renaming it. Anything older than an hour is certainly orphaned; anything
 * younger might belong to a concurrent write, so it is left alone.
 */
export async function sweepOrphanTempFiles(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  const entries = await fs.readdir(TMP_DIR).catch(() => [] as string[])
  const now = Date.now()
  let removed = 0

  for (const name of entries) {
    const full = path.join(TMP_DIR, name)
    try {
      const stat = await fs.stat(full)
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(full)
        removed += 1
      }
    } catch {
      // Raced with another sweeper, or already gone. Nothing to do.
    }
  }
  return removed
}

/* -------------------------------------------------------------------------- */
/*  Locking                                                                    */
/* -------------------------------------------------------------------------- */

interface LockHandle {
  release: () => Promise<void>
}

const DEFAULT_LOCK_TIMEOUT_MS = 5000
/** A lock older than this is assumed to belong to a dead process. */
const LOCK_STALE_MS = 10_000
const LOCK_POLL_MS = 40

/**
 * Advisory lock via `O_EXCL` creation.
 *
 * Two admin saves or an admin save racing `content:sync` would otherwise
 * interleave a read and a write and lose an edit. Postgres advisory locks would
 * work for the app but not for the CLI, so a lock file is the common ground.
 */
async function acquireLock(relativePath: string): Promise<LockHandle> {
  const file = lockPath(relativePath)
  const deadline = Date.now() + DEFAULT_LOCK_TIMEOUT_MS

  for (;;) {
    try {
      const handle = await fs.open(file, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      )
      await handle.close()

      return {
        release: async () => {
          await fs.unlink(file).catch(() => undefined)
        },
      }
    } catch (error) {
      if (!isAlreadyExists(error)) {
        // The lock directory may not exist yet on a cold start.
        if (isNotFound(error)) {
          await fs.mkdir(LOCK_DIR, { recursive: true })
          continue
        }
        throw new ContentLockError(
          `Cannot create lock for ${relativePath}`,
          relativePath,
        )
      }

      if (await isStaleLock(file)) {
        await fs.unlink(file).catch(() => undefined)
        continue
      }

      if (Date.now() > deadline) {
        throw new ContentLockError(
          `Timed out waiting for the write lock on ${relativePath}. Another save or a content sync may be in progress.`,
          relativePath,
        )
      }

      await sleep(LOCK_POLL_MS)
    }
  }
}

async function isStaleLock(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false

    // The holder may still be alive but slow. Check the pid before stealing.
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    const parsed = JSON.parse(raw) as { pid?: number }
    if (typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
      if (isProcessAlive(parsed.pid)) return false
    }
    return true
  } catch {
    return true
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/* -------------------------------------------------------------------------- */
/*  Atomic write                                                               */
/* -------------------------------------------------------------------------- */

async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  const tmp = tempPath(toPosix(path.relative(CONTENT_ROOT, absolutePath)))

  // Both directories this write depends on are created here rather than assumed.
  // `ensureContentDirectories` remembers its work for the life of the process,
  // which is right for a boot step and wrong for a dependency: if the content
  // root is cleared under a running server — an operator emptying it, a deploy
  // mounting an empty volume, a test harness rebuilding it between runs — a
  // memoised "ready" would leave every later save failing on a temp file whose
  // directory no longer exists. `mkdir` on an existing directory costs one
  // syscall and says what this function actually requires.
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.mkdir(TMP_DIR, { recursive: true })

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tmp, 'wx', 0o644)
    await handle.writeFile(content, 'utf8')
    // Flush file contents to the platter before the rename is visible.
    await handle.sync()
    await handle.close()
    handle = undefined

    await fs.rename(tmp, absolutePath)
    await fsyncDirectory(path.dirname(absolutePath))
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.unlink(tmp).catch(() => undefined)
    throw error
  }
}

/**
 * Flush a directory entry so the rename survives a power loss.
 * Not supported on every platform; a failure here is not fatal.
 */
async function fsyncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch {
    // Windows and some network filesystems reject this. The rename is still
    // atomic; only crash durability is weaker.
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface WriteDocumentInput {
  relativePath: string
  data: Record<string, unknown>
  body: string
  extra?: Record<string, unknown>
  comment?: string
}

/**
 * Write a document, returning the previous contents so the caller can record a
 * revision. Callers should snapshot *before* relying on the new file being live.
 */
export async function writeDocument(
  input: WriteDocumentInput,
): Promise<WriteResult> {
  await ensureContentDirectories()

  const relativePath = toPosix(input.relativePath)
  const absolutePath = documentPath(relativePath)

  const lock = await acquireLock(relativePath)
  try {
    const previous = await fs.readFile(absolutePath, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw new ContentWriteError(
        `Cannot read the current version of ${relativePath}`,
        relativePath,
        error,
      )
    })

    const content = serializeFrontmatter(input.data, input.body, {
      ...(input.extra ? { extra: input.extra } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
    })

    await atomicWrite(absolutePath, content)
    invalidateContentCache(relativePath)

    return {
      relativePath,
      absolutePath,
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: previous,
      created: previous === null,
    }
  } catch (error) {
    if (error instanceof ContentWriteError) throw error
    throw new ContentWriteError(
      `Failed to write ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      relativePath,
      error,
    )
  } finally {
    await lock.release()
  }
}

export interface CreateDocumentInput {
  type: ContentType
  slug: string
  data: Record<string, unknown>
  body: string
  extra?: Record<string, unknown>
}

/**
 * Create a new document. Refuses to overwrite: a create that silently clobbers
 * an existing article is exactly the failure this module exists to prevent.
 */
export async function createDocument(
  input: CreateDocumentInput,
): Promise<WriteResult> {
  const slug = assertSafeSlug(input.slug)
  const relativePath = buildRelativePath(input.type, slug)
  const absolutePath = documentPath(relativePath)

  await ensureContentDirectories()

  const lock = await acquireLock(relativePath)
  try {
    const exists = await fs
      .stat(absolutePath)
      .then(() => true)
      .catch(() => false)

    if (exists) {
      throw new ContentWriteError(
        `A document already exists at ${relativePath}`,
        relativePath,
      )
    }

    const content = serializeFrontmatter(input.data, input.body, {
      ...(input.extra ? { extra: input.extra } : {}),
    })
    await atomicWrite(absolutePath, content)
    invalidateContentCache(relativePath)

    return {
      relativePath,
      absolutePath,
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: null,
      created: true,
    }
  } finally {
    await lock.release()
  }
}

/**
 * Rename a document's file, e.g. when its slug changes.
 * Returns null when the source does not exist.
 */
export async function renameDocument(
  fromRelativePath: string,
  toRelativePath: string,
): Promise<{ from: string; to: string; previousContent: string } | null> {
  const from = toPosix(fromRelativePath)
  const to = toPosix(toRelativePath)
  if (from === to) return null

  const fromAbsolute = documentPath(from)
  const toAbsolute = documentPath(to)

  await ensureContentDirectories()

  // Lock both endpoints in a stable order so two concurrent renames that cross
  // cannot deadlock.
  const [first, second] = [from, to].sort()
  const lockA = await acquireLock(first as string)
  const lockB = second === first ? null : await acquireLock(second as string)

  try {
    const previousContent = await fs.readFile(fromAbsolute, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw error
    })
    if (previousContent === null) return null

    if (await fs.stat(toAbsolute).then(() => true).catch(() => false)) {
      throw new ContentWriteError(
        `Cannot rename to ${to}: a file already exists there`,
        to,
      )
    }

    await fs.rename(fromAbsolute, toAbsolute)
    await fsyncDirectory(path.dirname(toAbsolute))

    invalidateContentCache(from)
    invalidateContentCache(to)

    return { from, to, previousContent }
  } finally {
    await lockB?.release()
    await lockA.release()
  }
}

/**
 * Delete a document's file.
 *
 * Returns the removed contents so the caller can store a final revision — a
 * delete from the admin UI must still be recoverable.
 */
export async function deleteDocument(
  relativePath: string,
): Promise<{ relativePath: string; content: string } | null> {
  const relative = toPosix(relativePath)
  const absolutePath = documentPath(relative)

  const lock = await acquireLock(relative)
  try {
    const content = await fs.readFile(absolutePath, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw error
    })
    if (content === null) return null

    await fs.unlink(absolutePath)
    await fsyncDirectory(path.dirname(absolutePath))
    invalidateContentCache(relative)

    return { relativePath: relative, content }
  } finally {
    await lock.release()
  }
}

/**
 * Read-modify-write helper that cannot lose a concurrent edit.
 * The mutate callback receives the freshly read document and returns the new
 * frontmatter and body; both the read and the write happen under one lock.
 */
export async function updateDocument(
  relativePath: string,
  mutate: (
    current: ContentDocument,
  ) => { data: Record<string, unknown>; body: string; comment?: string },
): Promise<WriteResult> {
  await ensureContentDirectories()

  const relative = toPosix(relativePath)
  const lock = await acquireLock(relative)
  try {
    const current = await readDocument(relative)
    if (!current) {
      throw new ContentWriteError(`No document at ${relative}`, relative)
    }

    const { data, body, comment } = mutate(current)
    const content = serializeFrontmatter(data, body, {
      extra: current.extra,
      ...(comment ? { comment } : {}),
    })

    await atomicWrite(documentPath(relative), content)
    invalidateContentCache(relative)

    return {
      relativePath: relative,
      absolutePath: documentPath(relative),
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: current.raw,
      created: false,
    }
  } finally {
    await lock.release()
  }
}

/**
 * Write raw file contents, bypassing frontmatter serialisation.
 * Used by the revision restore path, which must reproduce a file exactly.
 */
export async function writeRawDocument(
  relativePath: string,
  content: string,
): Promise<WriteResult> {
  await ensureContentDirectories()

  const relative = toPosix(relativePath)
  const absolutePath = documentPath(relative)

  const lock = await acquireLock(relative)
  try {
    const previous = await fs.readFile(absolutePath, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw error
    })

    await atomicWrite(absolutePath, content)
    invalidateContentCache(relative)

    return {
      relativePath: relative,
      absolutePath,
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: previous,
      created: previous === null,
    }
  } finally {
    await lock.release()
  }
}

/* -------------------------------------------------------------------------- */
/*  Importer support                                                           */
/* -------------------------------------------------------------------------- */

export interface ImportWriteInput {
  type: ContentType
  slug: string
  content: string
  /** When true, an existing file with the same slug is replaced. */
  overwrite: boolean
}

/**
 * Write a file for the import pipeline, which already has complete Markdown
 * text and must not round-trip it through the parser.
 *
 * The original `.md` bytes are preserved exactly, including frontmatter
 * comments, because the importer must not modify what it was given without
 * explicit confirmation.
 */
export async function importDocument(
  input: ImportWriteInput,
): Promise<{ relativePath: string; skipped: boolean }> {
  const slug = assertSafeSlug(input.slug)
  const relativePath = buildRelativePath(input.type, slug)
  const absolutePath = documentPath(relativePath)

  await ensureContentDirectories()

  const lock = await acquireLock(relativePath)
  try {
    const exists = await fs
      .stat(absolutePath)
      .then(() => true)
      .catch(() => false)

    if (exists && !input.overwrite) {
      return { relativePath, skipped: true }
    }

    await atomicWrite(absolutePath, input.content)
    invalidateContentCache(relativePath)
    return { relativePath, skipped: false }
  } finally {
    await lock.release()
  }
}

/** Directory a document lives in, relative to CONTENT_ROOT. */
export function documentDirectory(relativePath: string): string {
  return toPosix(path.dirname(relativePath))
}

export { typeDirectory }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST'
}
