'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { MAX_NAVIGATION_ITEMS, NAVIGATION_LOCATIONS, saveNavigation } from '@/lib/navigation'
import { actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'

/**
 * Saving one menu.
 *
 * `saveNavigation` replaces the menu rather than merging into it, in a
 * transaction that deletes the old rows and inserts the new ones together — so a
 * half-written menu cannot exist. It validates each item itself (an href that
 * disagrees with its `external` flag is the case worth catching) and records the
 * audit row, which is why this action adds neither.
 *
 * The validation here is only about the shape: an unvalidated array of objects
 * crossing the action boundary is the one thing the module cannot check for
 * itself, because by the time it sees the items they are already typed.
 */

const itemSchema = z.object({
  label: z.string().trim().min(1, 'An item needs a label').max(80),
  href: z.string().trim().min(1, 'An item needs a destination').max(2048),
  visible: z.boolean(),
  external: z.boolean(),
  icon: z.string().trim().max(60).nullable(),
})

const saveSchema = z.object({
  location: z.enum(NAVIGATION_LOCATIONS),
  items: z.array(itemSchema).max(MAX_NAVIGATION_ITEMS),
})

export type SaveNavigationInput = z.output<typeof saveSchema>

export interface SavedNavigation {
  location: string
  items: { id: string; label: string; href: string; visible: boolean }[]
}

export async function saveNavigationAction(
  input: SaveNavigationInput,
): Promise<ActionResult<SavedNavigation>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(saveSchema, input)
    if (!parsed.ok) return parsed

    const saved = await saveNavigation(parsed.value.location, parsed.value.items, {
      actorId: context.user.id,
      ipHash: context.request.ipHash,
    })

    revalidatePath('/admin/navigation')
    return actionOk({
      location: parsed.value.location,
      items: saved.map((item) => ({
        id: item.id,
        label: item.label,
        href: item.href,
        visible: item.visible,
      })),
    })
  } catch (error) {
    return describeActionError(error)
  }
}
