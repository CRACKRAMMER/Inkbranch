'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAudit, type AuditAction } from '@/lib/audit'
import { parseFrontmatter, serializeFrontmatter } from '@/lib/content/frontmatter'
import { readDocument } from '@/lib/content/reader'
import {
  CONTENT_TYPES,
  frontmatterSchemaFor,
  normaliseFrontmatterKeys,
  splitFrontmatterKeys,
  type ContentStatus,
  type ContentType,
} from '@/lib/content/schema'
import { removeFromIndex, syncOneDocument } from '@/lib/content/sync'
import {
  ContentWriteError,
  createDocument,
  deleteDocument,
  updateDocument,
} from '@/lib/content/writer'
import { contentRowByPath, takenSlugs } from '@/lib/admin/queries'
import {
  contentFormSchema,
  dateKeyOf,
  frontmatterFromForm,
  preservedKeys,
  validateFrontmatter,
} from '@/lib/admin/frontmatter-form'
import {
  captureWithPolicy,
  type CaptureWithPolicyResult,
} from '@/lib/admin/revisions'
import { actionFailure, actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'
import { revalidateContentChange } from '@/lib/admin/revalidate'

/**
 * Every write an admin makes to a Markdown file goes through this module.
 *
 * Three things happen on each save, always in this order, and the order is the
 * contract:
 *
 *   1. `updateDocument` writes the file atomically and hands back the contents
 *      it replaced.
 *   2. The replacement contents are recorded as a revision — *after* the write,
 *      because a revision is what the write replaced, and recording it first
 *      would claim a state the file never had.
 *   3. `syncOneDocument` updates the index, so the row and the file agree.
 *
 * Nothing here writes with `fs` directly, and no failure path leaves a partially
 * written file: `updateDocument` either renames a complete file into place or
 * throws having touched nothing.
 */

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A content path as the scanner produces them. The narrow pattern is the point:
 * this string reaches the filesystem, and a path that cannot contain `..`, a
 * separator or a control character cannot escape the content directory.
 */
const contentPathSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) =>
      // Control characters are excluded explicitly: the OS and the path walk
      // both treat a NUL as a terminator, so a path carrying one addresses a
      // different file than it appears to.
      // eslint-disable-next-line no-control-regex
      /^(posts|notes|projects)\/[^/\\\u0000-\u001f\u007f]+\.md$/.test(value) &&
      !value.includes('..'),
    { message: 'Not a content path' },
  )

const bodySchema = z.string().max(2_000_000, 'The body is larger than 2 MB')

const saveSchema = z.object({
  path: contentPathSchema,
  /** Checksum the editor loaded; the save refuses when the file has moved on. */
  baseChecksum: z.string().length(64),
  values: contentFormSchema,
  body: bodySchema,
  /** Explicit overwrite of a file that changed on disk since it was loaded. */
  force: z.boolean().optional(),
  /** Recorded on the revision, so the history says why a save happened. */
  comment: z.string().trim().max(140).optional(),
})

export type SaveContentInput = z.output<typeof saveSchema>

export interface SaveContentResult {
  path: string
  slug: string
  checksum: string
  status: ContentStatus
  savedAt: string
  wordCount: number
  /**
   * What became of the revision; `skipped` is normal and not a failure, and
   * `disabled` means the settings switch is off rather than that anything broke.
   */
  revision: CaptureWithPolicyResult
}

/**
 * Thrown from inside `updateDocument`'s mutator, which runs under the file lock
 * and before anything is written. Aborting there is what makes "the original file
 * was not modified" a fact rather than a hope.
 */
class SaveRefusedError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly issues: string[] = [],
    /** Set when the refusal is a stale-file conflict, which the editor can override. */
    readonly code: 'stale' | null = null,
  ) {
    super(message)
    this.name = 'SaveRefusedError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared write                                                               */
/* -------------------------------------------------------------------------- */

interface WriteOutcome {
  slug: string
  path: string
  checksum: string
  status: ContentStatus
  wordCount: number
  previousContent: string | null
  data: Record<string, unknown>
  body: string
}

/**
 * Write one document, returning what was written so the caller can record a
 * revision without re-reading the file it just replaced.
 *
 * `mutate` receives the *current* file contents and returns the frontmatter and
 * body to write, exactly like `updateDocument` — but with the checksum check and
 * frontmatter validation already wired in, because skipping either is the
 * mistake worth designing out.
 */
async function writeChecked(
  input: {
    path: string
    baseChecksum?: string
    force?: boolean
    type: ContentType
  },
  mutate: (current: {
    raw: string
    normalised: Record<string, unknown>
    known: Record<string, unknown>
    body: string
  }) => { data: Record<string, unknown>; body: string; comment?: string },
): Promise<WriteOutcome> {
  const captured: { data: Record<string, unknown>; body: string } = { data: {}, body: '' }

  const result = await updateDocument(input.path, (current) => {
    if (!input.force && input.baseChecksum && current.checksum !== input.baseChecksum) {
      throw new SaveRefusedError(
        'This file changed on disk since you opened it. Nothing was written.',
        {},
        [
          `${input.path} is now ${current.checksum.slice(0, 8)}, you loaded ${input.baseChecksum.slice(0, 8)}.`,
        ],
        'stale',
      )
    }

    const parsed = parseFrontmatter(current.raw)
    const normalised = normaliseFrontmatterKeys(parsed.data)
    const { known } = splitFrontmatterKeys(normalised)

    const produced = mutate({ raw: current.raw, normalised, known, body: current.body })

    // The per-type schema is the last gate before serialisation. A file that
    // fails it would be written and then fail to load, which is worse than
    // refusing the save.
    const checked = validateFrontmatter(input.type, produced.data, frontmatterSchemaFor(input.type))
    if (!checked.ok) {
      throw new SaveRefusedError(
        'The frontmatter did not validate, so nothing was written.',
        checked.fieldErrors,
        checked.issues,
      )
    }

    captured.data = produced.data
    captured.body = produced.body
    return produced
  })

  const written = await readDocument(result.relativePath)

  return {
    slug: written?.slug ?? input.path,
    path: result.relativePath,
    checksum: result.checksum,
    status: written?.status ?? 'draft',
    wordCount: written?.wordCount ?? 0,
    previousContent: result.previousContent,
    data: captured.data,
    body: captured.body,
  }
}

/** Record the revision and refresh the index for a completed write. */
async function afterWrite(
  outcome: WriteOutcome,
  type: ContentType,
  reason: 'save' | 'publish',
  actorId: string,
): Promise<CaptureWithPolicyResult> {
  const row = await contentRowByPath(outcome.path)

  // No index row means no document to attach a revision to. The sync below
  // creates one, so this is a narrow window rather than a normal state.
  const revision = row
    ? await captureWithPolicy({
        contentId: row.id,
        type,
        slug: outcome.slug,
        data: outcome.data,
        body: outcome.body,
        previousContent: outcome.previousContent,
        reason,
        actorId,
      })
    : {
        captured: false,
        skipped: 'no-previous-state' as const,
        revisionId: null,
        revisionNo: null,
        pruned: 0,
        error: null,
        disabled: false,
        trimmed: 0,
      }

  await syncOneDocument(outcome.path)

  return revision
}


/**
 * Choose the audit action for a status change.
 *
 * `AUDIT_ACTIONS` is a closed union and the only content actions in it are the
 * `post.*` ones, so notes and projects record under the same five names with
 * their type in the metadata. Inventing `note.publish` here would write rows no
 * query in the codebase looks for.
 */
function auditActionForTransition(from: ContentStatus, to: ContentStatus): AuditAction {
  if (from !== 'published' && to === 'published') return 'post.publish'
  if (from === 'published' && to !== 'published') return 'post.unpublish'
  return 'post.update'
}

/* -------------------------------------------------------------------------- */
/*  Save                                                                       */
/* -------------------------------------------------------------------------- */

export async function saveContentAction(
  input: SaveContentInput,
): Promise<ActionResult<SaveContentResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(saveSchema, input)
    if (!parsed.ok) return parsed

    const existing = await readDocument(parsed.value.path)
    if (!existing) {
      return actionFailure(`${parsed.value.path} is no longer on disk.`, { retryable: false })
    }

    const type = existing.type
    const previousStatus = existing.status

    const slugCollision = await checkSlug(type, parsed.value.values.slug, parsed.value.path)
    if (slugCollision) return slugCollision

    const outcome = await writeChecked(
      {
        path: parsed.value.path,
        baseChecksum: parsed.value.baseChecksum,
        force: parsed.value.force,
        type,
      },
      ({ normalised, known }) => {
        const data = frontmatterFromForm(parsed.value.values, preservedKeys(known), {
          dateKey: dateKeyOf(normalised),
          type,
        })
        // Only documents that already carry `updated` get one rewritten: adding
        // the key to a hand-authored file changes it for no reader-visible gain,
        // and the index falls back to the file's mtime anyway.
        if (normalised.updated !== undefined) data.updated = todayIso()
        return { data, body: parsed.value.body, comment: parsed.value.comment }
      },
    )

    const revision = await afterWrite(
      outcome,
      type,
      outcome.status === 'published' ? 'publish' : 'save',
      context.user.id,
    )

    await recordAudit({
      action: auditActionForTransition(previousStatus, outcome.status),
      actorId: context.user.id,
      targetType: 'content',
      targetId: outcome.path,
      metadata: {
        type,
        slug: outcome.slug,
        status: outcome.status,
        previousStatus,
        wordCount: outcome.wordCount,
        ...(parsed.value.comment ? { comment: parsed.value.comment } : {}),
      },
      request: context.request,
    })

    revalidateContentChange(type, outcome.slug)

    return actionOk({
      path: outcome.path,
      slug: outcome.slug,
      checksum: outcome.checksum,
      status: outcome.status,
      savedAt: new Date().toISOString(),
      wordCount: outcome.wordCount,
      revision,
    })
  } catch (error) {
    if (error instanceof SaveRefusedError) {
      return actionFailure(error.message, {
        fieldErrors: Object.keys(error.fieldErrors).length > 0 ? error.fieldErrors : undefined,
        detail: error.issues.join('; ') || undefined,
        retryable: false,
        ...(error.code ? { code: error.code } : {}),
      })
    }
    return describeActionError(error)
  }
}

/**
 * A slug rename is a frontmatter change, not a file rename.
 *
 * Moving the file would change its URL anyway (the site routes on slug, which
 * the file's frontmatter supplies) and would silently break every existing
 * revision's path. Refusing a collision here rather than letting the unique
 * index reject the write keeps the error message about the slug the operator
 * typed.
 */
async function checkSlug(
  type: ContentType,
  slug: string,
  path: string,
): Promise<ActionResult<never> | null> {
  if (!slug) return null
  const taken = await takenSlugs(type, path)
  if (!taken.includes(slug)) return null
  return actionFailure(`Another ${type} already uses the slug “${slug}”.`, {
    fieldErrors: { slug: `Another ${type} already uses this slug.` },
  })
}

/* -------------------------------------------------------------------------- */
/*  Autosave                                                                   */
/* -------------------------------------------------------------------------- */

const autosaveSchema = z.object({
  path: contentPathSchema,
  values: contentFormSchema,
  body: bodySchema,
})

export type AutosaveInput = z.output<typeof autosaveSchema>

export interface AutosaveResult {
  revisionId: string | null
  revisionNo: number | null
  captured: boolean
  skipped: string | null
  /** True when revision history is switched off in Settings. */
  revisionsDisabled: boolean
  savedAt: string
}

/**
 * Autosave records a revision of the *buffer*; it does not touch the file.
 *
 * That is the whole design: the spec's requirement is that autosave must not
 * overwrite the document, and a revision is a complete file in Postgres, so an
 * autosave is a recovery point that costs the disk nothing. The buffer itself is
 * what gets stored, not the state it replaced — the point of a crash-recovery
 * snapshot is to be the newest thing the author typed, and a snapshot of the
 * previous state would be one interval behind when it mattered.
 *
 * Restoring one writes the file through `restoreRevision`, which is a real save
 * with a real diff, so nothing enters the file without passing the same checks a
 * manual save does.
 */
export async function autosaveContentAction(
  input: AutosaveInput,
): Promise<ActionResult<AutosaveResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(autosaveSchema, input)
    if (!parsed.ok) return parsed

    const existing = await readDocument(parsed.value.path)
    if (!existing) {
      return actionFailure('The file is no longer on disk, so nothing was autosaved.')
    }

    const row = await contentRowByPath(parsed.value.path)
    if (!row) {
      return actionFailure('This document is not in the content index yet, so it cannot autosave.', {
        detail: 'Save once with ⌘S, or run a content sync.',
      })
    }

    const normalised = normaliseFrontmatterKeys(parseFrontmatter(existing.raw).data)
    const { known } = splitFrontmatterKeys(normalised)
    const data = frontmatterFromForm(parsed.value.values, preservedKeys(known), {
      dateKey: dateKeyOf(normalised),
      type: existing.type,
    })

    // The revision's snapshot is `previousContent`, so the buffer itself is what
    // gets stored: the newest autosave is then exactly what the author had typed,
    // which is the only property that matters when it is used to recover.
    const snapshot = serializeFrontmatter(data, parsed.value.body)

    const result = await captureWithPolicy({
      contentId: row.id,
      type: existing.type,
      slug: existing.slug,
      data,
      body: parsed.value.body,
      previousContent: snapshot,
      reason: 'autosave',
      actorId: context.user.id,
    })

    if (result.error) {
      return actionFailure('Autosave could not be recorded. Your file on disk is untouched.', {
        detail: result.error.message,
        retryable: true,
      })
    }

    return actionOk({
      revisionId: result.revisionId,
      revisionNo: result.revisionNo,
      captured: result.captured,
      skipped: result.skipped,
      revisionsDisabled: result.disabled,
      savedAt: new Date().toISOString(),
    })
  } catch (error) {
    return describeActionError(error)
  }
}

/* -------------------------------------------------------------------------- */
/*  Create                                                                     */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  type: z.enum(CONTENT_TYPES),
  title: z.string().trim().min(1, 'A title is required').max(300),
  slug: z
    .string()
    .trim()
    .min(1, 'A slug is required')
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens only'),
  status: z.enum(['draft', 'published', 'scheduled', 'archived']),
  date: z
    .string()
    .trim()
    .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), {
      message: 'Use YYYY-MM-DD',
    }),
})

export type CreateContentInput = z.output<typeof createSchema>

export async function createContentAction(
  input: CreateContentInput,
): Promise<ActionResult<{ path: string; slug: string }>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(createSchema, input)
    if (!parsed.ok) return parsed

    const { type, title, slug, status } = parsed.value

    const taken = await takenSlugs(type)
    if (taken.includes(slug)) {
      return actionFailure(`A ${type} with the slug “${slug}” already exists.`, {
        fieldErrors: { slug: 'This slug is already taken.' },
      })
    }

    // A published document without a date cannot be rendered by the site (it has
    // no ordering and no feed timestamp), so the create form's date defaults to
    // today rather than being left blank.
    const date = parsed.value.date || todayIso()

    const built = frontmatterFromForm(
      {
        title,
        slug,
        description: '',
        status,
        date,
        publishAt: '',
        tags: [],
        category: '',
        series: '',
        cover: '',
        featured: false,
        toc: true,
        seoTitle: '',
        seoDescription: '',
        seoCanonical: '',
        seoOgImage: '',
        seoNoindex: false,
        projectStatus: 'active',
        started: '',
        repo: '',
        website: '',
        stack: [],
      },
      {},
      { dateKey: 'date', type },
    )

    const checked = validateFrontmatter(type, built, frontmatterSchemaFor(type))
    if (!checked.ok) {
      return actionFailure('That document would not be valid as written.', {
        fieldErrors: checked.fieldErrors,
        detail: checked.issues.join('; '),
      })
    }

    const result = await createDocument({ type, slug, data: built, body: '' })
    await syncOneDocument(result.relativePath)

    await recordAudit({
      action: 'post.create',
      actorId: context.user.id,
      targetType: 'content',
      targetId: result.relativePath,
      metadata: { type, slug, status },
      request: context.request,
    })

    revalidateContentChange(type, slug)

    return actionOk({ path: result.relativePath, slug })
  } catch (error) {
    return describeActionError(error)
  }
}

/* -------------------------------------------------------------------------- */
/*  Delete and bulk operations                                                 */
/* -------------------------------------------------------------------------- */

const deleteSchema = z.object({ path: contentPathSchema })

export type DeleteContentInput = z.output<typeof deleteSchema>

/**
 * Delete one document.
 *
 * The file goes first and the index row second, because a row without a file is
 * a broken link on the site while a file without a row is merely invisible. The
 * revision history does not survive either: revisions cascade from the content
 * row, so deleting a document destroys the ability to undo this. That is stated
 * in the confirmation rather than discovered later.
 */
export async function deleteContentAction(
  input: DeleteContentInput,
): Promise<ActionResult<{ path: string }>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(deleteSchema, input)
    if (!parsed.ok) return parsed

    const row = await contentRowByPath(parsed.value.path)
    const removed = await deleteDocument(parsed.value.path)
    if (!removed) {
      return actionFailure('That file is no longer on disk.')
    }

    await removeFromIndex(parsed.value.path)

    await recordAudit({
      action: 'post.delete',
      actorId: context.user.id,
      targetType: 'content',
      targetId: parsed.value.path,
      metadata: {
        type: row?.type ?? 'unknown',
        slug: row?.slug ?? '',
        title: row?.title ?? '',
        status: row?.status ?? '',
        wordCount: row?.wordCount ?? 0,
      },
      request: context.request,
    })

    // The type and slug come from the row read before the file was removed,
    // because after it there is nothing left to ask. When the row is already
    // gone there is no document URL to discard and the list is all that is
    // stale.
    if (row) revalidateContentChange(row.type, row.slug)
    else revalidatePath('/admin')

    return actionOk({ path: parsed.value.path })
  } catch (error) {
    return describeActionError(error)
  }
}

const bulkSchema = z.object({
  paths: z.array(contentPathSchema).min(1, 'Select at least one document').max(100),
  action: z.enum(['publish', 'unpublish', 'delete', 'add-tag']),
  tag: z.string().trim().min(1).max(80).optional(),
})

export type BulkInput = z.output<typeof bulkSchema>

export interface BulkReport {
  action: string
  changed: { path: string; slug: string; note?: string }[]
  failed: { path: string; error: string }[]
}

/**
 * Bulk actions applied one document at a time.
 *
 * Sequential rather than parallel: each write takes a per-file lock and rewrites
 * the index row, and firing a hundred of those at once would produce lock
 * contention whose failure mode is a confusing error on a screen where the
 * operator asked for one thing. A partial run is reported honestly and is safe
 * to repeat — every step is idempotent, and a document that already has the
 * requested status is left alone.
 */
export async function bulkContentAction(input: BulkInput): Promise<ActionResult<BulkReport>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(bulkSchema, input)
    if (!parsed.ok) return parsed

    const { paths, action, tag } = parsed.value

    if (action === 'add-tag' && !tag) {
      return actionFailure('A tag name is required.')
    }

    const report: BulkReport = { action, changed: [], failed: [] }

    for (const path of paths) {
      try {
        if (action === 'delete') {
          const row = await contentRowByPath(path)
          const removed = await deleteDocument(path)
          if (!removed) {
            report.failed.push({ path, error: 'Not found on disk.' })
            continue
          }
          await removeFromIndex(path)
          await recordAudit({
            action: 'post.delete',
            actorId: context.user.id,
            targetType: 'content',
            targetId: path,
            metadata: {
              type: row?.type ?? 'unknown',
              slug: row?.slug ?? '',
              title: row?.title ?? '',
              status: row?.status ?? '',
            },
            request: context.request,
          })
          if (row) revalidateContentChange(row.type, row.slug)
          else revalidatePath('/')
          report.changed.push({ path, slug: row?.slug ?? path })
          continue
        }

        if (action === 'add-tag') {
          const outcome = await addTagToDocument(path, tag as string, context.user.id)
          if (outcome.note) report.changed.push({ path, slug: outcome.slug, note: outcome.note })
          else report.changed.push({ path, slug: outcome.slug })
          revalidateContentChange(outcome.type, outcome.slug)
          continue
        }

        const target: ContentStatus = action === 'publish' ? 'published' : 'draft'
        const existing = await readDocument(path)
        if (!existing) {
          report.failed.push({ path, error: 'Not found on disk.' })
          continue
        }

        if (existing.status === target) {
          report.changed.push({ path, slug: existing.slug, note: `Already ${target}.` })
          continue
        }

        const outcome = await writeChecked({ path, type: existing.type }, ({ known }) => {
          const data: Record<string, unknown> = { ...known }
          data.status = target
          if (target === 'published' && data.date === undefined && data.publishedAt === undefined) {
            data.date = todayIso()
          }
          // `draft: true` and an explicit status contradict each other; the
          // status the operator just chose wins.
          delete data.draft
          return { data, body: existing.body }
        })

        await afterWrite(
          outcome,
          existing.type,
          target === 'published' ? 'publish' : 'save',
          context.user.id,
        )

        await recordAudit({
          action: target === 'published' ? 'post.publish' : 'post.unpublish',
          actorId: context.user.id,
          targetType: 'content',
          targetId: path,
          metadata: { type: existing.type, slug: outcome.slug, status: target },
          request: context.request,
        })

        revalidateContentChange(existing.type, outcome.slug)
        report.changed.push({ path, slug: outcome.slug })
      } catch (error) {
        report.failed.push({ path, error: errorText(error) })
      }
    }

    return actionOk(report)
  } catch (error) {
    return describeActionError(error)
  }
}

/** Rewrite one document's `tags` list. Shared with the tag manager. */
async function addTagToDocument(
  path: string,
  tag: string,
  actorId: string,
): Promise<{ slug: string; type: ContentType; note?: string }> {
  const existing = await readDocument(path)
  if (!existing) throw new ContentWriteError('Document is not on disk', path)

  if (existing.tags.some((current) => current.toLowerCase() === tag.toLowerCase())) {
    return { slug: existing.slug, type: existing.type, note: 'Already tagged.' }
  }

  const outcome = await writeChecked({ path, type: existing.type }, ({ known }) => {
    const data: Record<string, unknown> = { ...known }
    data.tags = [...existing.tags, tag]
    return { data, body: existing.body }
  })

  await afterWrite(outcome, existing.type, 'save', actorId)

  await recordAudit({
    action: 'post.update',
    actorId,
    targetType: 'content',
    targetId: path,
    metadata: { type: existing.type, slug: outcome.slug, addedTag: tag },
  })

  return { slug: outcome.slug, type: existing.type }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
