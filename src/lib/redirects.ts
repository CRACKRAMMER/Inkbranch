import 'server-only'

import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { redirects, type RedirectRow } from '@/lib/db/schema'
import {
  internalPathProblem,
  isExternalUrl,
  externalUrlProblem,
} from '@/lib/security/urls'

/**
 * Redirects.
 *
 * Two halves that fail in different ways. `resolveRedirect` runs on the 404
 * path — every miss on the site pays for it, so it is one indexed read and
 * nothing else. Everything else is admin-side: it can afford to load the whole
 * table to answer "would this redirect close a loop?".
 *
 * Loop detection is not a nicety. `a → b → a` is a browser-side infinite
 * redirect that no request log will show as an error, and a chain long enough
 * to exceed a crawler's hop limit is a page that silently disappears from an
 * index. Both are refused when the row is written.
 */

/** Longest chain a redirect may join before the save is refused. */
export const MAX_REDIRECT_HOPS = 10

/** Status codes a redirect may carry. 303 and 305 are not in the set. */
export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const

/**
 * Prefixes that never reach a redirect.
 *
 * The framework serves `/_next` and the application serves `/api`, so a
 * redirect on either is a row that cannot fire. They are refused at write time
 * and skipped before the query at read time, which is where the saving is: a
 * missing image or a stale chunk is the most common 404 on the site.
 */
const UNREACHABLE_PREFIXES = ['/_next/', '/api/'] as const

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type RedirectErrorReason =
  | 'invalid_input'
  /** The source path can never be requested, so the row could never fire. */
  | 'unreachable_source'
  /** The redirect would create a loop or an over-long chain. */
  | 'loop'
  | 'unknown_id'

export class RedirectError extends Error {
  readonly code = 'REDIRECT'
  readonly reason: RedirectErrorReason
  readonly issues: readonly string[]
  /** The chain that was walked, when `reason` is `loop`. */
  readonly chain: readonly string[]

  constructor(
    reason: RedirectErrorReason,
    message: string,
    options: { issues?: readonly string[]; chain?: readonly string[] } = {},
  ) {
    super(message)
    this.name = 'RedirectError'
    this.reason = reason
    this.issues = options.issues ?? []
    this.chain = options.chain ?? []
  }
}

/* -------------------------------------------------------------------------- */
/*  Path handling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The form a path is stored and compared in.
 *
 * The query string is dropped and the trailing slash removed, so `/old/?a=1`
 * and `/old` are one row. Without this the same redirect is written four times
 * by four people and fires for exactly one of the four requests. The fragment
 * is dropped for the same reason: it never reaches the server.
 *
 * Nothing else is touched. Case and percent-encoding are left alone, because
 * the comparison downstream is against a request path, byte for byte.
 */
export function normalizeRedirectPath(path: string): string {
  const withoutQuery = path.split('?')[0]?.split('#')[0] ?? ''

  if (withoutQuery.length <= 1) return withoutQuery

  let end = withoutQuery.length
  while (end > 1 && withoutQuery[end - 1] === '/') end -= 1
  return withoutQuery.slice(0, end)
}

/**
 * True when a path can possibly match a stored redirect.
 *
 * Cheap string checks only — this runs before the query, so it must not be
 * slower than the query it is avoiding.
 */
export function isResolvableRedirectSource(path: string): boolean {
  if (!path.startsWith('/')) return false
  if (path.startsWith('//')) return false
  if (path.length > 512) return false
  return !UNREACHABLE_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/* -------------------------------------------------------------------------- */
/*  Resolving                                                                  */
/* -------------------------------------------------------------------------- */

export interface RedirectResolution {
  fromPath: string
  toPath: string
  statusCode: number
}

/**
 * The redirect for `path`, or null.
 *
 * One indexed read of the unique index on `from_path`, and a fast `null` for
 * the paths that cannot match. `hits` is deliberately not incremented: this
 * runs on the miss path of every request, and turning that read into a write
 * would make every 404 contend on the same row's lock.
 */
export async function resolveRedirect(
  path: string,
): Promise<RedirectResolution | null> {
  const normalized = normalizeRedirectPath(path)
  if (!isResolvableRedirectSource(normalized)) return null

  const [row] = await db
    .select({
      fromPath: redirects.fromPath,
      toPath: redirects.toPath,
      statusCode: redirects.statusCode,
    })
    .from(redirects)
    .where(and(eq(redirects.fromPath, normalized), eq(redirects.enabled, true)))
    .limit(1)

  return row ?? null
}

/* -------------------------------------------------------------------------- */
/*  Loop detection                                                             */
/* -------------------------------------------------------------------------- */

export type RedirectLoopReason = 'self' | 'cycle' | 'too_long'

export type RedirectLoopCheck =
  | { ok: true }
  | { ok: false; reason: RedirectLoopReason; chain: readonly string[] }

/**
 * Would saving `from → to` create a loop, or a chain nobody will follow?
 *
 * `lookup` answers "where does this path currently point?", and must already
 * include the pending save: the whole question is what the table looks like
 * *after* the write, and a lookup that reports the old target for `from` would
 * answer a different question.
 *
 * Pure, and synchronous by design — the walk is the part worth testing, and it
 * does not need to know whether the answers come from a query or a fixture.
 */
export function detectRedirectLoop(
  from: string,
  to: string,
  lookup: (path: string) => string | null,
  maxHops: number = MAX_REDIRECT_HOPS,
): RedirectLoopCheck {
  const source = normalizeRedirectPath(from)
  const target = nextHopKey(to)

  if (source === target) {
    return { ok: false, reason: 'self', chain: [source, target] }
  }

  const chain: string[] = [source, target]
  const seen = new Set(chain)
  let current = target

  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = lookup(current)
    if (next === null) return { ok: true }

    const key = nextHopKey(next)
    if (seen.has(key)) {
      return { ok: false, reason: 'cycle', chain: [...chain, key] }
    }

    chain.push(key)
    seen.add(key)
    current = key
  }

  return { ok: false, reason: 'too_long', chain }
}

/**
 * Keys the walk compares on. An external URL is compared as written — only
 * site-relative paths have a stored form that needs normalising, and stripping
 * a trailing slash from `https://example.com/` would change the URL.
 */
function nextHopKey(path: string): string {
  return isExternalUrl(path) ? path : normalizeRedirectPath(path)
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

const redirectInputSchema = z.object({
  fromPath: z.string().trim().min(1, 'Source path is required').max(512),
  toPath: z.string().trim().min(1, 'Target is required').max(512),
  statusCode: z.coerce
    .number()
    .int()
    .refine(
      (value) => (REDIRECT_STATUS_CODES as readonly number[]).includes(value),
      `Status code must be one of ${REDIRECT_STATUS_CODES.join(', ')}`,
    )
    .default(301),
  enabled: z.boolean().default(true),
  note: z.string().trim().max(300).nullish(),
})

export interface RedirectInput {
  fromPath: string
  toPath: string
  statusCode?: number
  enabled?: boolean
  note?: string | null
}

export interface ValidatedRedirect {
  fromPath: string
  toPath: string
  statusCode: number
  enabled: boolean
  note: string | null
}

/**
 * Normalise and validate a redirect.
 *
 * The target may leave the site; the source may not, because a request path is
 * what it is compared against and an absolute URL can never equal one.
 */
export function validateRedirect(input: RedirectInput): ValidatedRedirect {
  const parsed = redirectInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new RedirectError('invalid_input', 'The redirect is not valid.', {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    })
  }

  const fromPath = normalizeRedirectPath(parsed.data.fromPath)
  const fromProblem = internalPathProblem(fromPath)
  if (fromProblem) {
    throw new RedirectError('invalid_input', `Source path: ${fromProblem}`, {
      issues: [fromProblem],
    })
  }
  if (!isResolvableRedirectSource(fromPath)) {
    throw new RedirectError(
      'unreachable_source',
      `A redirect on ${fromPath} can never fire: that path is served before the 404 handler runs.`,
    )
  }

  const rawTarget = parsed.data.toPath
  const toPath = isExternalUrl(rawTarget)
    ? rawTarget
    : normalizeRedirectPath(rawTarget)
  if (!isExternalUrl(toPath)) {
    const toProblem = internalPathProblem(toPath)
    if (toProblem) {
      throw new RedirectError('invalid_input', `Target: ${toProblem}`, {
        issues: [toProblem],
      })
    }
  }
  // An external target that only just failed the checks above still reports the
  // URL reason rather than the path one.
  if (rawTarget.startsWith('http') && !isExternalUrl(rawTarget)) {
    const urlProblem = externalUrlProblem(rawTarget)
    if (urlProblem) {
      throw new RedirectError('invalid_input', `Target: ${urlProblem}`, {
        issues: [urlProblem],
      })
    }
  }

  return {
    fromPath,
    toPath,
    statusCode: parsed.data.statusCode,
    enabled: parsed.data.enabled,
    note: parsed.data.note ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  CSV                                                                        */
/* -------------------------------------------------------------------------- */

export interface CsvRecord {
  /** 1-based line the record starts on. */
  line: number
  fields: string[]
}

export interface CsvReadResult {
  records: CsvRecord[]
  /**
   * The file ended inside a quoted field, which means the last record is not
   * what it looks like. Reported rather than thrown: an import that refuses
   * everything because of a stray quote is worse than one that imports what it
   * could and says so.
   */
  unterminatedQuote: boolean
}

/**
 * Read CSV into records.
 *
 * A hand-written reader, because the format is three columns and a dependency
 * is not free: `from,to,status`. What it does have to handle is quoting, since
 * a redirect target can contain a comma (`/tag/react,redux`) and splitting on
 * commas mangles exactly that case into a wrong destination. Handles CRLF, LF,
 * `""` escapes, and newlines inside quoted fields.
 */
export function readCsvRecords(text: string): CsvReadResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: CsvRecord[] = []

  let fields: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let recordLine = 1

  const endField = (): void => {
    fields.push(field)
    field = ''
  }
  const endRecord = (): void => {
    endField()
    records.push({ line: recordLine, fields })
    fields = []
    recordLine = line
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
          continue
        }
        inQuotes = false
        continue
      }
      // A newline inside quotes is data, and it still advances the line count
      // so that a later error names the right line.
      if (char === '\n') line += 1
      field += char
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      endField()
      continue
    }
    if (char === '\r') {
      if (input[index + 1] === '\n') index += 1
      line += 1
      endRecord()
      recordLine = line
      continue
    }
    if (char === '\n') {
      line += 1
      endRecord()
      recordLine = line
      continue
    }
    field += char
  }

  const unterminatedQuote = inQuotes
  if (field !== '' || fields.length > 0) {
    endField()
    records.push({ line: recordLine, fields })
  }

  return { records, unterminatedQuote }
}

export const REDIRECT_SKIP_REASONS = [
  'blank',
  'header',
  'column_count',
  'invalid_from',
  'invalid_to',
  'invalid_status',
  'same_path',
  'duplicate',
  'loop',
  'chain_too_long',
] as const

export type RedirectSkipReason = (typeof REDIRECT_SKIP_REASONS)[number]

export interface RedirectCsvSkip {
  /** 1-based line of the offending record. */
  line: number
  reason: RedirectSkipReason
  /** Why, in words, for the person who has to fix the file. */
  detail: string
  /** The record as written, so it can be found. */
  raw: string
}

export interface RedirectCsvRow extends ValidatedRedirect {
  line: number
}

export interface RedirectCsvParseResult {
  rows: RedirectCsvRow[]
  skipped: RedirectCsvSkip[]
  unterminatedQuote: boolean
}

/**
 * A stored redirect, as much of it as the loop walk and the import need.
 *
 * The status code is here for one reason: an import that re-states a source path
 * with the same target but a different status is a change, and a map that
 * carried only the target would file it as "already there" and write nothing.
 */
export interface StoredRedirectTarget {
  toPath: string
  statusCode: number
}

/** Source path → where it points. */
export type RedirectMap = ReadonlyMap<string, StoredRedirectTarget>

export interface ParseRedirectsCsvOptions {
  /**
   * The redirects already stored. Rows in the file are checked against this,
   * and against the rows accepted before them in the same file, so `a → b`
   * followed by `b → a` is caught even though neither exists yet.
   */
  existing?: RedirectMap
}

const HEADER_FIRST_CELLS = new Set(['from', 'from_path', 'source'])
const HEADER_SECOND_CELLS = new Set(['to', 'to_path', 'target'])

/**
 * Turn a CSV into redirects, and into a list of the rows that were not.
 *
 * Every row that is dropped is dropped with a reason. A silently discarded row
 * is a redirect that the operator believes is in place and is not, which is the
 * one failure mode of an import that nothing downstream will ever report.
 */
export function parseRedirectsCsv(
  text: string,
  options: ParseRedirectsCsvOptions = {},
): RedirectCsvParseResult {
  const { records, unterminatedQuote } = readCsvRecords(text)
  const rows: RedirectCsvRow[] = []
  const skipped: RedirectCsvSkip[] = []

  // A copy: the caller's map is the state before the import, and this walk
  // needs the state during it.
  const known = new Map<string, StoredRedirectTarget>(options.existing ?? [])
  /**
   * Sources this file has already used.
   *
   * Tracked apart from `known` because the two are not the same question. A
   * source already in the database is a row this import may be *changing*; a
   * source used twice in one file is a file that disagrees with itself, and
   * which of the two rows wins is not something a reader can predict.
   */
  const seenInFile = new Set<string>()

  const skip = (
    record: CsvRecord,
    reason: RedirectSkipReason,
    detail: string,
  ): void => {
    skipped.push({
      line: record.line,
      reason,
      detail,
      raw: record.fields.join(','),
    })
  }

  for (const [index, record] of records.entries()) {
    const [rawFrom = '', rawTo = '', rawStatus = ''] = record.fields

    if (record.fields.every((field) => field.trim() === '')) {
      skip(record, 'blank', 'Empty line')
      continue
    }

    if (
      index === 0 &&
      HEADER_FIRST_CELLS.has(rawFrom.trim().toLowerCase()) &&
      HEADER_SECOND_CELLS.has(rawTo.trim().toLowerCase())
    ) {
      skip(record, 'header', 'Column header')
      continue
    }

    if (record.fields.length < 2 || record.fields.length > 3) {
      skip(
        record,
        'column_count',
        `Expected "from,to" or "from,to,status"; found ${record.fields.length} columns`,
      )
      continue
    }

    const fromPath = normalizeRedirectPath(rawFrom.trim())
    const fromProblem = internalPathProblem(fromPath)
    if (fromProblem) {
      skip(record, 'invalid_from', fromProblem)
      continue
    }
    if (!isResolvableRedirectSource(fromPath)) {
      skip(
        record,
        'invalid_from',
        `${fromPath} is served before the 404 handler runs, so a redirect on it can never fire`,
      )
      continue
    }

    const rawTarget = rawTo.trim()
    const isExternal = isExternalUrl(rawTarget)
    const toPath = isExternal ? rawTarget : normalizeRedirectPath(rawTarget)
    const toProblem = isExternal
      ? externalUrlProblem(rawTarget)
      : internalPathProblem(toPath)
    if (toProblem) {
      skip(record, 'invalid_to', toProblem)
      continue
    }

    const trimmedStatus = rawStatus.trim()
    const statusCode = trimmedStatus === '' ? 301 : Number(trimmedStatus)
    if (
      !Number.isInteger(statusCode) ||
      !(REDIRECT_STATUS_CODES as readonly number[]).includes(statusCode)
    ) {
      skip(
        record,
        'invalid_status',
        `Status must be one of ${REDIRECT_STATUS_CODES.join(', ')}; found "${trimmedStatus}"`,
      )
      continue
    }

    if (seenInFile.has(fromPath)) {
      skip(record, 'duplicate', `${fromPath} already appears in this file`)
      continue
    }

    // Already stored and unchanged: nothing to write. Reported rather than
    // dropped, because "already there" and "did not apply" look identical from
    // the outside and only one of them is fine.
    const stored = known.get(fromPath)
    if (stored?.toPath === toPath && stored.statusCode === statusCode) {
      skip(
        record,
        'duplicate',
        `${fromPath} already redirects to ${toPath} with status ${statusCode}`,
      )
      continue
    }

    const check = detectRedirectLoop(fromPath, toPath, (path) => {
      // The pending row is part of the state the walk sees, and so is every row
      // accepted earlier in this file.
      if (path === fromPath) return toPath
      return known.get(path)?.toPath ?? null
    })

    if (!check.ok) {
      skip(
        record,
        check.reason === 'too_long' ? 'chain_too_long' : 'loop',
        check.reason === 'too_long'
          ? `Chain is longer than ${MAX_REDIRECT_HOPS} hops: ${check.chain.join(' → ')}`
          : `Would redirect in a loop: ${check.chain.join(' → ')}`,
      )
      continue
    }

    if (fromPath === toPath) {
      skip(record, 'same_path', 'Source and target are the same path')
      continue
    }

    known.set(fromPath, { toPath, statusCode })
    seenInFile.add(fromPath)
    rows.push({
      line: record.line,
      fromPath,
      toPath,
      statusCode,
      enabled: true,
      note: null,
    })
  }

  return { rows, skipped, unterminatedQuote }
}

/* -------------------------------------------------------------------------- */
/*  Reads and writes                                                           */
/* -------------------------------------------------------------------------- */

export interface RedirectWriteContext {
  /** `users.id` of the account making the change, for the audit row. */
  actorId?: string | null
  /** Hashed IP from `getRequestContext()`. Never the raw address. */
  ipHash?: string | null
}

/**
 * Every redirect, as a map.
 *
 * Deliberately unbounded: loop detection that skipped rows would miss the loop
 * that runs through one of them, and a wrong answer here writes an infinite
 * redirect into the database. The table holds one row per moved URL, so this is
 * small in a way the content index is not.
 */
async function loadRedirectMap(): Promise<Map<string, StoredRedirectTarget>> {
  const rows = await db
    .select({
      fromPath: redirects.fromPath,
      toPath: redirects.toPath,
      statusCode: redirects.statusCode,
    })
    .from(redirects)

  return new Map(
    rows.map((row) => [
      row.fromPath,
      { toPath: row.toPath, statusCode: row.statusCode },
    ]),
  )
}

/**
 * Create or replace the redirect for its source path.
 *
 * The source path is the identity — a path can only redirect to one place, and
 * the unique index says so — which makes this an upsert rather than a
 * create-or-fail. Saving the same source twice is how a rule is corrected.
 */
export async function saveRedirect(
  input: RedirectInput,
  context: RedirectWriteContext = {},
): Promise<RedirectRow> {
  const validated = validateRedirect(input)

  const known = await loadRedirectMap()
  const existing = known.get(validated.fromPath)

  // Re-saving the same target cannot close a loop: the walk would follow the
  // edge that is already there, and it did not loop when it was written.
  if (existing?.toPath !== validated.toPath) {
    const check = detectRedirectLoop(
      validated.fromPath,
      validated.toPath,
      (path) => {
        if (path === validated.fromPath) return validated.toPath
        return known.get(path)?.toPath ?? null
      },
    )
    if (!check.ok) {
      throw new RedirectError(
        'loop',
        check.reason === 'too_long'
          ? `That target joins a chain longer than ${MAX_REDIRECT_HOPS} hops: ${check.chain.join(' → ')}`
          : `That redirect would loop: ${check.chain.join(' → ')}`,
        { chain: check.chain },
      )
    }
  }

  const [row] = await db
    .insert(redirects)
    .values(validated)
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: {
        toPath: validated.toPath,
        statusCode: validated.statusCode,
        enabled: validated.enabled,
        note: validated.note,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) {
    throw new RedirectError(
      'invalid_input',
      `The redirect for ${validated.fromPath} was not written.`,
    )
  }

  await recordAudit({
    action: existing ? 'redirect.update' : 'redirect.create',
    actorId: context.actorId ?? null,
    targetType: 'redirect',
    targetId: row.fromPath,
    metadata: {
      toPath: row.toPath,
      statusCode: row.statusCode,
      enabled: row.enabled,
    },
    request: context.ipHash ? { ipHash: context.ipHash } : null,
  })

  return row
}

/** Remove one redirect. Returns false when the id matches nothing. */
export async function deleteRedirect(
  id: string,
  context: RedirectWriteContext = {},
): Promise<boolean> {
  const parsedId = z.uuid().safeParse(id)
  if (!parsedId.success) {
    throw new RedirectError('unknown_id', 'That is not a redirect id.')
  }

  const [row] = await db
    .delete(redirects)
    .where(eq(redirects.id, parsedId.data))
    .returning()

  if (!row) return false

  await recordAudit({
    action: 'redirect.delete',
    actorId: context.actorId ?? null,
    targetType: 'redirect',
    targetId: row.fromPath,
    metadata: { toPath: row.toPath },
    request: context.ipHash ? { ipHash: context.ipHash } : null,
  })

  return true
}

export interface ListRedirectsQuery {
  limit?: number
  offset?: number
  /** Case-insensitive substring match on either path. */
  search?: string
}

export interface RedirectPage {
  rows: RedirectRow[]
  /** Rows matching the filters, ignoring `limit` and `offset`. */
  total: number
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
})

export async function listRedirects(
  query: ListRedirectsQuery = {},
): Promise<RedirectPage> {
  const parsed = listQuerySchema.safeParse(query)
  if (!parsed.success) {
    throw new RedirectError('invalid_input', 'Invalid redirect query.', {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    })
  }

  const { limit, offset, search } = parsed.data
  const trimmed = search?.trim()

  const conditions = trimmed
    ? [
        or(
          ilike(redirects.fromPath, `%${trimmed}%`),
          ilike(redirects.toPath, `%${trimmed}%`),
        ),
      ]
    : []
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await db
    .select()
    .from(redirects)
    .where(where)
    .orderBy(desc(redirects.updatedAt), asc(redirects.fromPath))
    .limit(limit)
    .offset(offset)

  const [counted] = await db
    .select({ total: count() })
    .from(redirects)
    .where(where)

  return { rows, total: counted?.total ?? 0 }
}

/* -------------------------------------------------------------------------- */
/*  Import                                                                     */
/* -------------------------------------------------------------------------- */

export interface RedirectImportReport {
  /** New source paths. */
  imported: number
  /** Source paths that already existed and were pointed somewhere else. */
  updated: number
  /** Rows that were not imported, each with its line and the reason. */
  skipped: RedirectCsvSkip[]
  /** The file ended inside a quoted field; the last row may be wrong. */
  unterminatedQuote: boolean
}

/**
 * Import `from,to[,status]` rows.
 *
 * The whole file is validated before anything is written, so a file with one
 * bad row imports the good ones rather than nothing — and the report says which
 * ones it did not, and why. Nothing is dropped quietly: a redirect an operator
 * believes is in place and is not is invisible until someone follows a link.
 *
 * A row whose source path is already stored is an update, not a duplicate — the
 * source path is the identity of a redirect, so a corrected file is how a wrong
 * target is fixed. Only a row that would write exactly what is already there,
 * or a source the file itself has already used, is reported as skipped.
 */
export async function importRedirectsFromCsv(
  text: string,
  context: RedirectWriteContext = {},
): Promise<RedirectImportReport> {
  const known = await loadRedirectMap()
  const { rows, skipped, unterminatedQuote } = parseRedirectsCsv(text, {
    existing: known,
  })

  const created = rows.filter((row) => !known.has(row.fromPath)).length

  if (rows.length > 0) {
    await db
      .insert(redirects)
      .values(
        rows.map((row) => ({
          fromPath: row.fromPath,
          toPath: row.toPath,
          statusCode: row.statusCode,
          enabled: row.enabled,
          note: row.note,
        })),
      )
      .onConflictDoUpdate({
        target: redirects.fromPath,
        set: {
          toPath: sql`excluded.to_path`,
          statusCode: sql`excluded.status_code`,
          enabled: sql`excluded.enabled`,
          note: sql`excluded.note`,
          updatedAt: new Date(),
        },
      })
  }

  if (rows.length > 0 || skipped.length > 0) {
    await recordAudit({
      action: 'redirect.import',
      actorId: context.actorId ?? null,
      targetType: 'redirect',
      targetId: null,
      metadata: {
        imported: created,
        updated: rows.length - created,
        skipped: skipped.length,
        skipReasons: [...new Set(skipped.map((entry) => entry.reason))],
        unterminatedQuote,
      },
      request: context.ipHash ? { ipHash: context.ipHash } : null,
    })
  }

  return {
    imported: created,
    updated: rows.length - created,
    skipped,
    unterminatedQuote,
  }
}
