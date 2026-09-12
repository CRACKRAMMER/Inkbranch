import 'server-only'

import { gunzip, gzip } from 'node:zlib'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { contentIndex, contentRevisions, type ContentType } from '@/lib/db/schema'
import { parseFrontmatter, serializeFrontmatter } from '@/lib/content/frontmatter'
import { checksumOf } from '@/lib/content/reader'
import { writeRawDocument, type WriteResult } from '@/lib/content/writer'
import { humanizeFilename } from '@/lib/content/derive'
import { diffLines, type DiffResult } from './diff'

/**
 * Revision history.
 *
 * ## What a revision is
 *
 * A revision is the contents a write *replaced*: a complete file — frontmatter
 * and body — gzipped into `content_revisions.snapshot`. Every save hands its
 * `WriteResult.previousContent` here, so the history of a document is the list
 * of states that were superseded. The live state is never in this table,
 * because the live state is the file.
 *
 * That is what keeps the project's hardest rule intact: Markdown is the source
 * of truth, and Postgres is not a second copy of an article.
 *
 *   - A revision is a state that no longer exists anywhere else. Losing the
 *     table loses the ability to undo, not the ability to publish.
 *   - Nothing on the serving path reads a revision. `page.tsx` reads the file,
 *     through `reader.ts`, exactly as it would if this module did not exist.
 *   - Rows are safe to delete at any moment, by hand, without checking
 *     anything. A revision that some part of the site depended on would not be.
 *
 * What *would* violate the rule, and is therefore forbidden here:
 *
 *   - Reading the current body from a revision row — for an article page, a
 *     search document, an RSS feed, or a "preview". That makes the snapshot a
 *     second copy of live content, and the two can drift.
 *   - Writing a snapshot into a file whose path came from the revision rather
 *     than from `content_index`. Restore targets the document's own path, so a
 *     revision can never redirect a write.
 *   - Storing a revision *before* its file write, or in place of one. The file
 *     is the write; the snapshot is only its shadow.
 *
 * ## Ordering
 *
 * `captureRevision` is called after a successful write and never before it: a
 * row describing a save that then failed is a lie about history. The reverse
 * failure is survivable, so a capture that fails for any reason returns a
 * result instead of throwing — the content is already on disk, and the caller
 * needs to know that the revision was not recorded, not to lose the save.
 *
 * ## Retention
 *
 * Autosaves are bounded inside the inserting transaction; named saves,
 * publishes and imports are not touched by that bound. See
 * `selectPrunableAutosaves` for how an autosave is recognised — the table has
 * no `reason` column, so the summary is the marker.
 */

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type RevisionErrorCode =
  | 'REVISION'
  | 'REVISION_NOT_FOUND'
  | 'REVISION_CORRUPT'
  | 'REVISION_SLUG_MISMATCH'
  | 'REVISION_COMPARE'

export class RevisionError extends Error {
  readonly code: RevisionErrorCode = 'REVISION'
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RevisionError'
    this.cause = cause
  }
}

export class RevisionNotFoundError extends RevisionError {
  override readonly code: RevisionErrorCode = 'REVISION_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'RevisionNotFoundError'
  }
}

/** A snapshot that will not decompress: the row is there, the bytes are not. */
export class RevisionCorruptError extends RevisionError {
  override readonly code: RevisionErrorCode = 'REVISION_CORRUPT'
  constructor(
    message: string,
    readonly revisionId: string,
    cause?: unknown,
  ) {
    super(message, cause)
    this.name = 'RevisionCorruptError'
  }
}

/**
 * A restore that would move the document to a different slug. Refused rather
 * than performed, because the alternative is writing a file whose frontmatter
 * claims a name the document no longer has.
 */
export class RevisionSlugMismatchError extends RevisionError {
  override readonly code: RevisionErrorCode = 'REVISION_SLUG_MISMATCH'
  constructor(
    message: string,
    readonly documentSlug: string,
    readonly revisionSlug: string,
  ) {
    super(message)
    this.name = 'RevisionSlugMismatchError'
  }
}

/** Two revisions of different documents have no meaningful diff. */
export class RevisionCompareError extends RevisionError {
  override readonly code: RevisionErrorCode = 'REVISION_COMPARE'
  constructor(message: string) {
    super(message)
    this.name = 'RevisionCompareError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Policy                                                                     */
/* -------------------------------------------------------------------------- */

/** Why a revision was recorded. */
export type RevisionReason =
  | 'autosave'
  | 'save'
  | 'publish'
  | 'restore'
  | 'import'
  | 'rename'

/**
 * Autosaves kept per document. An autosave every couple of seconds while
 * somebody types is unbounded growth; the newest few are the ones that make an
 * accidental edit recoverable, and older ones are worth less than the row they
 * occupy. Named saves and publishes are never pruned by this bound.
 */
export const AUTOSAVE_REVISIONS_KEPT = 20

/**
 * Label that marks an autosave.
 *
 * `content_revisions` has no `reason` column, so the summary is what tells an
 * autosave apart from a save that someone meant to make. Changing this string
 * changes what the prune selects, which is why it is a constant with one user.
 */
export const AUTOSAVE_SUMMARY = 'Autosave'

export const DEFAULT_REVISION_LIMIT = 50
export const MAX_REVISION_LIMIT = 200

/* -------------------------------------------------------------------------- */
/*  Input validation                                                           */
/* -------------------------------------------------------------------------- */

const captureSchema = z.object({
  contentId: z.uuid(),
  type: z.enum(['post', 'note', 'project']),
  slug: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()),
  body: z.string(),
  previousContent: z.string().nullable(),
  reason: z.enum(['autosave', 'save', 'publish', 'restore', 'import', 'rename']),
  actorId: z.uuid().nullish(),
})

export interface CaptureRevisionInput {
  /** `content_index.id` of the document this write belongs to. */
  contentId: string
  type: ContentType
  /** Slug the document has right now, after the write. */
  slug: string
  /** Frontmatter that was just written. */
  data: Record<string, unknown>
  /** Body that was just written. */
  body: string
  /** State the write replaced, from `WriteResult.previousContent`. */
  previousContent: string | null
  reason: RevisionReason
  /** Author of the write; null for the CLI, a job, or the importer. */
  actorId?: string | null
}

export type CaptureSkipReason =
  | 'unchanged'
  | 'no-previous-state'
  | 'invalid-input'
  | 'failed'

export interface CaptureResult {
  /** True when a row was inserted. */
  captured: boolean
  /**
   * Why nothing was inserted. `failed` means the attempt errored; the write it
   * followed has already succeeded either way.
   */
  skipped: CaptureSkipReason | null
  revisionId: string | null
  revisionNo: number | null
  /** Autosave rows the bound removed in the same transaction. */
  pruned: number
  error: RevisionError | null
}

/* -------------------------------------------------------------------------- */
/*  Capture                                                                    */
/* -------------------------------------------------------------------------- */

export async function captureRevision(
  input: CaptureRevisionInput,
): Promise<CaptureResult> {
  const parsed = captureSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return failedCapture(`Cannot record a revision: ${issues}`, parsed.error, 'invalid-input')
  }
  const request = parsed.data

  if (request.previousContent === null) {
    // Nothing existed before this write, so there is no past state to keep. The
    // file that was just created is the only state that has ever existed and it
    // is on disk; copying it into Postgres would put a live article in the
    // database, which is the one thing this module must not do. The create-time
    // contents are recorded by the *next* save, as that save's previous state.
    return skippedCapture('no-previous-state')
  }

  try {
    const snapshotText = request.previousContent
    const contentHash = checksumOf(snapshotText)
    const snapshot = await gzipAsync(Buffer.from(snapshotText, 'utf8'))

    // The stats describe what the save did, and the list page shows them
    // without touching a blob — that is the whole reason they are columns.
    // Reconstructing the written text from `data` and `body` matches what the
    // writer produced except when the caller passed keys the writer serialises
    // separately; a frontmatter change made that way can be off by a line.
    const written = serializeFrontmatter(request.data, request.body)
    const diff = diffLines(snapshotText, written)

    const snapshotFacts = readSnapshotFacts(snapshotText)
    const newTitle = asText(request.data.title)
    const newSlug = asText(request.data.slug)
    const title = clamp(
      snapshotFacts.title || newTitle || humanizeFilename(`${request.slug}.md`),
      300,
    )
    const summary = clamp(
      buildSummary({
        reason: request.reason,
        oldTitle: snapshotFacts.title,
        newTitle,
        oldSlug: snapshotFacts.slug,
        newSlug,
        additions: diff.stats.additions,
        deletions: diff.stats.deletions,
      }),
      200,
    )

    const outcome = await db.transaction(async (tx) => {
      // Lock the document row. Two saves of the same article would otherwise be
      // free to compute the same `revision_no`, and the autosave bound would be
      // two deletes racing over the same rows.
      const [document] = await tx
        .select({ id: contentIndex.id })
        .from(contentIndex)
        .where(eq(contentIndex.id, request.contentId))
        .for('update')

      if (!document) {
        throw new RevisionError(
          `No content row for ${request.contentId}; cannot record its revision`,
        )
      }

      const [latest] = await tx
        .select({
          revisionNo: contentRevisions.revisionNo,
          contentHash: contentRevisions.contentHash,
        })
        .from(contentRevisions)
        .where(eq(contentRevisions.contentId, request.contentId))
        .orderBy(desc(contentRevisions.revisionNo))
        .limit(1)

      // Someone pressing Ctrl+S twice has not made two versions. The rows are
      // whole files, so the second one would double the storage of the first to
      // say nothing.
      if (latest && latest.contentHash === contentHash) {
        return { skipped: 'unchanged' as const, revisionId: null, revisionNo: null, pruned: 0 }
      }

      const revisionNo = (latest?.revisionNo ?? 0) + 1

      const [inserted] = await tx
        .insert(contentRevisions)
        .values({
          contentId: request.contentId,
          revisionNo,
          title,
          snapshot,
          contentHash,
          byteSize: Buffer.byteLength(snapshotText, 'utf8'),
          additions: diff.stats.additions,
          deletions: diff.stats.deletions,
          summary,
          authorId: request.actorId ?? null,
        })
        .returning({
          id: contentRevisions.id,
          revisionNo: contentRevisions.revisionNo,
        })

      // Pruned here, not by a later job: an unbounded autosave run would be
      // written in full before anything got round to trimming it.
      const pruned = await pruneAutosaves(tx, request.contentId)

      return {
        skipped: null,
        revisionId: inserted?.id ?? null,
        revisionNo: inserted?.revisionNo ?? revisionNo,
        pruned,
      }
    })

    return {
      captured: outcome.skipped === null,
      skipped: outcome.skipped,
      revisionId: outcome.revisionId,
      revisionNo: outcome.revisionNo,
      pruned: outcome.pruned,
      error: null,
    }
  } catch (error) {
    return failedCapture(
      `Could not record a revision of ${request.slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    )
  }
}

/**
 * Delete autosaves beyond the bound, inside the caller's transaction.
 *
 * Only metadata is read — the blobs are what the bound exists to stop carrying
 * around. The candidate list is bounded by the retention policy itself: a
 * document's autosaves are trimmed to `AUTOSAVE_REVISIONS_KEPT` on every write.
 */
async function pruneAutosaves(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  contentId: string,
): Promise<number> {
  const rows = await tx
    .select({
      id: contentRevisions.id,
      revisionNo: contentRevisions.revisionNo,
      summary: contentRevisions.summary,
    })
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.revisionNo))

  const doomed = selectPrunableAutosaves(rows, AUTOSAVE_REVISIONS_KEPT)
  if (doomed.length === 0) return 0

  await tx.delete(contentRevisions).where(inArray(contentRevisions.id, doomed))
  return doomed.length
}

/**
 * Which of a document's revisions the autosave bound must remove.
 *
 * Pure, and separate from the query, because "which rows go" is a policy worth
 * testing without a database: the answer must be the same whichever order the
 * rows arrive in, and it must never name a row that a person saved on purpose.
 */
export function selectPrunableAutosaves(
  rows: readonly { id: string; revisionNo: number; summary: string }[],
  keep: number,
): string[] {
  const bound = Math.max(0, Math.trunc(keep))
  const autosaves = rows
    .filter((row) => row.summary === AUTOSAVE_SUMMARY)
    // Sorted here rather than trusted from the caller: the prune runs inside a
    // transaction, and a wrong order would delete the newest autosave.
    .sort((a, b) => b.revisionNo - a.revisionNo)

  return autosaves.slice(bound).map((row) => row.id)
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The columns a list needs. Everything except the snapshot, deliberately: a
 * page that shows timestamps must not decompress two hundred files to do it.
 */
const metadataColumns = {
  id: contentRevisions.id,
  contentId: contentRevisions.contentId,
  revisionNo: contentRevisions.revisionNo,
  title: contentRevisions.title,
  contentHash: contentRevisions.contentHash,
  byteSize: contentRevisions.byteSize,
  additions: contentRevisions.additions,
  deletions: contentRevisions.deletions,
  summary: contentRevisions.summary,
  authorId: contentRevisions.authorId,
  createdAt: contentRevisions.createdAt,
} as const

export interface RevisionSummary {
  id: string
  contentId: string
  revisionNo: number
  /** Title the document carried in this state. */
  title: string
  /** SHA-256 of the uncompressed snapshot. */
  contentHash: string
  /** Size of the uncompressed snapshot, in bytes. */
  byteSize: number
  additions: number
  deletions: number
  summary: string
  authorId: string | null
  createdAt: Date
}

export interface ListRevisionsOptions {
  /** Defaults to `DEFAULT_REVISION_LIMIT`, capped at `MAX_REVISION_LIMIT`. */
  limit?: number
  offset?: number
}

/**
 * The query `listRevisions` runs, exported so the "never selects the blob" rule
 * is testable without a database.
 */
export function listRevisionsQuery(
  contentId: string,
  options: ListRevisionsOptions = {},
) {
  return db
    .select(metadataColumns)
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.revisionNo))
    .limit(pageSize(options.limit))
    .offset(Math.max(0, Math.trunc(options.offset ?? 0)))
}

/** Newest first. Metadata only; use `getRevision` for the contents. */
export async function listRevisions(
  contentId: string,
  options: ListRevisionsOptions = {},
): Promise<RevisionSummary[]> {
  const rows: RevisionSummary[] = await listRevisionsQuery(contentId, options)
  return rows
}

export interface RevisionDetail extends RevisionSummary {
  /** Decompressed snapshot: the complete file as it was, frontmatter included. */
  content: string
}

/** One revision, contents included, for the viewer and for restore. */
export async function getRevision(id: string): Promise<RevisionDetail> {
  const [row] = await db
    .select({ ...metadataColumns, snapshot: contentRevisions.snapshot })
    .from(contentRevisions)
    .where(eq(contentRevisions.id, id))
    .limit(1)

  if (!row) {
    throw new RevisionNotFoundError(`No revision with id ${id}`)
  }

  const { snapshot, ...metadata } = row
  return { ...metadata, content: await gunzipAsync(snapshot, id) }
}

export interface RevisionComparison {
  /** The two revisions in the order the caller passed them. */
  from: RevisionSummary
  to: RevisionSummary
  diff: DiffResult
}

/**
 * Line diff between two revisions of the same document.
 *
 * Both bodies are decompressed here; that is the one place the cost is worth
 * paying, because the result is the reason the reader asked.
 */
export async function compareRevisions(
  fromId: string,
  toId: string,
): Promise<RevisionComparison> {
  const [from, to] = await Promise.all([getRevision(fromId), getRevision(toId)])

  if (from.contentId !== to.contentId) {
    throw new RevisionCompareError(
      `Revisions ${fromId} and ${toId} belong to different documents; a diff between them would not describe an edit`,
    )
  }

  const { content: fromContent, ...fromSummary } = from
  const { content: toContent, ...toSummary } = to

  return {
    from: fromSummary,
    to: toSummary,
    diff: diffLines(fromContent, toContent),
  }
}

/* -------------------------------------------------------------------------- */
/*  Restore                                                                    */
/* -------------------------------------------------------------------------- */

export interface RestoreResult extends WriteResult {
  /** The revision that was written back into the file. */
  restoredRevisionId: string
  /**
   * The revision captured from the state the restore replaced.
   *
   * When `captured` is false the restore still happened, and the state it
   * replaced survives only if the capture succeeded — so a caller that offers
   * "undo" must check this and say so.
   */
  revision: CaptureResult
}

/**
 * Put a revision back into the file.
 *
 * A restore is an ordinary write: it goes through the writer's lock, temp file
 * and atomic rename, and it returns the same `WriteResult` every other save
 * returns. It writes through `writeRawDocument` rather than `updateDocument`
 * because a restore must reproduce the snapshot's bytes — `updateDocument`
 * parses the current file and re-serialises it, which drops the snapshot's
 * frontmatter comments, reorders its keys and merges the *current* file's
 * unknown keys into the restored state. That is not a restore.
 *
 * The state being replaced is captured as this write's previous content, in the
 * same after-the-write order as any other save. Recording it *before* the write
 * would risk a revision for a restore that failed; recording it here means a
 * restore is undoable exactly when the returned `revision.captured` is true.
 */
export async function restoreRevision(
  id: string,
  actorId?: string | null,
): Promise<RestoreResult> {
  const revision = await getRevision(id)

  const [document] = await db
    .select({
      id: contentIndex.id,
      type: contentIndex.type,
      slug: contentIndex.slug,
      path: contentIndex.path,
    })
    .from(contentIndex)
    .where(eq(contentIndex.id, revision.contentId))
    .limit(1)

  if (!document) {
    throw new RevisionNotFoundError(
      `Revision ${id} belongs to a document that is no longer indexed`,
    )
  }

  // The write target is the document's own path, never anything derived from
  // the revision, so a wrong slug can only ever be refused — never followed.
  const facts = readSnapshotFacts(revision.content)
  if (facts.slug && facts.slug !== document.slug) {
    throw new RevisionSlugMismatchError(
      `Revision ${id} was saved under the slug "${facts.slug}", but the document is now "${document.slug}". Restoring it would put one document's contents under another's name; rename the document back first.`,
      document.slug,
      facts.slug,
    )
  }

  const written = await writeRawDocument(document.path, revision.content)

  const parsed = parseFrontmatter(revision.content)
  const captured = await captureRevision({
    contentId: document.id,
    type: document.type,
    slug: document.slug,
    data: parsed.data,
    body: parsed.content,
    previousContent: written.previousContent,
    reason: 'restore',
    actorId: actorId ?? null,
  })

  return { ...written, restoredRevisionId: id, revision: captured }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function skippedCapture(reason: CaptureSkipReason): CaptureResult {
  return {
    captured: false,
    skipped: reason,
    revisionId: null,
    revisionNo: null,
    pruned: 0,
    error: null,
  }
}

function failedCapture(
  message: string,
  cause: unknown,
  skipped: CaptureSkipReason = 'failed',
): CaptureResult {
  return {
    captured: false,
    skipped,
    revisionId: null,
    revisionNo: null,
    pruned: 0,
    error: new RevisionError(message, cause),
  }
}

/**
 * What the snapshot says about itself: the title it carries and the slug it
 * declares. Both are labels — a snapshot whose YAML no longer parses is still a
 * complete file, and it is not worth losing the whole revision over a name.
 */
function readSnapshotFacts(content: string): { title: string; slug: string } {
  try {
    const parsed = parseFrontmatter(content)
    return { title: asText(parsed.data.title), slug: asText(parsed.data.slug) }
  } catch {
    return { title: '', slug: '' }
  }
}

function buildSummary(input: {
  reason: RevisionReason
  oldTitle: string
  newTitle: string
  oldSlug: string
  newSlug: string
  additions: number
  deletions: number
}): string {
  switch (input.reason) {
    case 'autosave':
      return AUTOSAVE_SUMMARY
    case 'import':
      // Only ever reached for a document that already existed: an import that
      // creates a file has no previous state to keep, and `captureRevision`
      // returns `no-previous-state` before it gets here. "Initial import" would
      // describe the one case this cannot be.
      return 'Replaced by import'
    case 'restore':
      return 'Before restore'
    case 'publish':
      return 'Published'
    case 'rename':
      return input.oldSlug && input.newSlug && input.oldSlug !== input.newSlug
        ? `Renamed from ${input.oldSlug}`
        : 'Renamed'
    case 'save':
      if (input.oldTitle && input.newTitle && input.oldTitle !== input.newTitle) {
        return 'Changed title'
      }
      return input.additions + input.deletions > 0 ? 'Edited' : 'Saved'
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Postgres refuses an over-long value rather than truncating it. */
function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REVISION_LIMIT
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_REVISION_LIMIT)
}

/**
 * gzip/gunzip, async: this runs on a save's request path, and the sync
 * variants would block the event loop for the whole file.
 */
function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, (error, result) => {
      if (error) {
        reject(
          new RevisionError(`Cannot compress the revision snapshot: ${error.message}`, error),
        )
        return
      }
      resolve(result)
    })
  })
}

function gunzipAsync(input: Buffer, revisionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    gunzip(input, (error, result) => {
      if (error) {
        reject(
          new RevisionCorruptError(
            `Revision ${revisionId} will not decompress: ${error.message}`,
            revisionId,
            error,
          ),
        )
        return
      }
      resolve(result.toString('utf8'))
    })
  })
}
