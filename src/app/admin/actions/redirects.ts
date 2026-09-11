'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { RATE_LIMITS, consumeRateLimit, retryAfterSeconds } from '@/lib/auth/rate-limit'
import { db } from '@/lib/db'
import { redirects } from '@/lib/db/schema'
import {
  REDIRECT_STATUS_CODES,
  deleteRedirect,
  importRedirectsFromCsv,
  normalizeRedirectPath,
  saveRedirect,
} from '@/lib/redirects'
import { actionFailure, actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'

/**
 * Creating, correcting and removing redirects.
 *
 * All three write through `@/lib/redirects`, which validates the paths itself
 * (a source has to be a request path; a target may leave the site), refuses a
 * chain that would loop, and records its own audit rows — so nothing here
 * duplicates any of that. The validation below is the shape of the input, which
 * is the one thing a module receiving typed arguments cannot check.
 *
 * CSV import is rate limited on the same policy as content import: both are
 * deliberate, occasional, and expensive enough that a stuck client should be
 * stopped rather than served.
 */

const statusCodeSchema = z
  .number()
  .int()
  .refine(
    (value) => (REDIRECT_STATUS_CODES as readonly number[]).includes(value),
    `One of ${REDIRECT_STATUS_CODES.join(', ')}`,
  )

const saveSchema = z.object({
  fromPath: z.string().trim().min(1, 'A redirect needs a path to match').max(512),
  toPath: z.string().trim().min(1, 'A redirect needs a destination').max(512),
  statusCode: statusCodeSchema,
  enabled: z.boolean(),
  note: z.string().trim().max(300).nullable(),
})

const deleteSchema = z.object({
  id: z.uuid(),
})

const importSchema = z.object({
  csv: z.string().min(1, 'Paste or upload some rows first').max(2_000_000),
})

export type SaveRedirectInput = z.output<typeof saveSchema>
export type DeleteRedirectInput = z.output<typeof deleteSchema>
export type ImportRedirectsInput = z.output<typeof importSchema>

export interface SavedRedirect {
  id: string
  fromPath: string
  toPath: string
  statusCode: number
  enabled: boolean
  /** True when this replaced an existing rule rather than adding one. */
  replaced: boolean
}

export async function saveRedirectAction(
  input: SaveRedirectInput,
): Promise<ActionResult<SavedRedirect>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(saveSchema, input)
    if (!parsed.ok) return parsed

    // `saveRedirect` upserts, and an operator correcting a target deserves to
    // be told that is what happened rather than that a rule was added. Read
    // first: the timestamp comparison that would avoid this query is a guess
    // when a create and an update land in the same millisecond.
    const [existing] = await db
      .select({ id: redirects.id })
      .from(redirects)
      .where(eq(redirects.fromPath, normalizeRedirectPath(parsed.value.fromPath)))
      .limit(1)

    const row = await saveRedirect(parsed.value, {
      actorId: context.user.id,
      ipHash: context.request.ipHash,
    })

    revalidatePath('/admin/redirects')

    return actionOk({
      id: row.id,
      fromPath: row.fromPath,
      toPath: row.toPath,
      statusCode: row.statusCode,
      enabled: row.enabled,
      replaced: existing !== undefined,
    })
  } catch (error) {
    return describeActionError(error)
  }
}

export async function deleteRedirectAction(
  input: DeleteRedirectInput,
): Promise<ActionResult<{ id: string; removed: boolean }>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(deleteSchema, input)
    if (!parsed.ok) return parsed

    const removed = await deleteRedirect(parsed.value.id, {
      actorId: context.user.id,
      ipHash: context.request.ipHash,
    })

    revalidatePath('/admin/redirects')
    return actionOk({ id: parsed.value.id, removed })
  } catch (error) {
    return describeActionError(error)
  }
}

export interface ImportRedirectsResult {
  imported: number
  updated: number
  skipped: { line: number; reason: string; detail: string; raw: string }[]
  /** The file ended inside a quoted field, so the last row may be wrong. */
  unterminatedQuote: boolean
}

export async function importRedirectsAction(
  input: ImportRedirectsInput,
): Promise<ActionResult<ImportRedirectsResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(importSchema, input)
    if (!parsed.ok) return parsed

    const limit = await consumeRateLimit(`import:redirects:${context.user.id}`, RATE_LIMITS.import)
    if (!limit.allowed) {
      return actionFailure('Too many imports in the last hour.', {
        detail: `Try again in ${retryAfterSeconds(limit)} second(s).`,
        retryable: true,
      })
    }

    const report = await importRedirectsFromCsv(parsed.value.csv, {
      actorId: context.user.id,
      ipHash: context.request.ipHash,
    })

    revalidatePath('/admin/redirects')

    return actionOk({
      imported: report.imported,
      updated: report.updated,
      skipped: report.skipped.map((entry) => ({
        line: entry.line,
        reason: entry.reason,
        detail: entry.detail,
        raw: entry.raw,
      })),
      unterminatedQuote: report.unterminatedQuote,
    })
  } catch (error) {
    return describeActionError(error)
  }
}
