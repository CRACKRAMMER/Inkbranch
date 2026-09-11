'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAudit } from '@/lib/audit'
import { RATE_LIMITS, consumeRateLimit, retryAfterSeconds } from '@/lib/auth/rate-limit'
import { deleteAsset, type AssetUsage } from '@/lib/assets/manage'
import { assetUrl, storeAsset } from '@/lib/assets/storage'
import { db } from '@/lib/db'
import { assets, type AssetRow } from '@/lib/db/schema'
import { actionFailure, actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'

/**
 * Uploading, editing and deleting assets.
 *
 * Uploads are rate limited per account, not per address: the cost they impose is
 * a re-encode on the server, and the account is what a limit on that cost
 * belongs to. The limit is generous — an article's worth of screenshots in one
 * sitting is normal — and its purpose is to stop a stuck client from filling the
 * disk in a loop.
 */

export interface UploadedAsset {
  id: string
  url: string
  /** Markdown to drop into a document. */
  markdown: string
  filename: string
  width: number | null
  height: number | null
  size: number
  /** False when these exact bytes were already stored. */
  created: boolean
  /** What the store did while preparing the bytes, in plain words. */
  notes: string[]
}

/**
 * Store an upload from a form.
 *
 * Takes `FormData` rather than a plain object because a `File` cannot be sent
 * through the action boundary's serialisation any other way — and the file is
 * the point.
 */
export async function uploadAssetAction(
  formData: FormData,
): Promise<ActionResult<UploadedAsset>> {
  try {
    const context = await guardAction()

    const limit = await consumeRateLimit(`upload:user:${context.user.id}`, RATE_LIMITS.upload)
    if (!limit.allowed) {
      return actionFailure('Too many uploads in the last minute.', {
        detail: `Try again in ${retryAfterSeconds(limit)} second(s).`,
        retryable: true,
      })
    }

    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return actionFailure('No file arrived with that upload.')
    }

    const alt = formData.get('alt')
    const parsedAlt = z.string().trim().max(500).safeParse(typeof alt === 'string' ? alt : '')
    if (!parsedAlt.success) {
      return actionFailure('Alt text is limited to 500 characters.', {
        fieldErrors: { alt: 'At most 500 characters' },
      })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const stored = await storeAsset({
      buffer: bytes,
      originalFilename: file.name,
      ownerId: context.user.id,
      alt: parsedAlt.data || null,
    })

    await recordAudit({
      action: 'asset.upload',
      actorId: context.user.id,
      targetType: 'asset',
      targetId: stored.asset.id,
      metadata: {
        path: stored.asset.path,
        mime: stored.asset.mime,
        size: stored.asset.size,
        created: stored.created,
        filename: stored.asset.filename,
      },
      request: context.request,
    })

    revalidatePath('/admin/assets')

    return actionOk(toUploaded(stored.asset, stored.created, stored.notes))
  } catch (error) {
    return describeActionError(error)
  }
}

function toUploaded(asset: AssetRow, created: boolean, notes: string[]): UploadedAsset {
  const url = asset.url || assetUrl(asset.path)
  const alt = asset.alt ?? ''
  const markdown = alt ? `![${alt}](${url})` : `![](${url})`
  return {
    id: asset.id,
    url,
    markdown,
    filename: asset.filename,
    width: asset.width,
    height: asset.height,
    size: asset.size,
    created,
    notes,
  }
}

const updateAltSchema = z.object({
  id: z.uuid(),
  alt: z.string().trim().max(500),
})

export type UpdateAltInput = z.output<typeof updateAltSchema>

/** Set an asset's alt text. Not audited: `AUDIT_ACTIONS` has no entry for an edit. */
export async function updateAssetAltAction(
  input: UpdateAltInput,
): Promise<ActionResult<{ id: string; alt: string | null }>> {
  try {
    await guardAction()
    const parsed = parseActionInput(updateAltSchema, input)
    if (!parsed.ok) return parsed

    const [updated] = await db
      .update(assets)
      .set({ alt: parsed.value.alt || null })
      .where(eq(assets.id, parsed.value.id))
      .returning({ id: assets.id, alt: assets.alt })

    if (!updated) return actionFailure('That asset no longer exists.')

    revalidatePath('/admin/assets')
    return actionOk(updated)
  } catch (error) {
    return describeActionError(error)
  }
}

const deleteSchema = z.object({
  id: z.uuid(),
  force: z.boolean().optional(),
})

export type DeleteAssetInput = z.output<typeof deleteSchema>

export interface DeletedAsset {
  id: string
  path: string
  forced: boolean
  filesRemoved: number
  /** Files that stayed behind, with the reason. Not fatal, but worth saying. */
  fileErrors: { path: string; message: string }[]
  /** Documents that still referenced it, when the delete was forced. */
  stillReferenced: AssetUsage
}

export async function deleteAssetAction(
  input: DeleteAssetInput,
): Promise<ActionResult<DeletedAsset>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(deleteSchema, input)
    if (!parsed.ok) return parsed

    const result = await deleteAsset(parsed.value.id, {
      force: parsed.value.force,
      actorId: context.user.id,
    })

    revalidatePath('/admin/assets')
    return actionOk({
      id: result.asset.id,
      path: result.asset.path,
      forced: result.forced,
      filesRemoved: result.filesRemoved.length,
      fileErrors: result.fileErrors,
      stillReferenced: result.usage,
    })
  } catch (error) {
    // `AssetInUseError` carries the referencing documents, and `describeActionError`
    // names them — which is the whole reason the delete is not simply refused.
    return describeActionError(error)
  }
}
