'use server'

import { revalidatePath } from 'next/cache'

import { SETTINGS_KEYS, settingsPatchSchema, type Settings, updateSettings } from '@/lib/settings'
import { actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'

/**
 * Saving site settings.
 *
 * A patch, not a whole object: the form sends only the fields that changed, so
 * two operators editing different sections do not overwrite each other, and a
 * field this page does not render cannot be wiped by saving it. The strict patch
 * schema means a key that is not in `settingsSchema` is refused rather than
 * dropped, which is what makes "saved" mean something.
 *
 * `updateSettings` records the `settings.update` audit row and purges the cached
 * settings itself, so neither happens here.
 */

export interface SettingsSaved {
  /** The keys this call wrote, for a receipt the operator can read. */
  keys: string[]
  /** The settings as they now stand, read back from the row that was written. */
  settings: Settings
}

export async function updateSettingsAction(
  patch: unknown,
): Promise<ActionResult<SettingsSaved>> {
  try {
    const context = await guardAction()

    const parsed = parseActionInput(settingsPatchSchema, patch)
    if (!parsed.ok) return parsed

    // A patch that touches nothing is a client bug — the form disables Save
    // until something changes — and answering it with a success would say
    // "saved" about a write that did not happen.
    const keys = Object.keys(parsed.value)
    if (keys.length === 0) {
      return {
        ok: false,
        error: 'Nothing changed, so nothing was written.',
        detail: `Writable settings: ${SETTINGS_KEYS.join(', ')}`,
      }
    }

    const settings = await updateSettings(parsed.value, {
      actorId: context.user.id,
      ipHash: context.request.ipHash,
    })

    revalidatePath('/admin/settings')

    return actionOk({ keys, settings })
  } catch (error) {
    return describeActionError(error)
  }
}
