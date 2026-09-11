'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useState, useTransition } from 'react'
import { toast } from 'sonner'

import {
  assetUsageAction,
  deleteAssetAction,
  updateAssetAltAction,
  type AssetUsageReport,
} from '@/app/admin/actions/assets'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/**
 * The three things that happen to an asset: its URL is copied, its alt text is
 * corrected, or it is deleted.
 *
 * Delete is the one with a consequence, so it asks the server what references
 * the asset before it offers to go ahead — and if anything does, it lists the
 * documents with links rather than refusing and leaving the operator to find
 * them. Deleting a referenced asset stays possible, because a typo'd upload that
 * only a draft mentions is exactly the case a strict refusal gets wrong.
 */

export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setFailed(false)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // `navigator.clipboard` is unavailable over plain HTTP and in some
      // browsers' private modes. The URL is on screen next to this button, so
      // the honest thing is to say the copy did not happen rather than to
      // pretend it did.
      setFailed(true)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy URL'}
      </Button>
      {failed ? (
        <span role="status" className="text-xs text-ink-muted">
          Copy blocked — select it from the field
        </span>
      ) : null}
    </span>
  )
}

export function AltTextForm({ id, alt }: { id: string; alt: string | null }) {
  const router = useRouter()
  const [value, setValue] = useState(alt ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fieldId = useId()
  const dirty = value !== (alt ?? '')

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await updateAssetAltAction({ id, alt: value })
      if (!result.ok) {
        setError(result.fieldErrors?.alt ?? result.error)
        return
      }
      toast.success(value ? 'Alt text saved.' : 'Alt text cleared.')
      router.refresh()
    })
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <Field className="min-w-[16rem] flex-1">
        <FieldLabel htmlFor={fieldId}>Alt text</FieldLabel>
        <Input
          id={fieldId}
          value={value}
          maxLength={500}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
        />
        <FieldDescription>
          Describes the image to a reader who cannot see it. Also what an unused-asset search matches
          on.
        </FieldDescription>
        <FieldError>{error ?? undefined}</FieldError>
      </Field>
      <Button type="submit" variant="secondary" size="sm" disabled={pending || !dirty}>
        {pending ? 'Saving…' : 'Save alt'}
      </Button>
    </form>
  )
}

export function DeleteAssetButton({
  id,
  filename,
  view = 'list',
}: {
  id: string
  filename: string
  /** Where the button lives, so the dialog's wording fits the space. */
  view?: 'list' | 'detail'
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<AssetUsageReport | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [checking, startCheck] = useTransition()
  const [pending, startDelete] = useTransition()

  function openDialog() {
    setOpen(true)
    setUsage(null)
    setCheckError(null)
    setDeleteError(null)
    startCheck(async () => {
      const result = await assetUsageAction({ id })
      if (!result.ok) setCheckError(result.error)
      else setUsage(result.data)
    })
  }

  function confirm(force: boolean) {
    setDeleteError(null)
    startDelete(async () => {
      const result = await deleteAssetAction({ id, force })
      if (!result.ok) {
        setDeleteError(result.detail ? `${result.error} ${result.detail}` : result.error)
        return
      }
      setOpen(false)
      toast.success(`Deleted ${filename}.`, {
        description:
          result.data.fileErrors.length > 0
            ? `The database row is gone; ${result.data.fileErrors.length} file(s) could not be removed from disk.`
            : undefined,
      })
      router.refresh()
    })
  }

  const referenced = usage !== null && (usage.documents.length > 0 || usage.usedAsSiteAvatar)

  return (
    <>
      <Button
        type="button"
        variant={view === 'detail' ? 'destructive' : 'ghost'}
        size="sm"
        onClick={openDialog}
      >
        Delete
      </Button>

      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {filename}?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
                <p>
                  The database row and the stored files are removed. Shard directories are left in
                  place.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          {checking ? <p className="text-sm text-ink-muted">Checking what references it…</p> : null}

          {checkError ? (
            <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
              {checkError} The check could not be completed, so nothing is known about what uses this
              file.
            </p>
          ) : null}

          {usage && !referenced ? (
            <p className="text-sm text-ink">
              Nothing references it: no document links to it, no frontmatter points at it, and it is
              not the site avatar.
            </p>
          ) : null}

          {referenced && usage ? (
            <div className="border-l-2 border-warning pl-3">
              <p className="text-sm text-ink">
                {usage.documents.length > 0
                  ? `${usage.documents.length} document${usage.documents.length === 1 ? '' : 's'} still point at this file. Deleting it will leave ${usage.documents.length === 1 ? 'that page' : 'those pages'} with a broken image.`
                  : 'The site avatar points at this file.'}
              </p>
              {usage.usedAsSiteAvatar ? (
                <p className="mt-2 text-sm text-ink">
                  It is also the configured site avatar —{' '}
                  <Link href="/admin/settings" className="text-brand underline underline-offset-2">
                    change that in Settings
                  </Link>{' '}
                  first if you want the avatar to keep working.
                </p>
              ) : null}
              <ul className="mt-2 space-y-1">
                {usage.documents.map((document) => (
                  <li key={`${document.id}-${document.via}`} className="text-sm">
                    <Link
                      href={document.href}
                      className="text-brand underline underline-offset-2"
                    >
                      {document.title}
                    </Link>{' '}
                    <span className="text-xs text-ink-muted">
                      {document.status} · referenced as{' '}
                      {document.via === 'link'
                        ? 'a link in the body'
                        : document.via === 'cover'
                          ? 'the cover'
                          : 'the social image'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {deleteError ? (
            <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
              {deleteError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            {referenced ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => confirm(true)}
                disabled={pending || checking}
              >
                {pending ? 'Deleting…' : 'Delete anyway'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                onClick={() => confirm(false)}
                disabled={pending || checking || usage === null}
              >
                {pending ? 'Deleting…' : 'Delete'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
