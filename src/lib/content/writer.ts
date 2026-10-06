import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  type ContentDocument,
  checksumOf,
  invalidateContentCache,
  parseDocument,
  readDocument,
  scanContentFiles,
} from './reader'
import { serializeFrontmatter } from './frontmatter'
import {
  CONTENT_ROOT,
  LOCK_DIR,
  TMP_DIR,
  buildRelativePath,
  documentPath,
  lockPath,
  parseRelativePath,
  requiredContentDirs,
  tempPath,
  typeDirectory,
} from './paths'
import { assertNoSymlinkPath, assertSafeSlug, toPosix } from '@/lib/security/paths'
import type { ContentType } from './schema'
import { env } from '@/env'
import { preservePreviousContent } from './recovery'

/**
 * Writing documents safely.
 *
 * The contract, restated because it is the whole point of this module:
 *
 *   1. The original file is never opened for writing. A new file is written
 *      under `.tmp/`, fsynced, then `rename()`d over the target.
 *   2. `rename()` within one filesystem is atomic, so a concurrent reader sees
 *      either the complete old file or the complete new one.
 *   3. The previous contents are read under the lock and returned after the
 *      rename so the caller can record a revision and report capture failures.
 *   4. A failed atomic write leaves the target byte-for-byte what it was.
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
  /** Private old bytes retained until revision capture is confirmed. */
  recoveryPath?: string
}

export interface PreservePreviousOptions {
  preservePrevious?: boolean
}

/**
 * Translate a failure in this module's own write steps into a write error.
 *
 * The guard on the admin's side answers a `ContentWriteError` with "Writing X
 * failed. The original file was not modified." — the sentence an operator needs
 * before deciding whether to retype their work. A bare `ENOSPC` from the rename
 * reaches them as "the server hit an unexpected error" instead: true, and no use
 * at all, because a full disk and a bug look the same from the browser.
 *
 * The message names the document and stops there: the guard repeats it as the
 * failure's second line, in the browser. The cause is kept on the error and
 * written to the server log here instead, because a filesystem failure's own
 * message carries both absolute paths involved — and the one reader who can act
 * on `ENOSPC` is at the terminal, not at the form.
 *
 * Only the steps where the target is certainly untouched are covered, and only
 * the doors that report through `describeActionError`: `createDocument`,
 * `updateDocument` and `writeRawDocument` — the last of which is how a revision
 * restore writes. A callback that throws is the caller's own control flow — the
 * editor refuses a save by throwing from inside `updateDocument`'s mutator, and
 * the screen reads the field errors off that error — so it is left exactly as
 * it was thrown. `importDocument` is left out for a different reason: its reader
 * is a per-file report, which prints the message it was given beside the file
 * it concerns, so wrapping would only replace a specific cause with a generic
 * one.
 */
function writeFailure(relativePath: string, error: unknown): ContentWriteError {
  console.error('[content] write failed', { relativePath, error })
  return new ContentWriteError(`Failed to write ${relativePath}`, relativePath, error)
}

/* -------------------------------------------------------------------------- */
/*  Setup                                                                      */
/* -------------------------------------------------------------------------- */

let directoriesReady: Promise<void> | null = null

/** Create the working directories once per process. */
export function ensureContentDirectories(): Promise<void> {
  directoriesReady ??= (async () => {
    for (const dir of requiredContentDirs()) {
      await assertNoSymlinkPath(CONTENT_ROOT, dir, 'content directory')
      await fs.mkdir(dir, { recursive: true })
    }
    await sweepOrphanTempFiles()
  })().catch((error: unknown) => {
    // A corrected mount, permission or disk error must be retryable without
    // restarting the process solely to discard this rejected boot promise.
    directoriesReady = null
    throw error
  })
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
  await assertNoSymlinkPath(CONTENT_ROOT, TMP_DIR, 'temporary directory')
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
  await assertNoSymlinkPath(CONTENT_ROOT, file, 'content lock')
  const deadline = Date.now() + DEFAULT_LOCK_TIMEOUT_MS
  const token = randomUUID()
  const identity = await processIdentity(process.pid)

  for (;;) {
    try {
      const handle = await fs.open(file, 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, identity, at: new Date().toISOString() }),
      )
      await handle.close()

      return {
        release: async () => {
          const contents = await fs.readFile(file, 'utf8').catch(() => null)
          const owner = contents ? parseLock(contents) : null
          if (owner?.token === token) {
            await fs.unlink(file).catch(() => undefined)
          }
        },
      }
    } catch (error) {
      if (!isAlreadyExists(error)) {
        // The lock directory may not exist yet on a cold start.
        if (isNotFound(error)) {
          await assertNoSymlinkPath(CONTENT_ROOT, LOCK_DIR, 'lock directory')
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
    const parsed = JSON.parse(raw) as { pid?: number; identity?: string | null }
    if (typeof parsed.pid === 'number') {
      // A PID can name a different process after a restart, particularly PID 1
      // in Docker. Linux's boot id and kernel process-start ticks identify its
      // incarnation; a live process with a different identity is not the owner.
      const actualIdentity = parsed.identity ? await processIdentity(parsed.pid) : null
      if (parsed.identity && actualIdentity && parsed.identity !== actualIdentity) return true
      if (isProcessAlive(parsed.pid)) return false
    }
    return true
  } catch {
    return true
  }
}

async function processIdentity(pid: number): Promise<string | null> {
  try {
    const [bootId, processStat] = await Promise.all([
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    // The command name (field 2) may contain spaces and parentheses. Fields
    // after its final ')' start at field 3; starttime is field 22.
    const fields = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const started = fields[19]
    if (!started || !/^\d+$/.test(started)) return null
    return `${bootId.trim()}:${started}`
  } catch {
    // /proc is Linux-only. Elsewhere PID liveness remains the conservative
    // fallback: a live process's lock is never stolen merely because it is old.
    return null
  }
}

/** Serialize content mutations and reconciliation across processes sharing this tree. */
export async function withContentIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  const lock = await acquireLock('content-index-sync')
  try {
    return await operation()
  } finally {
    await lock.release()
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

function parseLock(raw: string): { pid?: number; token?: string } | null {
  try {
    return JSON.parse(raw) as { pid?: number; token?: string }
  } catch {
    return null
  }
}

/** Called under the content mutation lock, before bytes are replaced. */
async function assertUniqueSlug(type: ContentType, slug: string, relativePath: string): Promise<void> {
  const files = await scanContentFiles({ maxFiles: env.CONTENT_MAX_FILES + 1 })
  if (files.length > env.CONTENT_MAX_FILES) {
    throw new ContentWriteError(
      'Cannot verify slug uniqueness: the content scan exceeded CONTENT_MAX_FILES. Increase the limit before creating or renaming content.',
      relativePath,
    )
  }
  for (const file of files) {
    if (file.type !== type || file.relativePath === relativePath) continue
    let document: ContentDocument | null
    try {
      document = await readDocument(file.relativePath, { fresh: true })
    } catch (error) {
      throw new ContentWriteError(
        `Cannot verify slug uniqueness while ${file.relativePath} is unreadable or invalid. Fix that file first.`,
        relativePath,
        error,
      )
    }
    if (document?.slug === slug) {
      throw new ContentWriteError(
        `${file.relativePath} already uses the slug “${slug}”. Choose a different slug.`,
        relativePath,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Atomic write                                                               */
/* -------------------------------------------------------------------------- */

async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  const tmp = tempPath(toPosix(path.relative(CONTENT_ROOT, absolutePath)))
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')
  await assertNoSymlinkPath(CONTENT_ROOT, tmp, 'temporary file')

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
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')
  await assertNoSymlinkPath(CONTENT_ROOT, tmp, 'temporary file')

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
  return withContentIndexLock(() => createDocumentUnlocked(input))
}

async function createDocumentUnlocked(input: CreateDocumentInput): Promise<WriteResult> {
  const slug = assertSafeSlug(input.slug)
  const relativePath = buildRelativePath(input.type, slug)
  const absolutePath = documentPath(relativePath)

  await ensureContentDirectories()
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')
  if (typeof input.data.slug === 'string') {
    await assertUniqueSlug(input.type, input.data.slug.trim(), relativePath)
  }

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

    let content: string
    try {
      content = serializeFrontmatter(input.data, input.body, {
        ...(input.extra ? { extra: input.extra } : {}),
      })
      await atomicWrite(absolutePath, content)
    } catch (error) {
      throw writeFailure(relativePath, error)
    }
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
 * Delete a document's file.
 *
 * Returns the removed contents so the caller can store a final revision — a
 * delete from the admin UI must still be recoverable.
 */
export async function deleteDocument(
  relativePath: string,
  options: PreservePreviousOptions = {},
): Promise<{ relativePath: string; content: string; recoveryPath?: string } | null> {
  return withContentIndexLock(() => deleteDocumentUnlocked(relativePath, options))
}

async function deleteDocumentUnlocked(
  relativePath: string,
  options: PreservePreviousOptions,
): Promise<{ relativePath: string; content: string; recoveryPath?: string } | null> {
  const relative = toPosix(relativePath)
  const absolutePath = documentPath(relative)
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')

  const lock = await acquireLock(relative)
  try {
    const content = await fs.readFile(absolutePath, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw error
    })
    if (content === null) return null

    let recoveryPath: string | undefined
    try {
      if (options.preservePrevious) recoveryPath = await preservePreviousContent(relative, content)
    } catch (error) {
      throw writeFailure(relative, error)
    }

    await fs.unlink(absolutePath)
    await fsyncDirectory(path.dirname(absolutePath))
    invalidateContentCache(relative)

    return { relativePath: relative, content, ...(recoveryPath ? { recoveryPath } : {}) }
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
  options: PreservePreviousOptions = {},
): Promise<WriteResult> {
  return withContentIndexLock(() => updateDocumentUnlocked(relativePath, mutate, options))
}

async function updateDocumentUnlocked(
  relativePath: string,
  mutate: Parameters<typeof updateDocument>[1],
  options: PreservePreviousOptions,
): Promise<WriteResult> {
  await ensureContentDirectories()

  const relative = toPosix(relativePath)
  // Resolved up front so that a path escaping the content root fails as the
  // path guard, rather than being reported below as a write that did not happen.
  const absolutePath = documentPath(relative)
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')

  const lock = await acquireLock(relative)
  try {
    const current = await readDocument(relative, { fresh: true }).catch((error: unknown) => {
      throw writeFailure(relative, error)
    })
    if (!current) {
      throw new ContentWriteError(`No document at ${relative}`, relative)
    }

    // The mutator is the caller's code and runs before anything is written.
    // Whatever it throws — a refusal with field errors, a validation failure —
    // is the caller's own control flow and is not translated.
    const { data, body, comment } = mutate(current)
    if (typeof data.slug === 'string' && data.slug.trim() !== current.slug) {
      await assertUniqueSlug(current.type, data.slug.trim(), relative)
    }

    let content: string
    let recoveryPath: string | undefined
    try {
      content = serializeFrontmatter(data, body, {
        extra: current.extra,
        ...(comment ? { comment } : {}),
      })

      if (options.preservePrevious) recoveryPath = await preservePreviousContent(relative, current.raw)
      await atomicWrite(absolutePath, content)
    } catch (error) {
      throw writeFailure(relative, error)
    }

    // Outside the block above on purpose: by the time this runs the rename has
    // happened, so a failure here must not be reported as a write that did not.
    invalidateContentCache(relative)

    return {
      relativePath: relative,
      absolutePath,
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: current.raw,
      created: false,
      ...(recoveryPath ? { recoveryPath } : {}),
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
  options: PreservePreviousOptions = {},
): Promise<WriteResult> {
  return withContentIndexLock(() => writeRawDocumentUnlocked(relativePath, content, options))
}

async function writeRawDocumentUnlocked(
  relativePath: string,
  content: string,
  options: PreservePreviousOptions,
): Promise<WriteResult> {
  await ensureContentDirectories()

  const relative = toPosix(relativePath)
  const absolutePath = documentPath(relative)
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')

  const lock = await acquireLock(relative)
  try {
    // Restore preserves snapshot bytes, but it must obey the same slug
    // invariant as an editor save. An external edit can claim the snapshot's
    // former slug while the database still describes the older state.
    let restored: ContentDocument
    try {
      restored = parseDocument({
        relativePath: relative, absolutePath, raw: content,
        stat: { mtime: new Date(), size: Buffer.byteLength(content, 'utf8') },
      })
    } catch (error) {
      throw writeFailure(relative, error)
    }
    await assertUniqueSlug(restored.type, restored.slug, relative)

    let previous: string | null
    let recoveryPath: string | undefined
    try {
      previous = await fs.readFile(absolutePath, 'utf8').catch((error) => {
        if (isNotFound(error)) return null
        throw error
      })

      if (options.preservePrevious && previous !== null) recoveryPath = await preservePreviousContent(relative, previous)
      await atomicWrite(absolutePath, content)
    } catch (error) {
      throw writeFailure(relative, error)
    }

    // Outside the block above on purpose: by the time this runs the rename has
    // happened, so a failure here must not be reported as a write that did not.
    invalidateContentCache(relative)

    return {
      relativePath: relative,
      absolutePath,
      checksum: checksumOf(content),
      byteSize: Buffer.byteLength(content, 'utf8'),
      previousContent: previous,
      created: previous === null,
      ...(recoveryPath ? { recoveryPath } : {}),
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
  /** Existing filename when the frontmatter slug differs from it. */
  relativePath?: string
  preservePrevious?: boolean
}

/**
 * What an import write did.
 *
 * `previousContent` is here because an import with `overwrite` is the one write
 * in this application that can destroy a body without anybody having read it —
 * a bundle is planned against a tree the operator looked at, and the file it
 * lands on was written by someone else months ago. The caller needs those bytes
 * to leave a revision; nothing else in the pipeline does.
 */
export interface ImportWriteResult {
  relativePath: string
  skipped: boolean
  /** Contents of the file this replaced, or null when there was none. */
  previousContent: string | null
  recoveryPath?: string
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
): Promise<ImportWriteResult> {
  return withContentIndexLock(() => importDocumentUnlocked(input))
}

async function importDocumentUnlocked(input: ImportWriteInput): Promise<ImportWriteResult> {
  const slug = assertSafeSlug(input.slug)
  const relativePath = input.relativePath ?? buildRelativePath(input.type, slug)
  if (parseRelativePath(relativePath)?.type !== input.type) {
    throw new ContentWriteError('Not a content path for this import type', relativePath)
  }
  const absolutePath = documentPath(relativePath)

  await ensureContentDirectories()
  await assertNoSymlinkPath(CONTENT_ROOT, absolutePath, 'document')

  const lock = await acquireLock(relativePath)
  try {
    // Read under the lock, not before it: the file this is about to replace has
    // to be the one it actually replaced, and a `stat` followed by a read would
    // be two looks at a file another process may write between them.
    const previousContent = await fs.readFile(absolutePath, 'utf8').catch((error) => {
      if (isNotFound(error)) return null
      throw error
    })

    if (previousContent !== null && !input.overwrite) {
      return { relativePath, skipped: true, previousContent: null }
    }

    await assertUniqueSlug(input.type, slug, relativePath)

    const recoveryPath = input.preservePrevious && previousContent !== null
      ? await preservePreviousContent(relativePath, previousContent) : undefined
    await atomicWrite(absolutePath, input.content)
    invalidateContentCache(relativePath)
    return { relativePath, skipped: false, previousContent, ...(recoveryPath ? { recoveryPath } : {}) }
  } finally {
    await lock.release()
  }
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
