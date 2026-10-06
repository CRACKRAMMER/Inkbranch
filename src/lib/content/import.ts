import 'server-only'

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { env } from '@/env'
import {
  checkArchiveBudget,
  checkArchiveEntry,
  joinRuntimePath,
  type ArchiveLimits,
} from '@/lib/security/paths'
import { slugFromFilename, uniqueSlug } from '@/lib/utils/slug'
import { formatBytes } from '@/lib/utils/format'
import { deriveContent } from './derive'
import { FrontmatterError, parseFrontmatter, serializeFrontmatter } from './frontmatter'
import { extractLinks, wikiTargetCandidates } from './links'
import {
  CONTENT_TYPE_DIRS,
  DIR_TO_CONTENT_TYPE,
  buildRelativePath,
  isMarkdownFile,
  isReservedDir,
} from './paths'
import { checksumOf, readDocument, scanContentFiles } from './reader'
import {
  CONTENT_STATUSES,
  flexibleDate,
  frontmatterSchemaFor,
  normaliseFrontmatterKeys,
  splitFrontmatterKeys,
  type ContentStatus,
  type ContentType,
} from './schema'
import { importDocument } from './writer'

/**
 * Importing Markdown that was written somewhere else.
 *
 * ## Scan, report, confirm, apply
 *
 * The pipeline is four steps and the split between them is the whole contract:
 *
 * 1. **Scan** — read the source, parse, validate, and produce a plan. Nothing
 *    is written. `inspectImportEntries` is pure over its arguments, so the
 *    report a caller shows is exactly what the applier will do.
 * 2. **Report** — one entry per file, with problems and, for each problem, what
 *    to do about it.
 * 3. **Confirm** — the caller's explicit decision. There is no default that
 *    writes.
 * 4. **Apply** — `applyImport`, which writes only the entries the plan marks
 *    importable, and only through `importDocument` (atomic rename, lock,
 *    revision-friendly) so the rest of the content engine's guarantees hold.
 *
 * ## The source is never written to
 *
 * Not "is restored afterwards" — never opened for writing. A directory scan
 * only reads; an archive is read from the buffer it arrived in and is never
 * unpacked to disk; an upload lives in memory. The only files this module
 * creates are the destination copies under the content tree, and their paths
 * are derived from a *slug* that passed `assertSafeSlug`, never from a name the
 * caller supplied. That is why a ZIP entry called `../../etc/passwd` cannot
 * escape: not because it is normalised, but because its name never reaches a
 * path join. The name is screened anyway — refusing it is the only way to tell
 * the operator it was there — but the containment does not depend on the screen.
 *
 * ## A fix is a suggestion until it is confirmed
 *
 * `missing-title` is the one problem with an automatic fix, because a title is
 * the one field a document cannot be read without (for posts and projects). The
 * derived title is offered in the report and written into the destination copy
 * only when the caller asks for it; otherwise the entry is rejected, loudly,
 * with the suggestion attached.
 */

/* -------------------------------------------------------------------------- */
/*  Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Caps for one import batch. Named, because an unnamed cap is a magic number and
 * these are the numbers an operator has to be able to reason about when an
 * import refuses to run.
 *
 * The archive caps are far tighter than `DEFAULT_ARCHIVE_LIMITS` in
 * `@/lib/security/paths`, which is sized for media uploads: a batch of Markdown
 * is a few hundred small text files, and 512 MiB of decompressed text is not a
 * content import, it is an attack. Every one of them is enforced before the
 * entry is read, and the byte total is enforced again against the *actual*
 * decompressed size — an archive header can simply lie.
 */
export const IMPORT_LIMITS = {
  /** Files one batch may contain. A directory scan truncates here; an archive is refused. */
  maxFiles: 1_000,
  /** Bytes one Markdown file may have. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Total bytes one batch may produce. */
  maxBatchBytes: 32 * 1024 * 1024,
  /** Bytes an uploaded archive may occupy as received. */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** Entries one archive may declare. */
  maxArchiveEntries: 500,
  /** Bytes one archive may expand to. */
  maxArchiveUncompressedBytes: 32 * 1024 * 1024,
  /** Decompressed-to-compressed ratio ceiling, which is what catches a zip bomb. */
  maxArchiveRatio: 100,
  /** Length of a reported source path. */
  maxPathLength: 512,
  /** Segments in a reported source path. */
  maxPathDepth: 8,
} as const

const ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: IMPORT_LIMITS.maxArchiveEntries,
  maxTotalBytes: IMPORT_LIMITS.maxArchiveUncompressedBytes,
  maxRatio: IMPORT_LIMITS.maxArchiveRatio,
}

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export type ImportSourceKind = 'files' | 'archive' | 'directory'

/** What will happen to an entry when the plan is applied. */
export type ImportAction = 'create' | 'overwrite' | 'skip' | 'reject'

/**
 * `error` means the file cannot be imported as it stands; `warning` means it
 * will be imported but something about it deserves a decision; `info` is a
 * statement of fact with nothing to fix.
 */
export type ImportSeverity = 'error' | 'warning' | 'info'

export type ImportProblemCode =
  | 'missing-title'
  | 'missing-date'
  | 'invalid-date'
  | 'missing-description'
  | 'invalid-frontmatter'
  | 'invalid-schema'
  | 'unknown-frontmatter-key'
  | 'invalid-slug'
  | 'unsupported-extension'
  | 'invalid-encoding'
  | 'empty-file'
  | 'oversized-file'
  | 'batch-too-large'
  | 'too-many-files'
  | 'path-traversal'
  | 'absolute-path'
  | 'unsupported-entry'
  | 'unsupported-compression'
  | 'unreadable'
  | 'duplicate-slug'
  | 'slug-conflict'
  | 'broken-link'
  | 'broken-image'

/** One problem with one file, and what to do about it. */
export interface ImportProblem {
  code: ImportProblemCode
  severity: ImportSeverity
  message: string
  /** The fix, written for the person who has to make it. */
  suggestion: string
  /** 1-based line in the source file, when the problem has one. */
  line?: number
  /** Source path, for batch-level problems that name a file. */
  path?: string
}

export interface ImportEntryInput {
  /**
   * The name the source gave this entry — a ZIP entry name, an upload's
   * filename, or a path relative to a scan root. Untrusted in every case.
   */
  sourcePath: string
  /** Raw bytes, or null when the entry could not be read at all. */
  bytes: Buffer | null
  /** Problems found before the bytes were read, carried through to the report. */
  problems?: readonly ImportProblem[]
  /** The type the source layout names, if it names one. */
  inferredType?: ContentType | null
}

export interface ImportInspectOptions {
  /** Type for entries whose source layout does not name one. */
  type: ContentType
  /**
   * When true, `type` wins for every entry and the source layout is ignored.
   * The CLI sets it when `--type` was given explicitly.
   */
  forceType?: boolean
  /**
   * Documents already in the content tree, as `${dir}/${slug}` keys — the same
   * keys `content_index` is unique on. An entry whose key is in here is reported
   * as a conflict.
   */
  existing?: ReadonlySet<string>
  /**
   * Targets (`posts/foo`, on both the slug and the filename) that resolve.
   *
   * Link checking is *off* unless this is supplied — pass an empty set to check
   * against the batch alone. Reporting every internal link as broken because the
   * caller had no index to hand would be worse than saying nothing, and would
   * teach the operator to ignore the report.
   */
  knownTargets?: ReadonlySet<string>
  /** Upload keys (`2026/09/diagram.webp`) that exist. Skips image checking when absent. */
  knownImages?: ReadonlySet<string>
  /** Write the derived title into the destination copy, which makes a title-less post importable. */
  applyTitleFix?: boolean
  /** Severity for a non-Markdown file. `info` for a directory scan, `error` for a chosen file. */
  nonMarkdownSeverity?: Extract<ImportSeverity, 'error' | 'info'>
  maxFiles?: number
  maxBatchBytes?: number
}

export interface ImportScanOptions extends ImportInspectOptions {
  /** Describes the source in the report. */
  source?: string
  /**
   * Replace an existing document instead of reporting it as skipped.
   *
   * Part of the shared options rather than of one scanner's signature: it was
   * once on two of the three, which is how `--scan-dir --overwrite` came to
   * accept the flag and silently skip every conflict anyway.
   */
  overwrite?: boolean
}

/** Fixes the importer can apply, offered in the report before anything is written. */
export interface ImportFix {
  title?: string
}

export interface ImportCandidate {
  /** Where the bytes came from. Reported, never used to build a path. */
  sourcePath: string
  /** Destination inside the content tree, e.g. `posts/linux-notes.md`. */
  targetPath: string
  type: ContentType
  /** `flag`, `layout` or `default` — where `type` came from. */
  typeSource: 'flag' | 'layout' | 'default'
  slug: string
  title: string
  status: ContentStatus
  description: string
  wordCount: number
  readingTime: number
  /** Bytes of the source file. */
  bytes: number
  checksum: string
  action: ImportAction
  problems: ImportProblem[]
  /** Empty unless something can be fixed. */
  fixes: ImportFix
  /** The file's exact contents, decoded. Written verbatim unless a fix is applied. */
  content: string
}

export interface ImportCounts {
  scanned: number
  create: number
  overwrite: number
  skip: number
  reject: number
  /** Entries carrying at least one `error`. */
  errors: number
  /** Entries carrying at least one `warning` and no error. */
  warnings: number
  /** Problems by code, across every entry and the batch itself. */
  byCode: Partial<Record<ImportProblemCode, number>>
  byType: Record<ContentType, number>
  byStatus: Record<ContentStatus, number>
  words: number
  readingTime: number
}

export interface ImportPlan {
  kind: ImportSourceKind
  source: string
  entries: ImportCandidate[]
  /** Problems about the batch rather than about one file — caps, unreadable entries. */
  problems: ImportProblem[]
  /**
   * Digest of every decision in the plan. A caller computes it before showing
   * the report and passes it back at confirm time; if the source changed in
   * between, the two disagree and the apply is refused rather than performed
   * against a plan the operator never saw.
   */
  fingerprint: string
  counts: ImportCounts
  /** True when a scan bound stopped the walk early. */
  truncated: boolean
}

export interface ImportWrittenFile {
  sourcePath: string
  targetPath: string
  outcome: 'created' | 'overwritten' | 'skipped' | 'failed'
  checksum: string
  message?: string
  recoveryPath?: string
}

export type ImportEvent =
  | { kind: 'created' | 'overwritten'; sourcePath: string; targetPath: string }
  | { kind: 'skipped'; sourcePath: string; targetPath: string; reason: string }
  | { kind: 'failed'; sourcePath: string; targetPath: string; message: string }

/**
 * A file that landed, with everything a caller needs to follow it up.
 *
 * Handed to `ImportApplyOptions.afterWrite`. It carries the previous contents
 * and the written text because the file on disk is only half of an import — the
 * index is derived from it and the revision of what it replaced is not derivable
 * from anything — and both of those are the caller's business rather than this
 * module's. See `ImportApplyOptions.afterWrite`.
 */
export interface ImportWrite {
  sourcePath: string
  targetPath: string
  type: ContentType
  slug: string
  outcome: 'created' | 'overwritten'
  /** The text that was written. */
  content: string
  /** The text it replaced, or null when the file is new. */
  previousContent: string | null
  recoveryPath?: string
}

export interface ImportApplyOptions {
  /** Preserve previous bytes for a caller that records revisions after writing. */
  preservePrevious?: boolean
  /** Write the suggested fixes into the destination copies. */
  applyFixes?: boolean
  onEvent?: (event: ImportEvent) => void
  /**
   * Called after each file lands, before the next one is read.
   *
   * The importer writes files and touches no database — a boundary worth
   * keeping, because the engine knows about the content tree and nothing else.
   * The consequence is that a caller who needs the index to follow, or the
   * previous contents of an overwritten document to be kept, has to do that
   * themselves; this is where.
   *
   * A rejection is collected into `afterWriteFailures` and the batch carries on.
   * The file is on disk either way, and stopping would leave the operator with
   * neither the import nor a list of what landed — which is the same reason a
   * failed write does not stop it.
   */
  afterWrite?: (write: ImportWrite) => Promise<void>
}

export interface ImportApplyResult {
  created: number
  overwritten: number
  skipped: number
  failed: number
  rejected: number
  files: ImportWrittenFile[]
  /**
   * What `afterWrite` reported, one message per failure.
   *
   * Separate from `failed` because the files in question were written: counting
   * them as failures would say a document did not land when it did, and saying
   * nothing would hide that nothing indexes it.
   */
  afterWriteFailures: string[]
  durationMs: number
}

export type ImportScanErrorCode =
  | 'not-a-directory'
  | 'unreadable'
  | 'archive-unreadable'
  | 'archive-unsupported'
  | 'archive-too-large'
  | 'archive-too-many-entries'
  | 'archive-bomb'

export class ImportScanError extends Error {
  readonly code: ImportScanErrorCode
  readonly source: string

  constructor(code: ImportScanErrorCode, message: string, source: string) {
    super(message)
    this.name = 'ImportScanError'
    this.code = code
    this.source = source
  }
}

/* -------------------------------------------------------------------------- */
/*  Report vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What each problem is called in a summary line. Phrased as the thing that is
 * wrong with the batch — "5 missing descriptions" — because that is the shape
 * the report in `project.md` asks for.
 */
export const PROBLEM_LABELS: Record<ImportProblemCode, string> = {
  'missing-title': 'missing titles',
  'missing-date': 'missing dates',
  'invalid-date': 'unreadable dates',
  'missing-description': 'missing descriptions',
  'invalid-frontmatter': 'unparsable frontmatter',
  'invalid-schema': 'invalid frontmatter',
  'unknown-frontmatter-key': 'unknown frontmatter keys',
  'invalid-slug': 'unusable slugs',
  'unsupported-extension': 'files that are not Markdown',
  'invalid-encoding': 'files that are not UTF-8',
  'empty-file': 'empty files',
  'oversized-file': 'oversized files',
  'batch-too-large': 'batch size',
  'too-many-files': 'file count',
  'path-traversal': 'paths that escape the destination',
  'absolute-path': 'absolute paths',
  'unsupported-entry': 'unsupported archive entries',
  'unsupported-compression': 'unsupported compression',
  unreadable: 'unreadable files',
  'duplicate-slug': 'duplicate slugs',
  'slug-conflict': 'slugs that are already in use',
  'broken-link': 'broken internal links',
  'broken-image': 'broken images',
}

/**
 * The same names for a count of one, so a single problem does not read as
 * "1 absolute paths". A separate table rather than a rule that trims an "s",
 * because the labels are phrases: "files that are not Markdown" has no singular
 * that trimming would find.
 */
const PROBLEM_LABELS_ONE: Record<ImportProblemCode, string> = {
  'missing-title': 'missing title',
  'missing-date': 'missing date',
  'invalid-date': 'unreadable date',
  'missing-description': 'missing description',
  'invalid-frontmatter': 'unparsable frontmatter',
  'invalid-schema': 'invalid frontmatter',
  'unknown-frontmatter-key': 'unknown frontmatter key',
  'invalid-slug': 'unusable slug',
  'unsupported-extension': 'file that is not Markdown',
  'invalid-encoding': 'file that is not UTF-8',
  'empty-file': 'empty file',
  'oversized-file': 'oversized file',
  'batch-too-large': 'batch size',
  'too-many-files': 'file count',
  'path-traversal': 'path that escapes the destination',
  'absolute-path': 'absolute path',
  'unsupported-entry': 'unsupported archive entry',
  'unsupported-compression': 'unsupported compression',
  unreadable: 'unreadable file',
  'duplicate-slug': 'duplicate slug',
  'slug-conflict': 'slug that is already in use',
  'broken-link': 'broken internal link',
  'broken-image': 'broken image',
}

const SEVERITY_RANK: Record<ImportSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
}

/* -------------------------------------------------------------------------- */
/*  Inspection (pure over its arguments)                                       */
/* -------------------------------------------------------------------------- */

/** Strips a BOM, and fails on any byte sequence that is not valid UTF-8. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return UTF8.decode(bytes)
  } catch {
    // A lone surrogate or a truncated multi-byte sequence. Decoding it with
    // replacement characters would write U+FFFD into the article.
    return null
  }
}

/**
 * Classify a source path for reporting.
 *
 * The *decision* to reject belongs to `checkArchiveEntry` in
 * `@/lib/security/paths`, which is the one place the containment rules live.
 * This only says which of them tripped, so the report can name the problem
 * rather than quoting a screen that returns a bare boolean.
 */
function classifyPath(sourcePath: string): {
  code: ImportProblemCode
  message: string
} {
  const name = sourcePath.replace(/\\/g, '/')
  if (name.startsWith('/')) {
    return {
      code: 'absolute-path',
      message: `“${sourcePath}” is an absolute path`,
    }
  }
  if (/^[a-zA-Z]:/.test(name)) {
    return {
      code: 'absolute-path',
      message: `“${sourcePath}” is a drive-letter path`,
    }
  }
  if (name.split('/').includes('..')) {
    return {
      code: 'path-traversal',
      message: `“${sourcePath}” climbs out of its directory with “..”`,
    }
  }
  return {
    code: 'unsupported-entry',
    message: `“${sourcePath}” is not a usable file name`,
  }
}

function pathProblem(sourcePath: string): ImportProblem | null {
  if (!sourcePath) {
    return {
      code: 'unsupported-entry',
      severity: 'error',
      message: 'The entry has no name',
      suggestion: 'Nothing to import. Remove the entry from the source.',
    }
  }

  const check = checkArchiveEntry(sourcePath)
  if (!check.ok) {
    const { code, message } = classifyPath(sourcePath)
    return {
      code,
      severity: 'error',
      // The screen's own reason is carried along: it is the archive-specific
      // half of the answer ("parent traversal"), and this problem is the only
      // one the caller will see for this entry.
      message: `${message} (${check.reason})`,
      suggestion:
        'Import only files that sit inside the archive, by a relative path with no “..”. ' +
        'Nothing was read and nothing was written for this entry.',
    }
  }

  const segments = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (sourcePath.length > IMPORT_LIMITS.maxPathLength || segments.length > IMPORT_LIMITS.maxPathDepth) {
    return {
      code: 'unsupported-entry',
      severity: 'error',
      message: `“${truncatePath(sourcePath)}” is nested too deeply to import`,
      suggestion: `Flatten the directory to at most ${IMPORT_LIMITS.maxPathDepth} levels and re-run.`,
    }
  }

  return null
}

function truncatePath(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value
}

/** The file's name without its directory or extension, which is what `deriveContent` takes. */
function stemOf(sourcePath: string): string {
  return path
    .basename(sourcePath.replace(/\\/g, '/'))
    .replace(/\.(md|markdown|mdx)$/i, '')
}

function basenameOf(sourcePath: string): string {
  return path.basename(sourcePath.replace(/\\/g, '/'))
}

/**
 * 1-based line of a frontmatter key, for a report that points at a place in the
 * file. The YAML parser discards positions, so the raw text is searched instead
 * — the key is either on a line of its own or nested under one, and the first
 * match inside the block is the one a reader will find.
 */
function frontmatterKeyLine(raw: string, key: string): number | undefined {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && (lines[start] ?? '').trim() === '') start += 1
  const opener = (lines[start] ?? '').trim()
  if (opener !== '---' && opener !== '+++') return undefined

  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---' || line.trim() === '...' || line.trim() === '+++') break
    if (pattern.test(line)) return i + 1
  }
  return undefined
}

/**
 * How many file lines precede the body.
 *
 * `extractLinks` numbers the lines of the string it is given — the body — while
 * a report has to name a line of the *file*, or the operator opens the file,
 * goes to line 6, and finds the closing fence. The body is a slice of the
 * source, so counting the newlines before it is exact.
 */
function bodyLineOffset(source: string, body: string): number {
  const index = source.indexOf(body)
  if (index <= 0) return 0
  return (source.slice(0, index).match(/\n/g) ?? []).length
}

/** First line of the frontmatter block, used when YAML itself is broken. */
function frontmatterStartLine(raw: string): number {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '') return i + 1
  }
  return 1
}

/** Keys that name the moment a document goes live. */
const PUBLISH_DATE_KEYS = ['date', 'publishedAt', 'publishAt'] as const
const DATE_KEYS = [...PUBLISH_DATE_KEYS, 'updated'] as const

interface FrontmatterInspection {
  problems: ImportProblem[]
  data: Record<string, unknown>
  extra: Record<string, unknown>
  body: string
  title: string
  slug: string
  description: string
  status: ContentStatus
  wordCount: number
  readingTime: number
  hasTitle: boolean
  /** Lines of the file that sit above the body, so a link's line is the file's line. */
  bodyLineOffset: number
}

function inspectFrontmatter(
  raw: string,
  type: ContentType,
  filename: string,
  options: ImportInspectOptions,
): FrontmatterInspection {
  const problems: ImportProblem[] = []

  let parsed: ReturnType<typeof parseFrontmatter>
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    problems.push({
      code: 'invalid-frontmatter',
      severity: 'error',
      message:
        error instanceof FrontmatterError
          ? error.message
          : `The frontmatter cannot be parsed: ${String(error)}`,
      suggestion:
        'Fix the YAML between the opening and closing “---” fences, or delete the block and let the importer derive the metadata.',
      line: frontmatterStartLine(raw),
    })
    return {
      problems,
      data: {},
      extra: {},
      body: raw,
      title: deriveContent({ type, filename, body: raw }).title,
      slug: slugFromFilename(filename),
      description: '',
      status: 'draft',
      wordCount: 0,
      readingTime: 0,
      hasTitle: false,
      bodyLineOffset: 0,
    }
  }

  const normalised = normaliseFrontmatterKeys(parsed.data)
  const { known, extra } = splitFrontmatterKeys(normalised)

  for (const key of Object.keys(extra)) {
    problems.push({
      code: 'unknown-frontmatter-key',
      severity: 'info',
      message: `Unknown frontmatter key “${key}”`,
      suggestion:
        'Leave it alone if another tool needs it — unknown keys are preserved verbatim — ' +
        'or delete it if it was a typo.',
      line: frontmatterKeyLine(raw, key),
    })
  }

  // The raw values, so a date the schema could not read is reported as a bad
  // date rather than as "no date at all" — by the time the schema is done, an
  // unreadable value and an absent one both look like `undefined`.
  const declaredDates = DATE_KEYS.map((key) => ({
    key,
    value: parsed.data[key],
  })).filter((entry) => entry.value !== undefined && entry.value !== null)

  const result = frontmatterSchemaFor(type).safeParse(known)
  const declaredTitle = typeof known.title === 'string' ? known.title.trim() : ''

  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.')
      // Zod's message for a required field that is absent says nothing about
      // the field — "Invalid input: expected string, received undefined" — so
      // the path and the raw input decide, not the wording.
      const missingTitle = key === 'title' && !declaredTitle
      // Reported once, by the block below, which knows about notes and about the
      // derived title. Reporting it here as well would double every title-less
      // post in the count and give the operator two different suggestions.
      if (missingTitle) continue

      problems.push({
        code: 'invalid-schema',
        severity: 'error',
        message: `Invalid frontmatter${key ? ` at “${key}”` : ''}: ${issue.message}`,
        suggestion: `Fix “${key || 'the frontmatter'}” in the source file. The message above is the schema's own.`,
        ...(key ? { line: frontmatterKeyLine(raw, key) } : {}),
      })
    }
  }

  const data = (result.success ? result.data : {}) as Record<string, unknown>

  // A date the schema could not read: present in the file, absent from the
  // result. Checked against `flexibleDate` directly rather than against the
  // parsed output, so it is still reported when the schema refused the file for
  // some other reason.
  for (const declared of declaredDates) {
    if (flexibleDate.safeParse(declared.value).success) continue
    problems.push({
      code: 'invalid-date',
      severity: 'warning',
      message: `“${declared.key}: ${String(declared.value)}” is not a date this site can read`,
      suggestion:
        'Write the date as `YYYY-MM-DD` (or a full ISO timestamp). As it stands the value is ' +
        'ignored and the file is imported as a draft.',
      line: frontmatterKeyLine(raw, declared.key),
    })
  }

  const derived = deriveContent({
    type,
    filename,
    body: parsed.content,
    title: declaredTitle || undefined,
    slug: typeof known.slug === 'string' ? known.slug : undefined,
    description: typeof known.description === 'string' ? known.description : undefined,
  })

  if (!declaredTitle) {
    const fixed = Boolean(options.applyTitleFix && derived.title)
    const titleLine = frontmatterKeyLine(raw, 'title')
    problems.push({
      code: 'missing-title',
      severity: type === 'note' ? 'info' : fixed ? 'warning' : 'error',
      message:
        type === 'note'
          ? `No “title”: the note is titled “${derived.title}”, taken from its content`
          : fixed
            ? `No “title”: it will be written into the imported copy as “${derived.title}”`
            : 'No “title” in the frontmatter',
      suggestion:
        type === 'note'
          ? 'Nothing to do. Notes may go without a title; add one to change how it reads in lists.'
          : fixed
            ? 'The source file is not modified. Only the copy in the content tree gets the title.'
            : 'Add “title: …” to the source file, or re-run with the title fix enabled to derive it from the first heading.',
      ...(titleLine ? { line: titleLine } : {}),
    })
  }

  if (result.success && data.status === 'draft' && declaredDates.length === 0) {
    problems.push({
      code: 'missing-date',
      severity: 'warning',
      message: 'No “date”, so the file will be imported as a draft',
      suggestion:
        'Add `date: YYYY-MM-DD` to publish it, or leave it undated and publish it from the admin later.',
    })
  }

  // The *declared* description, not the derived one. `deriveContent` falls back
  // to the first paragraph, so nearly every file has one by the time the
  // document is built — and the report would then say nothing about the files
  // that a reader sees an auto-excerpt on. "5 missing descriptions" in the
  // import report means five files whose author did not write one.
  const declaredDescription =
    typeof known.description === 'string' ? known.description.trim() : ''
  const declaredSummary = typeof known.summary === 'string' ? known.summary.trim() : ''

  if (!declaredDescription && !declaredSummary) {
    problems.push({
      code: 'missing-description',
      severity: 'warning',
      message: 'No “description” in the frontmatter',
      suggestion:
        'Add one — it becomes the excerpt in lists, the search result and the social card. ' +
        'Without it the first paragraph of the body is used.',
    })
  }

  // The resolution the schema itself performs — explicit status, then the date,
  // then draft — repeated here so that a file the schema refused is still
  // described by what it meant to be. An entry the report calls "draft" while
  // the imported copy lands published would be a lie in a report whose whole job
  // is to say what will happen.
  const datedForPublish = PUBLISH_DATE_KEYS.some((key) =>
    flexibleDate.safeParse(parsed.data[key]).success,
  )
  const declaredStatus = CONTENT_STATUSES.find((candidate) => candidate === known.status)
  const status: ContentStatus =
    (data.status as ContentStatus | undefined) ??
    declaredStatus ??
    (datedForPublish ? 'published' : 'draft')

  return {
    problems,
    data: known,
    extra,
    body: parsed.content,
    title: derived.title,
    slug: derived.slug,
    description: derived.description,
    status,
    wordCount: derived.wordCount,
    readingTime: derived.readingTime,
    hasTitle: Boolean(declaredTitle),
    bodyLineOffset: bodyLineOffset(raw, parsed.content),
  }
}

/**
 * Report the links in a file that point at nothing.
 *
 * Both kinds of check are skipped when the caller supplied no index to check
 * against. Guessing would be worse than silence: a batch of ten articles that
 * link to each other is normal, and calling those links broken because the
 * caller did not pass `knownTargets` would train the operator to ignore the
 * report.
 */
function inspectLinks(
  body: string,
  targets: ReadonlySet<string>,
  images: ReadonlySet<string> | undefined,
  options: { checkTargets: boolean; lineOffset: number },
): ImportProblem[] {
  const problems: ImportProblem[] = []
  const { checkTargets, lineOffset } = options
  if (!checkTargets && images === undefined) return problems

  const { links } = extractLinks(body, {
    uploadUrlPrefix: env.UPLOAD_URL_PREFIX,
    siteUrl: env.SITE_URL,
  })

  const line = (link: { line: number }): number => link.line + lineOffset

  for (const link of links) {
    if (link.kind === 'internal') {
      if (checkTargets && !targets.has(link.targetKey)) {
        problems.push({
          code: 'broken-link',
          severity: 'warning',
          message: `“${link.href}” points at a document that does not exist`,
          suggestion: `Import the target as well, or correct the link to one of the documents that do exist.`,
          line: line(link),
        })
      }
      continue
    }

    if (link.kind === 'wiki') {
      if (!checkTargets) continue
      const resolved = wikiTargetCandidates(link.targetKey).some((key) =>
        targets.has(key),
      )
      if (!resolved) {
        problems.push({
          code: 'broken-link',
          severity: 'warning',
          message: `[[${link.targetKey}]] does not resolve to a document`,
          suggestion:
            'Check the spelling, or write the target as `posts/slug` so it cannot be ambiguous.',
          line: line(link),
        })
      }
      continue
    }

    if (link.kind === 'image' && images !== undefined && !images.has(link.targetKey)) {
      problems.push({
        code: 'broken-image',
        severity: 'warning',
        message: `Image “${link.href}” is not in the upload directory`,
        suggestion: `Upload the file to ${env.UPLOAD_URL_PREFIX}/${link.targetKey} before publishing, or fix the path.`,
        line: line(link),
      })
    }
  }

  return problems
}

function sortProblems(problems: ImportProblem[]): ImportProblem[] {
  return [...problems].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.code.localeCompare(b.code),
  )
}

function worstSeverity(problems: readonly ImportProblem[]): ImportSeverity | null {
  let worst: ImportSeverity | null = null
  for (const problem of problems) {
    if (worst === null || SEVERITY_RANK[problem.severity] < SEVERITY_RANK[worst]) {
      worst = problem.severity
    }
  }
  return worst
}

/**
 * Turn raw entries into candidates.
 *
 * Pure: nothing here touches the filesystem, so the same list of entries always
 * produces the same plan, which is what makes "show the report, then apply"
 * honest — the applier works from a plan the operator has seen.
 *
 * Entries are sorted by source path first. A duplicate slug has to be resolved
 * by renaming *one* of the two, and "whichever the archive happened to list
 * first" is not a decision anyone can rely on.
 */
export function inspectImportEntries(
  entries: readonly ImportEntryInput[],
  options: ImportInspectOptions,
): ImportCandidate[] {
  const maxFiles = options.maxFiles ?? IMPORT_LIMITS.maxFiles
  const maxBatchBytes = options.maxBatchBytes ?? IMPORT_LIMITS.maxBatchBytes
  const nonMarkdownSeverity = options.nonMarkdownSeverity ?? 'error'

  const ordered = [...entries].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))

  /** Slugs already claimed inside this batch, per type. */
  const claimed = new Map<ContentType, Set<string>>()
  const claimedFor = (type: ContentType): Set<string> => {
    const existing = claimed.get(type)
    if (existing) return existing
    const created = new Set<string>()
    claimed.set(type, created)
    return created
  }

  const candidates: ImportCandidate[] = []
  /**
   * What the second link pass needs from each candidate, matching `candidates`
   * index for index. Links are checked after the whole batch has been inspected
   * because a link in the first file may point at the tenth, and only then is
   * the set of targets the batch itself supplies complete. The parsed body is
   * carried over so that pass does not have to read any file twice.
   */
  const linkInputs: (LinkInput | null)[] = []
  const reject = (entry: ImportEntryInput, problems: ImportProblem[]): void => {
    candidates.push(rejectedCandidate(entry, options, problems))
    linkInputs.push(null)
  }
  let totalBytes = 0
  let seenFiles = 0

  for (const entry of ordered) {
    const problems: ImportProblem[] = [...(entry.problems ?? [])]

    if (seenFiles >= maxFiles) {
      problems.push({
        code: 'too-many-files',
        severity: 'error',
        message: `More than ${maxFiles} files; this one was not read`,
        suggestion: `Raise the file cap or split the import into batches of ${maxFiles}.`,
      })
      reject(entry, problems)
      continue
    }
    seenFiles += 1

    const pathIssue = pathProblem(entry.sourcePath)
    if (pathIssue) {
      problems.push(pathIssue)
      reject(entry, problems)
      continue
    }

    const bytes = entry.bytes
    if (bytes === null) {
      if (problems.length === 0) {
        problems.push({
          code: 'unreadable',
          severity: 'error',
          message: 'The file could not be read',
          suggestion: 'Check that the file exists and is readable, then re-run the scan.',
        })
      }
      reject(entry, problems)
      continue
    }

    if (bytes.length === 0) {
      problems.push({
        code: 'empty-file',
        severity: 'error',
        message: 'The file is empty',
        suggestion: 'Delete it, or give it a body and a frontmatter block.',
      })
      reject(entry, problems)
      continue
    }

    if (bytes.length > IMPORT_LIMITS.maxFileBytes) {
      problems.push({
        code: 'oversized-file',
        severity: 'error',
        message: `The file is ${formatBytes(bytes.length)}, over the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} limit`,
        suggestion: 'Split the document, or raise the limit if the size is genuinely a long article.',
      })
      reject(entry, problems)
      continue
    }

    if (totalBytes + bytes.length > maxBatchBytes) {
      problems.push({
        code: 'batch-too-large',
        severity: 'error',
        message: `This batch would exceed ${formatBytes(maxBatchBytes)}`,
        suggestion: 'Import in smaller batches. Nothing was written for this file.',
      })
      reject(entry, problems)
      continue
    }
    totalBytes += bytes.length

    const filename = stemOf(entry.sourcePath)

    if (!isMarkdownFile(entry.sourcePath)) {
      problems.push({
        code: 'unsupported-extension',
        severity: nonMarkdownSeverity,
        message: `“${basenameOf(entry.sourcePath)}” is not a Markdown file`,
        suggestion: `Only ${MARKDOWN_LABEL} are imported; upload images and other media through the asset manager.`,
      })
      reject(entry, problems)
      continue
    }

    const content = decodeUtf8(bytes)
    if (content === null) {
      problems.push({
        code: 'invalid-encoding',
        severity: 'error',
        message: 'The file is not valid UTF-8',
        suggestion:
          'Re-save it as UTF-8. Importing it as-is would write replacement characters into the article.',
      })
      reject(entry, problems)
      continue
    }

    const type = resolveType(entry, options)

    const inspected = inspectFrontmatter(content, type, filename, options)
    problems.push(...inspected.problems)

    const slugProblem = checkSlug(inspected.slug || slugFromFilename(filename))
    const baseSlug = slugProblem ? slugFromFilename(filename) : inspected.slug || slugFromFilename(filename)

    // Within the batch, two files claiming one slug is a real collision: they
    // would be one file at the destination. Both are kept — the later one under
    // a numbered slug — because dropping a document to resolve a name clash
    // loses writing, which is the one outcome an importer must never produce.
    const taken = claimedFor(type)
    let slug = baseSlug
    if (taken.has(slug)) {
      const renamed = uniqueSlug(slug, taken)
      problems.push({
        code: 'duplicate-slug',
        severity: 'warning',
        message: `Another file in this batch already claims the slug “${slug}”`,
        suggestion:
          `This one is imported as “${renamed}”. Give the source file a distinct name, ` +
          'or set “slug:” in its frontmatter, to choose the URL yourself.',
      })
      slug = renamed
    }
    taken.add(slug)

    if (slugProblem) problems.push(slugProblem)

    const targetPath = buildRelativePath(type, slug)
    const existing = options.existing?.has(`${CONTENT_DIR_OF[type]}/${slug}`) ?? false

    if (existing) {
      problems.push({
        code: 'slug-conflict',
        severity: 'warning',
        message: `A document already exists at ${targetPath}`,
        suggestion: `Re-run with overwrite to replace it, or rename the source file so both can exist.`,
      })
    }

    const sorted = sortProblems(problems)
    // A conflict with a document that is already there is *not* settled here:
    // replacing or skipping is the caller's decision, and `buildImportPlan`
    // makes it from the overwrite flag. Everything else that is importable is a
    // create.
    const action: ImportAction = worstSeverity(sorted) === 'error' ? 'reject' : 'create'

    candidates.push({
      sourcePath: entry.sourcePath,
      targetPath,
      type,
      typeSource: typeSourceOf(entry, options),
      slug,
      title: inspected.title,
      status: inspected.status,
      description: inspected.description,
      wordCount: inspected.wordCount,
      readingTime: inspected.readingTime,
      bytes: bytes.length,
      checksum: checksumOf(bytes),
      action,
      problems: sorted,
      fixes: options.applyTitleFix && !inspected.hasTitle && inspected.title
        ? { title: inspected.title }
        : {},
      content,
    })

    linkInputs.push({ body: inspected.body, lineOffset: inspected.bodyLineOffset })
  }

  return withLinkProblems(candidates, linkInputs, options)
}

/** A parsed body carried from the first pass to the link pass. */
interface LinkInput {
  body: string
  lineOffset: number
}

/**
 * Check the batch's links, now that every file in it has been seen.
 *
 * Runs as a separate pass rather than inside the loop above because a link can
 * point at any other file in the same batch — the tenth file's slug is not known
 * while the first is being inspected, and a link to it would be reported broken
 * on every import that is larger than one file.
 *
 * The set of targets the batch supplies is the *whole* batch, not the file being
 * checked: importing ten cross-referencing articles is the ordinary case, and
 * flagging the eight links that stay inside the batch would make the report
 * useless for the two that do not. Documents already in the tree are not counted
 * here — the caller passes those as `knownTargets`, and when it passes none at
 * all, link checking is off entirely (see `ImportInspectOptions.knownTargets`).
 *
 * Link problems are warnings and are appended after the first pass, so a
 * candidate's action never changes because of one.
 */
function withLinkProblems(
  candidates: ImportCandidate[],
  linkInputs: readonly (LinkInput | null)[],
  options: ImportInspectOptions,
): ImportCandidate[] {
  const checkTargets = options.knownTargets !== undefined
  if (!checkTargets && options.knownImages === undefined) return candidates

  const batchTargets = new Set<string>(options.knownTargets ?? [])
  if (checkTargets) {
    for (const candidate of candidates) {
      if (candidate.action === 'reject') continue
      batchTargets.add(`${CONTENT_DIR_OF[candidate.type]}/${candidate.slug}`)
      batchTargets.add(candidate.targetPath.replace(/\.(md|markdown)$/i, ''))
    }
  }

  return candidates.map((candidate, index) => {
    const input = linkInputs[index]
    if (!input) return candidate

    const found = inspectLinks(input.body, batchTargets, options.knownImages, {
      checkTargets,
      lineOffset: input.lineOffset,
    })
    if (found.length === 0) return candidate

    return { ...candidate, problems: sortProblems([...candidate.problems, ...found]) }
  })
}

/** Type directories, in the spelling index keys and link targets use. */
const CONTENT_DIR_OF: Record<ContentType, string> = CONTENT_TYPE_DIRS

const MARKDOWN_LABEL = '`.md` and `.markdown` files'

function resolveType(
  entry: ImportEntryInput,
  options: ImportInspectOptions,
): ContentType {
  if (options.forceType) return options.type
  return entry.inferredType ?? options.type
}

function typeSourceOf(
  entry: ImportEntryInput,
  options: ImportInspectOptions,
): ImportCandidate['typeSource'] {
  if (options.forceType) return 'flag'
  return entry.inferredType ? 'layout' : 'default'
}

function checkSlug(slug: string): ImportProblem | null {
  try {
    assertSlugIsUsable(slug)
    return null
  } catch (error) {
    return {
      code: 'invalid-slug',
      severity: 'warning',
      message: `“${slug}” cannot be used as a slug: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'The file name is used instead. Rename the file, or set a plain “slug:” value.',
    }
  }
}

function assertSlugIsUsable(slug: string): void {
  if (!slug || slug.length > 200) throw new Error('it is empty or too long')
  if (slug.includes('/') || slug.includes('\\')) throw new Error('it contains a path separator')
  if (slug === '.' || slug === '..') throw new Error('it is a directory reference')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(slug)) throw new Error('it contains control characters')
}

function rejectedCandidate(
  entry: ImportEntryInput,
  options: ImportInspectOptions,
  problems: ImportProblem[],
): ImportCandidate {
  const type = resolveType(entry, options)
  const filename = stemOf(entry.sourcePath)
  const slug = slugFromFilename(filename)
  return {
    sourcePath: entry.sourcePath,
    targetPath: buildRelativePath(type, slug),
    type,
    typeSource: typeSourceOf(entry, options),
    slug,
    title: filename,
    status: 'draft',
    description: '',
    wordCount: 0,
    readingTime: 0,
    bytes: entry.bytes?.length ?? 0,
    checksum: entry.bytes ? checksumOf(entry.bytes) : '',
    action: 'reject',
    problems: sortProblems(problems),
    fixes: {},
    content: '',
  }
}

/* -------------------------------------------------------------------------- */
/*  Plan                                                                       */
/* -------------------------------------------------------------------------- */

export interface BuildPlanInput {
  kind: ImportSourceKind
  source: string
  entries: readonly ImportEntryInput[]
  /** Problems about the batch itself, from the collector. */
  problems?: readonly ImportProblem[]
  options: ImportInspectOptions
  /** Replace an existing document instead of reporting it as skipped. */
  overwrite?: boolean
  truncated?: boolean
}

export function buildImportPlan(input: BuildPlanInput): ImportPlan {
  const candidates = inspectImportEntries(input.entries, input.options)
  const overwrite = input.overwrite ?? false

  const entries = candidates.map((candidate): ImportCandidate => {
    if (candidate.action !== 'create') return candidate
    if (!candidate.problems.some((problem) => problem.code === 'slug-conflict')) {
      return candidate
    }
    return { ...candidate, action: overwrite ? 'overwrite' : 'skip' }
  })

  const problems = [...(input.problems ?? [])]

  return {
    kind: input.kind,
    source: input.source,
    entries,
    problems,
    fingerprint: fingerprintOf(entries),
    counts: countPlan(entries, problems),
    truncated: input.truncated ?? false,
  }
}

function fingerprintOf(entries: readonly ImportCandidate[]): string {
  const material = entries.map((entry) => [
    entry.sourcePath,
    entry.checksum,
    entry.type,
    entry.slug,
    entry.action,
  ])
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

function countPlan(
  entries: readonly ImportCandidate[],
  batchProblems: readonly ImportProblem[],
): ImportCounts {
  const counts: ImportCounts = {
    scanned: entries.length,
    create: 0,
    overwrite: 0,
    skip: 0,
    reject: 0,
    errors: 0,
    warnings: 0,
    byCode: {},
    byType: { post: 0, note: 0, project: 0 },
    byStatus: { draft: 0, scheduled: 0, published: 0, archived: 0 },
    words: 0,
    readingTime: 0,
  }

  const tally = (problem: ImportProblem): void => {
    counts.byCode[problem.code] = (counts.byCode[problem.code] ?? 0) + 1
  }

  for (const problem of batchProblems) tally(problem)

  for (const entry of entries) {
    counts[entry.action] += 1
    const worst = worstSeverity(entry.problems)
    if (worst === 'error') counts.errors += 1
    else if (worst === 'warning') counts.warnings += 1

    for (const problem of entry.problems) tally(problem)

    if (entry.action === 'reject') continue
    counts.byType[entry.type] += 1
    counts.byStatus[entry.status] += 1
    counts.words += entry.wordCount
    counts.readingTime += entry.readingTime
  }

  return counts
}

/* -------------------------------------------------------------------------- */
/*  Collectors                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a directory tree of Markdown.
 *
 * Symlinks are followed only when they resolve inside the scan root; one that
 * points out of it is reported and skipped, because a scan of a directory
 * someone else controls is otherwise a way to read files the operator never
 * meant to publish. The same rule the content scanner applies, for the same
 * reason.
 */
export async function scanImportDirectory(
  directory: string,
  options: ImportScanOptions,
): Promise<ImportPlan> {
  const root = path.resolve(directory)

  let rootStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    rootStat = await fs.stat(root)
  } catch (error) {
    throw new ImportScanError(
      'not-a-directory',
      `Cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`,
      directory,
    )
  }
  if (!rootStat.isDirectory()) {
    throw new ImportScanError('not-a-directory', `${root} is not a directory`, directory)
  }

  const maxFiles = options.maxFiles ?? IMPORT_LIMITS.maxFiles
  const entries: ImportEntryInput[] = []
  const problems: ImportProblem[] = []
  const visited = new Set<string>()
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (entries.length >= maxFiles) {
      truncated = true
      return
    }

    const listing = await fs
      .readdir(dir, { withFileTypes: true, encoding: 'utf8' })
      .catch((error: unknown) => {
        problems.push({
          code: 'unreadable',
          severity: 'warning',
          message: `Cannot list ${path.relative(root, dir) || '.'}: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'Check permissions on that directory.',
        })
        return null
      })
    // One unreadable subdirectory must not abandon the files that were readable.
    if (!listing) return

    for (const dirent of listing) {
      if (entries.length >= maxFiles) {
        truncated = true
        return
      }
      if (isReservedDir(dirent.name)) continue

      const absolute = path.join(dir, dirent.name)
      const relative = path.relative(root, absolute).replace(/\\/g, '/')

      let isDirectory = dirent.isDirectory()
      let isFile = dirent.isFile()

      if (dirent.isSymbolicLink()) {
        let real: string
        try {
          real = await fs.realpath(absolute)
        } catch {
          problems.push({
            code: 'unreadable',
            severity: 'warning',
            message: `${relative} is a symlink that cannot be resolved`,
            suggestion: 'Replace it with a real file, or remove it.',
            path: relative,
          })
          continue
        }
        if (!isInsideRoot(root, real)) {
          problems.push({
            code: 'path-traversal',
            severity: 'warning',
            message: `${relative} is a symlink pointing outside the scanned directory`,
            suggestion:
              'Copy the file in, or scan the directory it actually lives in. Nothing was read.',
            path: relative,
          })
          continue
        }
        const realStat = await fs.stat(real).catch(() => null)
        if (!realStat) continue
        isDirectory = realStat.isDirectory()
        isFile = realStat.isFile()
        if (isDirectory && visited.has(real)) continue
        if (isDirectory) visited.add(real)
      }

      if (isDirectory) {
        await walk(absolute)
        continue
      }
      if (!isFile) continue

      if (!isMarkdownFile(dirent.name)) {
        problems.push({
          code: 'unsupported-extension',
          severity: options.nonMarkdownSeverity ?? 'info',
          message: `${relative} is not a Markdown file and was skipped`,
          suggestion: `Only ${MARKDOWN_LABEL} are imported.`,
          path: relative,
        })
        continue
      }

      let bytes: Buffer | null = null
      const readProblems: ImportProblem[] = []
      try {
        const stat = await fs.stat(absolute)
        if (stat.size > IMPORT_LIMITS.maxFileBytes) {
          readProblems.push({
            code: 'oversized-file',
            severity: 'error',
            message: `${relative} is ${formatBytes(stat.size)}, over the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} limit`,
            suggestion: 'Split the document, or raise the limit if the size is genuinely a long article.',
          })
        } else {
          bytes = await fs.readFile(absolute)
        }
      } catch (error) {
        readProblems.push({
          code: 'unreadable',
          severity: 'error',
          message: `${relative} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'Check the file permissions, then scan again.',
        })
      }

      entries.push({
        sourcePath: relative,
        bytes,
        problems: readProblems,
        inferredType: inferTypeFromPath(relative),
      })
    }
  }

  await walk(root)

  return buildImportPlan({
    kind: 'directory',
    source: options.source ?? root,
    entries,
    problems,
    // A directory is full of things that are not Markdown — images, PDFs, a
    // stray `.DS_Store`. Noting them is useful; calling each one an error would
    // bury the files that are actually broken.
    options: { ...options, nonMarkdownSeverity: options.nonMarkdownSeverity ?? 'info' },
    overwrite: options.overwrite ?? false,
    truncated,
  })
}

/**
 * Read a ZIP from memory.
 *
 * Nothing is unpacked to disk, so there is no extraction directory to escape
 * and no half-written tree to clean up when a batch is abandoned. A name like
 * `../../etc/passwd` is refused by `checkArchiveEntry` and *reported*, but the
 * containment does not rest on that: the destination path comes from the slug.
 */
export function scanImportArchive(
  buffer: Buffer,
  options: ImportScanOptions,
): ImportPlan {
  const source = options.source ?? 'archive'

  if (buffer.length > IMPORT_LIMITS.maxArchiveBytes) {
    throw new ImportScanError(
      'archive-too-large',
      `The archive is ${formatBytes(buffer.length)}, over the ${formatBytes(IMPORT_LIMITS.maxArchiveBytes)} limit`,
      source,
    )
  }

  const directory = readCentralDirectory(buffer, source)

  const budget = checkArchiveBudget(
    {
      compressedSize: buffer.length,
      declaredUncompressed: directory.declaredBytes,
      entryCount: directory.entries.length,
    },
    ARCHIVE_LIMITS,
  )

  if (!budget.ok) {
    const code: ImportScanErrorCode =
      budget.reason === 'archive contains too many entries'
        ? 'archive-too-many-entries'
        : budget.reason === 'compression ratio looks like a zip bomb'
          ? 'archive-bomb'
          : 'archive-too-large'
    throw new ImportScanError(
      code,
      `Refusing ${source}: ${budget.reason} (limits: ${IMPORT_LIMITS.maxArchiveEntries} entries, ${formatBytes(IMPORT_LIMITS.maxArchiveUncompressedBytes)}, ratio ${IMPORT_LIMITS.maxArchiveRatio})`,
      source,
    )
  }

  const entries: ImportEntryInput[] = []
  const problems: ImportProblem[] = []
  const maxFiles = options.maxFiles ?? IMPORT_LIMITS.maxFiles
  let totalRead = 0

  for (const meta of directory.entries) {
    // A directory entry carries no content. Its name still goes through the
    // screen, so a traversal attempt cannot hide behind a trailing slash.
    if (meta.name.endsWith('/')) {
      const check = checkArchiveEntry(meta.name)
      if (!check.ok) {
        const { code, message } = classifyPath(meta.name)
        problems.push({
          code,
          severity: 'error',
          message: `${message} (${check.reason})`,
          path: meta.name,
          suggestion: 'Remove the entry from the archive; nothing was read.',
        })
      }
      continue
    }

    if (entries.length >= maxFiles) {
      problems.push({
        code: 'too-many-files',
        severity: 'error',
        message: `The archive holds more than ${maxFiles} files; the rest were not read`,
        suggestion: `Split the archive, or raise the file cap.`,
      })
      break
    }

    const check = checkArchiveEntry(meta.name)
    if (!check.ok) {
      // Reported by `pathProblem` when the entry reaches the inspector, which
      // is where every other path problem is raised. Pushing one here as well
      // gave the same entry two errors and two different suggestions.
      entries.push({ sourcePath: meta.name, bytes: null })
      continue
    }

    const flagProblem = meta.flags & 0x1 ? 'the entry is encrypted' : null
    if (flagProblem || (meta.method !== 0 && meta.method !== 8)) {
      entries.push({
        sourcePath: meta.name,
        bytes: null,
        problems: [
          {
            code: 'unsupported-compression',
            severity: 'error',
            message: `${meta.name}: ${flagProblem ?? `compression method ${meta.method} is not supported`}`,
            suggestion: 'Re-create the archive with ordinary deflate compression and no password.',
          },
        ],
      })
      continue
    }

    if (meta.uncompressedSize > IMPORT_LIMITS.maxFileBytes) {
      entries.push({
        sourcePath: meta.name,
        bytes: null,
        problems: [
          {
            code: 'oversized-file',
            severity: 'error',
            message: `${meta.name} expands to ${formatBytes(meta.uncompressedSize)}, over the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} limit`,
            suggestion: 'Split the document, or raise the limit if the size is genuinely a long article.',
          },
        ],
      })
      continue
    }

    let bytes: Buffer | null = null
    const readProblems: ImportProblem[] = []
    try {
      bytes = readEntry(buffer, meta)
    } catch (error) {
      const tooLarge =
        (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ||
        /output length/i.test(error instanceof Error ? error.message : '')
      readProblems.push({
        code: tooLarge ? 'oversized-file' : 'unreadable',
        severity: 'error',
        message: tooLarge
          ? `${meta.name} expands past the ${formatBytes(IMPORT_LIMITS.maxFileBytes)} per-file limit`
          : `${meta.name} could not be decompressed: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: tooLarge
          ? 'Split the document before archiving it.'
          : 'The archive is damaged or truncated. Re-create it and scan again.',
      })
    }

    if (bytes) {
      totalRead += bytes.length
      // The running total is what catches a header that under-declares its
      // sizes: the central directory is attacker-controlled, the bytes are not.
      if (totalRead > IMPORT_LIMITS.maxArchiveUncompressedBytes) {
        throw new ImportScanError(
          'archive-bomb',
          `Refusing ${source}: it expands past ${formatBytes(IMPORT_LIMITS.maxArchiveUncompressedBytes)}`,
          source,
        )
      }

      // A size that disagrees with the header is the signature of a crafted or
      // damaged archive, and the file that came out is not the file that was
      // described. Refused rather than imported under the declared size.
      if (bytes.length !== meta.uncompressedSize) {
        readProblems.push({
          code: 'unreadable',
          severity: 'error',
          message: `${meta.name} expands to ${formatBytes(bytes.length)}, but the archive declares ${formatBytes(meta.uncompressedSize)}`,
          suggestion: 'Re-create the archive and scan again.',
        })
        bytes = null
      }
    }

    entries.push({
      sourcePath: meta.name,
      bytes,
      problems: readProblems,
      inferredType: inferTypeFromPath(meta.name),
    })
  }

  return buildImportPlan({
    kind: 'archive',
    source,
    entries,
    problems,
    options,
    overwrite: options.overwrite ?? false,
  })
}

export interface UploadedFile {
  name: string
  data: Buffer
}

/**
 * Inspect files that were handed over in memory — a single `.md`, a handful of
 * them, or an archive that was already unpacked by the caller.
 */
export function scanImportFiles(
  files: readonly UploadedFile[],
  options: ImportScanOptions,
): ImportPlan {
  const entries: ImportEntryInput[] = files.map((file) => ({
    sourcePath: file.name,
    bytes: file.data,
    inferredType: inferTypeFromPath(file.name),
  }))

  return buildImportPlan({
    kind: 'files',
    source: options.source ?? `${files.length} uploaded file${files.length === 1 ? '' : 's'}`,
    entries,
    options,
    overwrite: options.overwrite ?? false,
  })
}

/**
 * `posts/linux.md` names its type; `linux.md` does not. Only the *first*
 * segment counts: a file at `notes/2026/linux.md` is a note, and a directory in
 * the middle of the path names nothing.
 */
function inferTypeFromPath(sourcePath: string): ContentType | null {
  const segments = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length < 2) return null
  const head = (segments[0] ?? '').toLowerCase()
  return DIR_TO_CONTENT_TYPE[head] ?? null
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/* -------------------------------------------------------------------------- */
/*  What is already there                                                      */
/* -------------------------------------------------------------------------- */

export interface ExistingContent {
  /** `${dir}/${slug}` keys, as `content_index` is unique on them. */
  slugs: Set<string>
  /**
   * Keys a link can resolve to: the same `posts/foo` form, plus the destination
   * path without its extension, which is what a wiki link names. Both spellings
   * are registered because the sync engine resolves both — see
   * `resolveTargetKeys`.
   */
  targets: Set<string>
}

/** Read the content tree read-only, for conflict and link checking. */
export async function collectExistingContent(): Promise<ExistingContent> {
  const slugs = new Set<string>()
  const targets = new Set<string>()

  for (const file of await scanContentFiles()) {
    const document = await readDocument(file.relativePath).catch(() => null)
    if (!document) continue

    const dir = CONTENT_DIR_OF[document.type]
    slugs.add(`${dir}/${document.slug}`)
    targets.add(`${dir}/${document.slug}`)
    targets.add(file.relativePath.replace(/\.(md|markdown)$/i, ''))
  }

  return { slugs, targets }
}

/** Upload keys (`2026/09/diagram.webp`) relative to the upload root. */
export async function collectUploadKeys(): Promise<Set<string>> {
  const keys = new Set<string>()
  // Through `joinRuntimePath` so the file tracer does not treat this unresolved
  // root as a reason to bundle the whole project. See that function.
  const root = joinRuntimePath(process.cwd(), env.UPLOAD_DIR)

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > IMPORT_LIMITS.maxPathDepth) return

    // A missing upload directory is normal — nothing has been uploaded yet.
    const listing = await fs
      .readdir(dir, { withFileTypes: true, encoding: 'utf8' })
      .catch(() => null)
    if (!listing) return

    for (const dirent of listing) {
      if (isReservedDir(dirent.name)) continue
      const absolute = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      keys.add(path.relative(root, absolute).replace(/\\/g, '/'))
    }
  }

  await walk(root, 0)
  return keys
}

/* -------------------------------------------------------------------------- */
/*  Apply                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Write the entries the plan marked importable.
 *
 * The plan is the decision: `create` and `overwrite` entries are written,
 * `skip` and `reject` are not. Sources are read, never written — a fix changes
 * the copy that lands in the content tree and nothing else. Every write goes
 * through `importDocument`, so the lock, the temp file and the atomic rename are
 * the same ones an admin save uses.
 *
 * Nothing here is all-or-nothing. A file that fails is recorded as `failed` and
 * the batch continues, because aborting halfway would leave the operator with
 * neither the import nor a list of what landed; the result says exactly how many
 * of each outcome there were, and the caller decides the exit code.
 */
export async function applyImport(
  plan: ImportPlan,
  options: ImportApplyOptions = {},
): Promise<ImportApplyResult> {
  const started = Date.now()
  const emit = options.onEvent ?? (() => undefined)

  const result: ImportApplyResult = {
    created: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
    rejected: 0,
    files: [],
    afterWriteFailures: [],
    durationMs: 0,
  }

  // Slugs come from frontmatter, so an overwrite may target a filename that
  // differs from the slug. Writing its canonical name would create a second
  // document instead of replacing the one the report asked to overwrite.
  const existingPaths = new Map<string, string[]>()
  if (plan.entries.some((entry) => entry.action === 'overwrite')) {
    for (const file of await scanContentFiles()) {
      const document = await readDocument(file.relativePath).catch(() => null)
      if (!document) continue
      const key = `${document.type}/${document.slug}`
      existingPaths.set(key, [...(existingPaths.get(key) ?? []), file.relativePath])
    }
  }

  for (const entry of plan.entries) {
    if (entry.action === 'reject') {
      result.rejected += 1
      continue
    }
    if (entry.action === 'skip') {
      result.skipped += 1
      emit({
        kind: 'skipped',
        sourcePath: entry.sourcePath,
        targetPath: entry.targetPath,
        reason: 'a document with this slug already exists',
      })
      continue
    }

    try {
      const content =
        options.applyFixes && entry.fixes.title
          ? withFixes(entry.content, entry.fixes)
          : entry.content

      const matchingPaths = existingPaths.get(`${entry.type}/${entry.slug}`) ?? []
      if (entry.action === 'overwrite' && matchingPaths.length > 1) {
        throw new Error('More than one existing file declares this slug; resolve the duplicate before overwriting.')
      }
      const relativePath = entry.action === 'overwrite' ? matchingPaths[0] : undefined

      const written = await importDocument({
        type: entry.type,
        slug: entry.slug,
        content,
        overwrite: entry.action === 'overwrite',
        ...(relativePath ? { relativePath } : {}),
        preservePrevious: options.preservePrevious,
      })

      if (written.skipped) {
        result.skipped += 1
        emit({
          kind: 'skipped',
          sourcePath: entry.sourcePath,
          targetPath: written.relativePath,
          reason: 'a document with this slug already exists',
        })
        result.files.push({
          sourcePath: entry.sourcePath,
          targetPath: written.relativePath,
          outcome: 'skipped',
          checksum: entry.checksum,
        })
        continue
      }

      // `overwritten` means a file was there and is now this one — read from the
      // write itself, which read the target under its lock. A `stat` taken
      // before the write would be a second look at a file that another process
      // can change in between, and the count would disagree with the revision
      // captured for the same write.
      const outcome = written.previousContent === null ? 'created' : 'overwritten'
      if (outcome === 'overwritten') result.overwritten += 1
      else result.created += 1

      emit({ kind: outcome, sourcePath: entry.sourcePath, targetPath: written.relativePath })
      result.files.push({
        sourcePath: entry.sourcePath,
        targetPath: written.relativePath,
        outcome,
        checksum: checksumOf(content),
        ...(written.recoveryPath ? { recoveryPath: written.recoveryPath } : {}),
      })

      if (options.afterWrite) {
        try {
          await options.afterWrite({
            sourcePath: entry.sourcePath,
            targetPath: written.relativePath,
            type: entry.type,
            slug: entry.slug,
            outcome,
            content,
            previousContent: written.previousContent,
            recoveryPath: written.recoveryPath,
          })
        } catch (error) {
          result.afterWriteFailures.push(
            `${written.relativePath}: ${error instanceof Error ? error.message : String(error)}${written.recoveryPath ? ` Previous bytes are retained at ${written.recoveryPath}.` : ''}`,
          )
        }
      }
    } catch (error) {
      result.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      emit({
        kind: 'failed',
        sourcePath: entry.sourcePath,
        targetPath: entry.targetPath,
        message,
      })
      result.files.push({
        sourcePath: entry.sourcePath,
        targetPath: entry.targetPath,
        outcome: 'failed',
        checksum: entry.checksum,
        message,
      })
    }
  }

  result.durationMs = Date.now() - started
  return result
}

/** Apply the fixes to a copy of the file, leaving the source untouched. */
function withFixes(content: string, fixes: ImportFix): string {
  const parsed = parseFrontmatter(content)
  const data = normaliseFrontmatterKeys(parsed.data)
  if (fixes.title !== undefined && !String(data.title ?? '').trim()) {
    data.title = fixes.title
  }
  const { known, extra } = splitFrontmatterKeys(data)
  return serializeFrontmatter(known, parsed.content, { extra })
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The report as lines of plain text.
 *
 * Shared by the CLI and the admin page so the two cannot describe the same plan
 * differently. Deliberately plain: the caller adds colour or markup.
 */
export function importReportLines(plan: ImportPlan): string[] {
  const lines: string[] = []
  const { counts } = plan

  lines.push(
    `${counts.scanned} file${counts.scanned === 1 ? '' : 's'} scanned (${plan.source})`,
  )

  if (counts.create > 0) lines.push(`✓ ${counts.create} to import`)
  if (counts.overwrite > 0) lines.push(`✓ ${counts.overwrite} to overwrite`)
  if (counts.skip > 0) lines.push(`· ${counts.skip} skipped — the document already exists`)
  if (counts.reject > 0) lines.push(`✗ ${counts.reject} cannot be imported`)

  // Worst severity per code, so the mark in front of a count says whether the
  // files it counts can be imported.
  const severityOf = new Map<ImportProblemCode, ImportSeverity>()
  const note = (problem: ImportProblem): void => {
    const current = severityOf.get(problem.code)
    if (current === undefined || SEVERITY_RANK[problem.severity] < SEVERITY_RANK[current]) {
      severityOf.set(problem.code, problem.severity)
    }
  }
  for (const problem of [...plan.problems, ...plan.entries.flatMap((e) => e.problems)]) {
    note(problem)
  }

  const codes = Object.entries(counts.byCode) as [ImportProblemCode, number][]
  codes.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  for (const [code, count] of codes) {
    const label = count === 1 ? PROBLEM_LABELS_ONE[code] : (PROBLEM_LABELS[code] ?? code)
    const severity = severityOf.get(code) ?? 'warning'
    const mark = severity === 'error' ? '✗' : severity === 'info' ? '·' : '⚠'
    lines.push(`${mark} ${count} ${label}`)
  }

  if (plan.truncated) {
    lines.push(
      `✗ the scan stopped at ${IMPORT_LIMITS.maxFiles} files; raise the cap and scan again`,
    )
  }

  if (counts.create + counts.overwrite > 0) {
    lines.push(
      `${counts.words} words, about ${counts.readingTime} minute${counts.readingTime === 1 ? '' : 's'} of reading`,
    )
  }

  return lines
}

/* -------------------------------------------------------------------------- */
/*  ZIP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A minimal ZIP reader, central-directory based.
 *
 * A dependency would be the obvious way to do this, and the reason it is not
 * here is that the archive is only ever *read*: no extraction, no permissions, no
 * symlinks, no streaming. What is needed is the central directory (names,
 * declared sizes, compression method) and `inflateRaw`, both of which Node
 * already has.
 *
 * Not supported, and refused rather than half-read: ZIP64 and encrypted
 * entries. Both are errors with their own message, because an archive the
 * importer cannot read must say so instead of importing part of itself.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff
/** EOCD is 22 bytes plus a comment of at most 0xffff. */
const MAX_COMMENT_LENGTH = 0xffff

interface ZipEntryMeta {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

interface CentralDirectory {
  entries: ZipEntryMeta[]
  declaredBytes: number
}

function readCentralDirectory(buffer: Buffer, source: string): CentralDirectory {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === -1) {
    throw new ImportScanError(
      'archive-unreadable',
      `${source} is not a ZIP archive (no end-of-central-directory record)`,
      source,
    )
  }

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)

  if (
    entryCount === 0xffff ||
    directorySize === ZIP64_MARKER ||
    directoryOffset === ZIP64_MARKER
  ) {
    throw new ImportScanError(
      'archive-unsupported',
      `${source} is a ZIP64 archive, which this importer does not read. Re-create it without ZIP64.`,
      source,
    )
  }

  if (directoryOffset + directorySize > buffer.length) {
    throw new ImportScanError(
      'archive-unreadable',
      `${source} is truncated: its central directory runs past the end of the file`,
      source,
    )
  }

  const entries: ZipEntryMeta[] = []
  let declaredBytes = 0
  let offset = directoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ImportScanError(
        'archive-unreadable',
        `${source} is damaged: entry ${index + 1} of ${entryCount} cannot be read`,
        source,
      )
    }

    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)

    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      throw new ImportScanError(
        'archive-unsupported',
        `${source} needs ZIP64 for one of its entries, which this importer does not read.`,
        source,
      )
    }

    const name = buffer
      .toString('utf8', offset + 46, offset + 46 + nameLength)

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    declaredBytes += uncompressedSize

    offset += 46 + nameLength + extraLength + commentLength
  }

  return { entries, declaredBytes }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - MAX_COMMENT_LENGTH)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

function readEntry(buffer: Buffer, meta: ZipEntryMeta): Buffer {
  const offset = meta.localHeaderOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error('the local file header is missing')
  }

  // The local header's own name and extra lengths are authoritative for where
  // the data starts; they can differ from the central directory's.
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + meta.compressedSize

  if (end > buffer.length) throw new Error('the entry runs past the end of the archive')

  const raw = buffer.subarray(start, end)
  if (meta.method === 0) return Buffer.from(raw)

  return inflateRawSync(raw, { maxOutputLength: IMPORT_LIMITS.maxFileBytes })
}
