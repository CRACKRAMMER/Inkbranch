'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'

import { uploadAssetAction, type UploadedAsset } from '@/app/admin/actions/assets'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils/cn'

/**
 * Upload, by picking files or by dropping them.
 *
 * A drop target rather than a bare file input because the files being uploaded
 * are usually already on screen — a screenshot on the desktop, an export from
 * another window — and dragging one in is the gesture people reach for.
 *
 * The alt text applies to every file in the batch, which is a compromise: alt
 * text is per-image and only the author knows what each one shows. It is offered
 * because an image with no alt text is worse than one with an approximate
 * description, and each file's alt can be corrected afterwards from the list.
 */

const ACCEPT = 'image/*,video/*,application/pdf,.zip,.txt,.md'

export function AssetUpload() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [alt, setAlt] = useState('')
  const [dragging, setDragging] = useState(false)
  const [results, setResults] = useState<UploadedAsset[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  function send(files: File[]) {
    if (files.length === 0) return
    setResults([])
    setErrors([])

    startTransition(async () => {
      const uploaded: UploadedAsset[] = []
      const failed: string[] = []

      // Sequential rather than `Promise.all`: the rate limit counts each upload,
      // and a batch that fires twenty at once turns a limit meant to stop a
      // runaway client into a limit that rejects a legitimate paste.
      for (const file of files) {
        const formData = new FormData()
        formData.set('file', file)
        formData.set('alt', alt)

        const result = await uploadAssetAction(formData)
        if (result.ok) uploaded.push(result.data)
        else failed.push(`${file.name}: ${result.error}`)
      }

      setResults(uploaded)
      setErrors(failed)
      if (inputRef.current) inputRef.current.value = ''

      if (uploaded.length > 0) {
        toast.success(`Stored ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}.`)
        router.refresh()
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} file${failed.length === 1 ? '' : 's'} were not stored.`)
      }
    })
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          send(Array.from(event.dataTransfer.files))
        }}
        className={cn(
          'border border-dashed px-4 py-6 text-center',
          dragging ? 'border-brand bg-brand-quiet' : 'border-line-strong bg-sunken',
        )}
      >
        <p className="text-sm text-ink">Drop files here, or</p>
        <div className="mt-3 flex flex-wrap items-end justify-center gap-3">
          <Field className="w-64 text-left">
            <FieldLabel htmlFor="asset-alt">Alt text for this batch</FieldLabel>
            <Input
              id="asset-alt"
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
              placeholder="What the image shows"
              autoComplete="off"
              disabled={pending}
            />
            <FieldDescription>
              Applied to every file below. Correct any of them from the list afterwards.
            </FieldDescription>
          </Field>

          <div>
            <input
              ref={inputRef}
              id="asset-files"
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(event) => send(Array.from(event.target.files ?? []))}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => inputRef.current?.click()}
            >
              {pending ? 'Uploading…' : 'Choose files'}
            </Button>
          </div>
        </div>
      </div>

      {errors.length > 0 ? (
        <ul role="alert" className="space-y-1 border-l-2 border-danger pl-3 text-sm text-ink">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {results.length > 0 ? (
        <div className="border border-line">
          <p className="border-b border-line bg-sunken px-3 py-2 text-xs text-ink-muted">
            {results.length} file{results.length === 1 ? '' : 's'} stored. The Markdown below is what
            the editor inserts — paste it anywhere, here or in another tool.{' '}
            <span className="text-ink-subtle">
              {results.some((asset) => !asset.created)
                ? 'Identical bytes were already stored, so an existing file was reused rather than uploaded twice.'
                : null}
            </span>
          </p>
          <ul className="divide-y divide-line">
            {results.map((asset) => (
              <li key={asset.id} className="px-3 py-2 text-sm">
                <span className="text-ink">{asset.filename}</span>
                {asset.notes.length > 0 ? (
                  <span className="ml-2 text-xs text-ink-muted">{asset.notes.join(' · ')}</span>
                ) : null}
                <code className="mt-1 block break-all font-mono text-xs text-ink-muted">
                  {asset.markdown}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
