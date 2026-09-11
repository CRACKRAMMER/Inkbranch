'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { RATE_LIMITS, consumeRateLimit } from '@/lib/auth/rate-limit'
import { UnauthorizedError } from '@/lib/auth/session'
import { guardAction, guardRead, parseActionInput } from '@/lib/admin/guard'
import { segmentForType } from '@/lib/admin/routes'
import { documentUrl } from '@/lib/content/paths'
import { CONTENT_TYPES, type ContentStatus, type ContentType } from '@/lib/content/schema'
import { syncOneDocument } from '@/lib/content/sync'
import {
  IMPORT_LIMITS,
  applyImport,
  collectExistingContent,
  collectUploadKeys,
  formatBytes,
  importReportLines,
  scanImportArchive,
  scanImportDirectory,
  scanImportFiles,
  type ImportAction,
  type ImportCounts,
  type ImportPlan,
  type ImportProblem,
  type ImportSourceKind,
} from '@/lib/content/import'

/**
 * The import screen's two phases, as one Server Action.
 *
 * `formData.get('intent')` decides which: `scan` builds a plan and returns the
 * report, `apply` builds the plan *again* from the same submitted source and
 * checks the fingerprint before writing anything.
 *
 * Rebuilding rather than caching the plan is the point, not an inefficiency. A
 * plan held in server memory between two requests is a plan that could be
 * applied to files that have since changed, and the operator would be confirming
 * a report that no longer describes what is about to happen. The fingerprint is
 * the plan's digest: if the second scan disagrees with the one the operator
 * looked at, the apply is refused and nothing is written.
 *
 * The scan is a read and uses `guardRead`; the apply mutates and uses
 * `guardAction`, which adds the CSRF check. Both go through
 * `requireActionContext()` underneath — no screen here is reachable without a
 * session.
 */

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

/** One file, as the report shows it. The body is deliberately not included. */
export interface ImportFileView {
  sourcePath: string
  targetPath: string
  type: ContentType
  typeSource: 'flag' | 'layout' | 'default'
  slug: string
  title: string
  status: ContentStatus
  action: ImportAction
  bytes: number
  wordCount: number
  readingTime: number
  problems: ImportProblem[]
}

export interface ImportReportView {
  kind: ImportSourceKind
  source: string
  fingerprint: string
  truncated: boolean
  counts: ImportCounts
  problems: ImportProblem[]
  files: ImportFileView[]
  /** The same plain-text summary the CLI prints, so the two cannot disagree. */
  lines: string[]
}

export interface ImportApplyView {
  created: number
  overwritten: number
  skipped: number
  failed: number
  rejected: number
  durationMs: number
  files: { targetPath: string; outcome: string; message?: string }[]
  /** Documents whose index row was refreshed after the write. */
  indexed: number
  /** Paths that were written but whose row could not be refreshed. */
  indexFailures: string[]
}

/** What the form renders. `ok` is the discriminant; everything else is optional. */
export interface ImportState {
  ok: boolean
  error?: string
  detail?: string
  fieldErrors?: Record<string, string>
  /** Set when the rate limiter refused the request; says how long to wait. */
  retryAfterSeconds?: number
  report?: ImportReportView
  applied?: ImportApplyView
}

const MAX_DIRECTORY_LENGTH = 4096

const importInputSchema = z.object({
  intent: z.enum(['scan', 'apply']),
  source: z.enum(['upload', 'directory']),
  /** Empty means "no directory"; the upload half of the form then supplies files. */
  directory: z
    .string()
    .trim()
    .max(MAX_DIRECTORY_LENGTH, `Keep the path under ${MAX_DIRECTORY_LENGTH} characters`)
    .optional(),
  type: z.enum(CONTENT_TYPES),
  overwrite: z.boolean(),
  titleFix: z.boolean(),
  /**
   * The digest of the plan the operator was shown. Required to apply, ignored
   * when scanning.
   */
  fingerprint: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, 'Not a plan fingerprint')
    .optional(),
})

type PlanInput = z.output<typeof importInputSchema>

/* -------------------------------------------------------------------------- */
/*  Action                                                                     */
/* -------------------------------------------------------------------------- */

export async function importAction(
  _previous: ImportState | undefined,
  formData: FormData,
): Promise<ImportState> {
  try {
    const intent = formData.get('intent') === 'apply' ? 'apply' : 'scan'

    // The scan reads files the server can reach; the apply writes into the
    // content tree. The second is the one a third-party page could try to
    // trigger, so it is the one that gets the CSRF check.
    const context = intent === 'apply' ? await guardAction() : await guardRead()

    const allowed = await consumeRateLimit(
      `import:user:${context.user.id}`,
      RATE_LIMITS.import,
    )
    if (!allowed.allowed) {
      const seconds = Math.ceil(allowed.retryAfterMs / 1000)
      return {
        ok: false,
        error: `Too many imports. Try again in ${formatSeconds(seconds)}.`,
        retryAfterSeconds: seconds,
      }
    }

    const raw = {
      intent,
      source: formData.get('source'),
      directory: stringField(formData, 'directory'),
      type: stringField(formData, 'type') ?? 'note',
      overwrite: formData.get('overwrite') === 'on',
      titleFix: formData.get('titleFix') === 'on',
      fingerprint: stringField(formData, 'fingerprint'),
    }

    const parsed = parseActionInput(importInputSchema, raw)
    if (!parsed.ok) return parsed
    const input = parsed.value

    if (input.intent === 'apply' && input.fingerprint === undefined) {
      return {
        ok: false,
        error: 'This report has no fingerprint, so it cannot be applied. Scan again.',
        detail: 'The plan is checked against the source before anything is written.',
      }
    }

    const scanned = await buildPlan(input, formData)
    if (!scanned.ok) return scanned
    const plan = scanned.plan

    if (input.intent === 'scan') {
      return { ok: true, report: toReportView(plan) }
    }

    if (plan.fingerprint !== input.fingerprint) {
      return {
        ok: false,
        error: 'The source changed while the report was on screen, so nothing was written.',
        detail: `It holds ${plan.entries.length} file${plan.entries.length === 1 ? '' : 's'} now. Scan again to see what would happen.`,
      }
    }

    const applied = await applyAndIndex(plan, { applyFixes: input.titleFix })

    await recordAudit({
      // `AUDIT_ACTIONS` has no `content.import`, and the closest action it does
      // have is what the writes amount to: documents were created. The metadata
      // carries the rest — how they arrived, and what was skipped or refused —
      // so the log does not read as if these were typed into the editor. Adding
      // `content.import` to that union belongs in `src/lib/audit.ts`, with the
      // other actions.
      action: 'post.create',
      actorId: context.user.id,
      targetType: 'content_import',
      targetId: plan.source.slice(0, 200),
      metadata: {
        via: 'admin.import',
        kind: plan.kind,
        type: input.type,
        create: applied.created,
        overwrite: applied.overwritten,
        skip: applied.skipped,
        reject: applied.rejected,
        failed: applied.failed,
        ...(applied.indexFailures.length > 0 ? { indexFailures: applied.indexFailures } : {}),
      },
      request: context.request,
    })

    revalidatePath('/admin')
    for (const type of new Set(plan.entries.map((entry) => entry.type))) {
      revalidatePath(`/admin/${segmentForType(type)}`)
    }
    for (const file of applied.files) {
      if (file.outcome !== 'created' && file.outcome !== 'overwritten') continue
      const entry = plan.entries.find((candidate) => candidate.targetPath === file.targetPath)
      if (entry) revalidatePath(documentUrl(entry.type, entry.slug))
    }

    const state: ImportState = { ok: applied.failed === 0, applied, report: toReportView(plan) }
    if (applied.failed > 0) {
      state.error = `${applied.failed} file${applied.failed === 1 ? '' : 's'} could not be written; the rest are in the content tree.`
      state.detail = 'The list below says which ones. Nothing was rolled back.'
    }
    return state
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { ok: false, error: 'Your session ended. Sign in again — nothing was imported.' }
    }
    return {
      ok: false,
      error: 'The import could not be completed, so nothing was written.',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/** A refusal that happened before a plan existed. Shaped like the action's state. */
interface PlanFailure {
  ok: false
  error: string
  detail?: string
  fieldErrors?: Record<string, string>
}

type PlanResult = { ok: true; plan: ImportPlan } | PlanFailure

async function buildPlan(input: PlanInput, formData: FormData): Promise<PlanResult> {
  const existing = await collectExistingContent()
  const images = await collectUploadKeys()

  const options = {
    type: input.type,
    existing: existing.slugs,
    knownTargets: existing.targets,
    knownImages: images,
    applyTitleFix: input.titleFix,
  }

  if (input.source === 'directory') {
    const directory = (input.directory ?? '').trim()
    if (directory.length === 0) {
      return {
        ok: false,
        error: 'Name the directory to scan.',
        fieldErrors: { directory: 'A server-side path is required.' },
      }
    }
    try {
      const plan = await scanImportDirectory(directory, {
        ...options,
        source: directory,
        // A directory is full of things that are not Markdown — images, PDFs, a
        // stray `.DS_Store`. Noting them is the point of scanning a directory;
        // calling each one an error would bury the files that are actually
        // broken. An *uploaded* non-Markdown file stays an error, below.
        nonMarkdownSeverity: 'info',
      })
      return { ok: true, plan }
    } catch (error) {
      // `ImportScanError` carries the reason the scan could not run at all,
      // which is different from a file inside it being invalid.
      return {
        ok: false,
        error: `Cannot scan ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        fieldErrors: { directory: 'This directory could not be read.' },
      }
    }
  }

  const uploads = formData
    .getAll('files')
    .filter((value): value is File => value instanceof File && value.name.length > 0)

  if (uploads.length === 0) {
    return {
      ok: false,
      error: 'Choose a Markdown file or a ZIP archive to import.',
      fieldErrors: { files: 'Nothing was submitted.' },
    }
  }

  let total = 0
  const files: { name: string; data: Buffer }[] = []
  for (const upload of uploads) {
    const data = Buffer.from(await upload.arrayBuffer())
    total += data.length
    if (data.length > IMPORT_LIMITS.maxFileBytes) {
      return {
        ok: false,
        error: `${upload.name} is ${formatBytes(data.length)}, over the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} per-file limit.`,
      }
    }
    files.push({ name: upload.name, data })
  }

  // One `.zip` is an archive; anything else is a set of documents. The extension
  // chooses the reader and nothing else — a file that is not really a ZIP fails
  // loudly inside `scanImportArchive`.
  const [first] = files
  if (files.length === 1 && first && /\.zip$/i.test(first.name)) {
    try {
      const plan = scanImportArchive(first.data, {
        ...options,
        source: first.name,
        overwrite: input.overwrite,
      })
      return { ok: true, plan }
    } catch (error) {
      return {
        ok: false,
        error: `${first.name} cannot be read as an archive: ${error instanceof Error ? error.message : String(error)}`,
        fieldErrors: { files: 'The archive was refused.' },
      }
    }
  }

  if (total > IMPORT_LIMITS.maxBatchBytes) {
    return {
      ok: false,
      error: `That is ${formatBytes(total)} of Markdown, over the ${formatBytes(IMPORT_LIMITS.maxBatchBytes)} batch limit.`,
    }
  }

  return {
    ok: true,
    plan: scanImportFiles(files, {
      ...options,
      source: `${files.length} uploaded file${files.length === 1 ? '' : 's'}`,
      overwrite: input.overwrite,
    }),
  }
}

function toReportView(plan: ImportPlan): ImportReportView {
  return {
    kind: plan.kind,
    source: plan.source,
    fingerprint: plan.fingerprint,
    truncated: plan.truncated,
    counts: plan.counts,
    problems: plan.problems,
    lines: importReportLines(plan),
    files: plan.entries.map((entry) => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      type: entry.type,
      typeSource: entry.typeSource,
      slug: entry.slug,
      title: entry.title,
      status: entry.status,
      action: entry.action,
      bytes: entry.bytes,
      wordCount: entry.wordCount,
      readingTime: entry.readingTime,
      problems: entry.problems,
    })),
  }
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write the plan, then index what was written.
 *
 * The engine writes files; it does not touch the database, which is a boundary
 * worth keeping — the importer knows about the content tree and nothing else.
 * The consequence is that the index is behind the moment the first file lands,
 * so every document that was written is synced here, one at a time, the same way
 * an admin save is. A file whose row could not be refreshed is reported rather
 * than passed over: it is on disk and invisible, which is exactly the state the
 * operator has to know about.
 */
async function applyAndIndex(
  plan: ImportPlan,
  options: { applyFixes: boolean },
): Promise<ImportApplyView> {
  const result = await applyImport(plan, { applyFixes: options.applyFixes })

  const written = result.files.filter(
    (file) => file.outcome === 'created' || file.outcome === 'overwritten',
  )

  const indexFailures: string[] = []
  let indexed = 0

  for (const file of written) {
    try {
      await syncOneDocument(file.targetPath)
      indexed += 1
    } catch (error) {
      indexFailures.push(
        `${file.targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (indexed > 0) {
    // The relations index is a per-process cache of the backlink graph. A
    // long-running server would otherwise serve backlinks that do not include
    // what was just imported. `pnpm content:sync` does the same for the CLI.
    const { invalidateRelationsIndex } = await import('@/lib/graph/relations')
    invalidateRelationsIndex()
  }

  return {
    created: result.created,
    overwritten: result.overwritten,
    skipped: result.skipped,
    failed: result.failed,
    rejected: result.rejected,
    durationMs: result.durationMs,
    files: result.files.map((file) => ({
      targetPath: file.targetPath,
      outcome: file.outcome,
      ...(file.message ? { message: file.message } : {}),
    })),
    indexed,
    indexFailures,
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function stringField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name)
  return typeof value === 'string' ? value : undefined
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`
}
