import 'server-only'

import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLogs, type AuditLogRow } from '@/lib/db/schema'

/**
 * Audit log.
 *
 * One row per mutating admin action: who, what, which record, and a small
 * metadata blob. Nothing in the application reads this to decide anything —
 * it is evidence after the fact, which is why `recordAudit` never throws. An
 * audit write that fails must not fail the action it was recording, so the
 * failure is reported on the server log instead. That is the one place in this
 * codebase where catching and logging is the correct behaviour rather than a
 * swallowed error, and it is the only reason this module exists as a wrapper
 * around a single `insert`.
 */

/* -------------------------------------------------------------------------- */
/*  Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every auditable action, as a closed union.
 *
 * The union is the point: a call site cannot invent `'post.publsh'` and have it
 * land in the table, where it would be a row that no query and no UI ever looks
 * for again. Adding an action is a deliberate edit here.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'post.create',
  'post.update',
  'post.delete',
  'post.publish',
  'post.unpublish',
  'post.import',
  'revision.restore',
  'asset.upload',
  'asset.delete',
  'settings.update',
  'navigation.update',
  'redirect.create',
  'redirect.update',
  'redirect.delete',
  'redirect.import',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** `denied` records an attempt that was refused — a failed login, a rejected CSRF token. */
export const AUDIT_OUTCOMES = ['ok', 'denied'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/* -------------------------------------------------------------------------- */
/*  Redaction                                                                  */
/* -------------------------------------------------------------------------- */

const REDACTED = '[redacted]'

/**
 * Key names whose value is a credential.
 *
 * Matched as whole words after splitting camelCase and snake_case apart, never
 * as substrings: `authorId` contains "auth" and is an ordinary audit field,
 * while `sessionToken` is a credential. A substring match would redact the
 * first and, worse, would look like it was working.
 */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'secret',
  'token',
  'csrf',
  'session',
  'authorization',
  'cookie',
  'credential',
  'credentials',
])

/**
 * Words that turn a following `key` into a credential. `targetKey` names a
 * document; `apiKey` is a bearer token.
 */
const KEY_QUALIFIERS = new Set(['api', 'private', 'access', 'signing', 'secret'])

/**
 * Depth ceiling for the redaction walk.
 *
 * A cyclic object would otherwise recurse until the stack gives out, and a
 * metadata blob nested deeper than this carries no audit value anyway.
 */
const MAX_DEPTH = 8

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

export function isSecretKey(key: string): boolean {
  const words = wordsOf(key)
  if (words.some((word) => SECRET_WORDS.has(word))) return true
  return words.includes('key') && words.some((word) => KEY_QUALIFIERS.has(word))
}

/**
 * Copy `value` into something jsonb can hold, with credentials replaced.
 *
 * Two jobs in one walk because both are about the same boundary: what may be
 * written to a log that outlives the request. Secrets become `[redacted]`
 * rather than disappearing, so a reader can see that a field was there and was
 * withheld instead of wondering whether it was ever recorded. Non-JSON values
 * are converted — `JSON.stringify` throws on a bigint, and a metadata blob that
 * cannot be serialised is a lost audit row.
 */
function sanitize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated]'
  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      // NaN and the infinities are not representable in JSON.
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      // Dropped by the object branch below.
      return undefined
    default:
      break
  }

  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1) ?? null)
  }

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      result[key] = REDACTED
      continue
    }
    const sanitized = sanitize(entry, depth + 1)
    if (sanitized !== undefined) result[key] = sanitized
  }
  return result
}

/**
 * Make a metadata object safe to store.
 *
 * Exported so a caller can assert on what will be written — and so the rule is
 * testable without a database. Every path into `audit_logs.meta` goes through
 * here; there is no second door.
 */
export function redactAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitize(metadata, 0)
  if (
    typeof sanitized === 'object' &&
    sanitized !== null &&
    !Array.isArray(sanitized)
  ) {
    return sanitized as Record<string, unknown>
  }
  // Only reachable if the caller passed a metadata object nested past the depth
  // ceiling, which the marker then records.
  return { truncated: true }
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Request details worth recording. Structurally compatible with
 * `RequestContext` in `@/lib/auth/session`, so an action can pass its context
 * straight through.
 *
 * Only the hashed IP is accepted. The raw address is never stored, here or
 * anywhere else.
 */
export interface AuditRequestContext {
  ipHash?: string | null
}

export interface AuditEntry {
  action: AuditAction
  /** `users.id` of whoever acted. Null for an anonymous attempt. */
  actorId?: string | null
  targetType?: string | null
  targetId?: string | null
  /**
   * Small, factual, and free of credentials. Redacted on the way in, so a
   * password that reaches this field is written as `[redacted]` rather than
   * leaking — but a password should not reach this field at all.
   */
  metadata?: Record<string, unknown> | null
  outcome?: AuditOutcome
  request?: AuditRequestContext | null
}

const auditEntrySchema = z.object({
  action: z.enum(AUDIT_ACTIONS),
  actorId: z.uuid().nullish(),
  targetType: z.string().trim().max(40).nullish(),
  targetId: z.string().trim().max(200).nullish(),
  outcome: z.enum(AUDIT_OUTCOMES).default('ok'),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  // Unknown keys are stripped rather than rejected, so a caller can pass a
  // whole `RequestContext` and only the hashed IP is kept from it.
  request: z
    .object({
      ipHash: z.string().length(64).nullish(),
    })
    .nullish(),
})

/**
 * Record one admin action.
 *
 * Resolves whether or not the row was written. Callers `await` it to be sure
 * the row is committed before the response goes out, but must not branch on the
 * result: there is no result to branch on.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const parsed = auditEntrySchema.safeParse(entry)

  if (!parsed.success) {
    console.error('[audit] rejected an entry that failed validation', {
      action: entry.action,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    })
    return
  }

  const { action, actorId, targetType, targetId, outcome, metadata, request } =
    parsed.data

  try {
    await db.insert(auditLogs).values({
      action,
      userId: actorId ?? null,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      outcome,
      meta: redactAuditMetadata(metadata ?? {}),
      ipHash: request?.ipHash ?? null,
    })
  } catch (error) {
    console.error('[audit] write failed', {
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export class AuditQueryError extends Error {
  readonly code = 'AUDIT_QUERY'
  constructor(message: string) {
    super(message)
    this.name = 'AuditQueryError'
  }
}

export interface AuditLogQuery {
  limit?: number
  offset?: number
  /** Restrict to one actor's entries. */
  actorId?: string
  action?: AuditAction
  /** Inclusive lower bound on `created_at`. */
  from?: Date
  /** Inclusive upper bound on `created_at`. */
  to?: Date
}

export interface AuditLogPage {
  rows: AuditLogRow[]
  /** Rows matching the filters, ignoring `limit` and `offset`. */
  total: number
}

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  actorId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.date().optional(),
  to: z.date().optional(),
})

/** One page of the audit log, newest first, with the unfiltered-by-page total. */
export async function listAuditLogs(
  query: AuditLogQuery = {},
): Promise<AuditLogPage> {
  const parsed = auditQuerySchema.safeParse(query)
  if (!parsed.success) {
    throw new AuditQueryError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    )
  }

  const { limit, offset, actorId, action, from, to } = parsed.data

  const conditions: SQL[] = []
  if (actorId) conditions.push(eq(auditLogs.userId, actorId))
  if (action) conditions.push(eq(auditLogs.action, action))
  if (from) conditions.push(gte(auditLogs.createdAt, from))
  if (to) conditions.push(lte(auditLogs.createdAt, to))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .offset(offset)

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(where)

  return { rows, total: counted?.total ?? 0 }
}
