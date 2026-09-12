import 'server-only'

import { cache } from 'react'
import { revalidatePath, revalidateTag } from 'next/cache'
import { eq, sql } from 'drizzle-orm'
import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { siteSettings } from '@/lib/db/schema'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  isSettingsKey,
  settingsPatchSchema,
  settingsSchema,
  type Settings,
  type SettingsKey,
  type SettingsPatch,
} from './schema'

/**
 * Typed access to the single `site_settings` row.
 *
 * Reads merge the stored row over `SETTINGS_DEFAULTS`, so a site that has never
 * been seeded — and a site where one column is still untouched — both produce a
 * complete settings object rather than a field that is `undefined` at the point
 * a component renders it.
 */

export {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  isSettingsKey,
  settingsPatchSchema,
  settingsSchema,
}
export type { Settings, SettingsKey, SettingsPatch }

/**
 * Cache tag for anything that renders settings.
 *
 * The reading side tags its cached work with this; the write side below is the
 * only thing that purges it.
 */
export const SETTINGS_CACHE_TAG = 'settings'

/** The singleton row's fixed primary key, enforced by a check constraint. */
const SETTINGS_ROW_ID = 'default'

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type SettingsErrorReason =
  /** The patch did not match the schema. */
  | 'invalid_patch'
  /** A key that is not in `SETTINGS_KEYS`. */
  | 'unknown_key'
  /** A single value that did not match its field. */
  | 'invalid_value'
  /** The stored row does not match the schema, so it cannot be trusted. */
  | 'stored_invalid'

export class SettingsError extends Error {
  readonly code = 'SETTINGS'
  readonly reason: SettingsErrorReason
  /** One line per problem, suitable for a form error summary. */
  readonly issues: readonly string[]

  constructor(
    reason: SettingsErrorReason,
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message)
    this.name = 'SettingsError'
    this.reason = reason
    this.issues = issues
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  )
}

/**
 * Stored values over defaults.
 *
 * `undefined` is skipped rather than spread: `{ ...defaults, ...{ siteName:
 * undefined } }` erases the default, and a column that is absent from a partial
 * select would do exactly that.
 */
function mergeSettings(stored: Record<string, unknown> | undefined): Settings {
  const merged: Record<string, unknown> = { ...SETTINGS_DEFAULTS }
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (value !== undefined) merged[key] = value
  }

  const parsed = settingsSchema.safeParse(merged)
  if (!parsed.success) {
    // Reached only by a row written outside this module — every write goes
    // through the patch schema — so the shape of the configuration is unknown.
    // Falling back to defaults here would quietly discard the site's real
    // settings, which is a worse outcome than a loud failure.
    throw new SettingsError(
      'stored_invalid',
      'The stored site settings do not match the settings schema. Fix the row in site_settings or re-save the settings page.',
      describeIssues(parsed.error.issues),
    )
  }
  return parsed.data
}

/**
 * The site's settings for this request.
 *
 * Memoised with React `cache`, which is scoped to a single request: a layout,
 * a page and several components that all read settings cost one query, and
 * nothing survives into the next request. That per-request scope is also why
 * `updateSettings` does not read through here — see its note.
 */
export const getSettings = cache(async (): Promise<Settings> => {
  const [row] = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.id, SETTINGS_ROW_ID))
    .limit(1)

  return mergeSettings(row)
})

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface SettingsWriteContext {
  /** `users.id` of the account making the change, for the audit row. */
  actorId?: string | null
  /** Hashed IP from `getRequestContext()`. Never the raw address. */
  ipHash?: string | null
}

/**
 * Purge the caches that render settings.
 *
 * Inside a request this is the whole mechanism by which a change becomes
 * visible. Outside one — a CLI script, a test — Next throws for lack of a
 * request to revalidate against, and the write has already committed by then.
 * Failing the call at that point would report a successful change as a failed
 * one, so the failure is logged instead, with what it costs: pages keep serving
 * the old settings until their own timeout expires.
 */
function revalidateSettings(): void {
  try {
    revalidateTag(SETTINGS_CACHE_TAG, 'max')
    // The header, the footer and the SEO template all come from settings, and
    // they are part of the root layout rather than of any one page.
    revalidatePath('/', 'layout')
  } catch (error) {
    console.error('[settings] cache purge did not run; pages may be stale', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Write the keys present in `patch` and leave the rest alone.
 *
 * Returns the settings as they now stand, read back from the row this call
 * wrote. It deliberately does not re-read through `getSettings`: that memo holds
 * the pre-write value for the rest of the request, so returning it would report
 * the change as lost.
 *
 * `custom` is merged into the existing blob rather than replacing it. A patch
 * that replaces it would delete every custom key the caller did not mention,
 * which is the same failure the strict patch schema exists to prevent for
 * ordinary keys.
 */
export async function updateSettings(
  patch: SettingsPatch,
  context: SettingsWriteContext = {},
): Promise<Settings> {
  const parsed = settingsPatchSchema.safeParse(patch)
  if (!parsed.success) {
    throw new SettingsError(
      'invalid_patch',
      'The settings patch is not valid.',
      describeIssues(parsed.error.issues),
    )
  }

  const values: Partial<typeof siteSettings.$inferInsert> = { ...parsed.data }
  const customPatch = values.custom
  delete values.custom

  const keys = Object.keys(values)
  if (keys.length === 0 && !customPatch) return getSettings()

  const written = await db
    .insert(siteSettings)
    .values({
      id: SETTINGS_ROW_ID,
      ...values,
      // Nothing to merge with on the insert path: this is the first write to a
      // site that has no row yet.
      ...(customPatch ? { custom: customPatch } : {}),
    })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: {
        ...values,
        ...(customPatch
          ? {
              // `||` is a shallow merge, and that is the intended depth: custom
              // keys are flat by validation.
              custom: sql`${siteSettings.custom} || ${JSON.stringify(customPatch)}::jsonb`,
            }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning()

  const settings = mergeSettings(written[0])

  await recordAudit({
    action: 'settings.update',
    actorId: context.actorId ?? null,
    targetType: 'settings',
    targetId: SETTINGS_ROW_ID,
    metadata: {
      keys: [...keys, ...(customPatch ? ['custom'] : [])],
    },
    request: context.ipHash ? { ipHash: context.ipHash } : null,
  })

  revalidateSettings()

  return settings
}
