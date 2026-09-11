'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'

import {
  deleteRedirectAction,
  importRedirectsAction,
  saveRedirectAction,
  type ImportRedirectsResult,
} from '@/app/admin/actions/redirects'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ActionResult } from '@/lib/admin/result'

/**
 * The redirect form, its row-level delete, and the CSV importer.
 *
 * One component for the form because a redirect is created and corrected the
 * same way — the source path is the identity, so "edit" is "save this source
 * path again" and the server upserts. The dialog says which of the two it will
 * be, because an operator about to overwrite a rule should know that is what
 * they are doing.
 */

const STATUS_CODES = [
  { value: 301, label: '301 — moved permanently' },
  { value: 302, label: '302 — found (temporary)' },
  { value: 307, label: '307 — temporary, keeps the method' },
  { value: 308, label: '308 — permanent, keeps the method' },
]

export interface RedirectFormValues {
  id: string | null
  fromPath: string
  toPath: string
  statusCode: number
  enabled: boolean
  note: string
}

const EMPTY: RedirectFormValues = {
  id: null,
  fromPath: '',
  toPath: '',
  statusCode: 301,
  enabled: true,
  note: '',
}

export function RedirectForm({
  initial,
  onDone,
  compact = false,
}: {
  initial?: RedirectFormValues
  onDone?: () => void
  compact?: boolean
}) {
  const router = useRouter()
  const [values, setValues] = useState<RedirectFormValues>(initial ?? EMPTY)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const ids = useId()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveRedirectAction({
        fromPath: values.fromPath,
        toPath: values.toPath,
        statusCode: values.statusCode,
        enabled: values.enabled,
        note: values.note.trim() || null,
      })
      if (!result.ok) {
        setError({
          message: result.error,
          detail: [result.fieldErrors ? Object.values(result.fieldErrors).join('; ') : '', result.detail]
            .filter(Boolean)
            .join(' — '),
        })
        return
      }
      toast.success(result.data.replaced ? 'Redirect updated.' : 'Redirect added.', {
        description: `${result.data.fromPath} → ${result.data.toPath}`,
      })
      setValues(EMPTY)
      onDone?.()
      router.refresh()
    })
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className={compact ? 'space-y-3' : 'flex flex-wrap items-end gap-3'}>
        <Field className="min-w-[13rem] flex-1">
          <FieldLabel htmlFor={`${ids}-from`}>From</FieldLabel>
          <Input
            id={`${ids}-from`}
            value={values.fromPath}
            placeholder="/old-url"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setValues((v) => ({ ...v, fromPath: event.target.value }))}
          />
        </Field>
        <Field className="min-w-[13rem] flex-1">
          <FieldLabel htmlFor={`${ids}-to`}>To</FieldLabel>
          <Input
            id={`${ids}-to`}
            value={values.toPath}
            placeholder="/new-url or https://elsewhere.example"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setValues((v) => ({ ...v, toPath: event.target.value }))}
          />
        </Field>
      </div>

      <div className={compact ? 'space-y-3' : 'flex flex-wrap items-end gap-3'}>
        <Field className="w-64">
          <FieldLabel htmlFor={`${ids}-status`}>Status</FieldLabel>
          <select
            id={`${ids}-status`}
            value={values.statusCode}
            onChange={(event) =>
              setValues((v) => ({ ...v, statusCode: Number(event.target.value) }))
            }
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {STATUS_CODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field className="min-w-[12rem] flex-1">
          <FieldLabel htmlFor={`${ids}-note`}>Note</FieldLabel>
          <Input
            id={`${ids}-note`}
            value={values.note}
            placeholder="Why this exists"
            autoComplete="off"
            onChange={(event) => setValues((v) => ({ ...v, note: event.target.value }))}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => setValues((v) => ({ ...v, enabled: event.target.checked }))}
            className="size-3.5 accent-[var(--color-brand)]"
          />
          Enabled
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Add redirect'}
        </Button>
        {values.fromPath ? (
          <span className="font-mono text-xs text-ink-subtle">
            {values.fromPath} → {values.toPath || '…'}
          </span>
        ) : null}
      </div>

      <FieldDescription>
        The from path is a request path on this site, and it is what identifies the rule — saving
        the same one again corrects it. A chain that would loop, or that runs longer than ten hops,
        is refused.
      </FieldDescription>

      {error ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {error.message}
          {error.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{error.detail}</span>
          ) : null}
        </p>
      ) : null}
    </form>
  )
}

export function EditRedirectDialog({ redirect }: { redirect: RedirectFormValues }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit the redirect for {redirect.fromPath}</DialogTitle>
            <DialogDescription>
              The source path identifies the rule and cannot be renamed here; a different source is a
              different redirect.
            </DialogDescription>
          </DialogHeader>
          <RedirectForm initial={redirect} compact onDone={() => setOpen(false)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function DeleteRedirectButton({ id, fromPath }: { id: string; fromPath: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete the redirect on {fromPath}?</DialogTitle>
            <DialogDescription>
              Requests to <span className="font-mono">{fromPath}</span> will 404 again until another
              rule or a document serves that path.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteRedirectAction({ id })
                  if (!result.ok) {
                    setError(result.error)
                    return
                  }
                  setOpen(false)
                  toast.success('Redirect deleted.')
                  router.refresh()
                })
              }
            >
              {pending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function RedirectImport() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [report, setReport] = useState<ImportRedirectsResult | null>(null)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  function run(csv: string) {
    setError(null)
    setReport(null)
    startTransition(async () => {
      const result: ActionResult<ImportRedirectsResult> = await importRedirectsAction({ csv })
      if (!result.ok) {
        setError({ message: result.error, detail: result.detail })
        return
      }
      setReport(result.data)
      toast.success(
        `${result.data.imported} added, ${result.data.updated} updated, ${result.data.skipped.length} skipped.`,
      )
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel htmlFor={`${ids}-csv`}>CSV</FieldLabel>
        <textarea
          id={`${ids}-csv`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={'/old-url,/new-url,301\n/another,https://example.com/x'}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs text-ink"
        />
        <FieldDescription>
          One <span className="font-mono">from,to[,status]</span> per line. A header row is ignored.
          The whole file is checked before anything is written, so one bad row does not stop the
          rest — it is reported instead.
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending || text.trim().length === 0}
          onClick={() => run(text)}
        >
          {pending ? 'Importing…' : 'Import pasted rows'}
        </Button>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            const content = await file.text()
            setText(content)
            run(content)
            if (fileRef.current) fileRef.current.value = ''
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => fileRef.current?.click()}
        >
          Choose a .csv file
        </Button>
      </div>

      {error ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {error.message}
          {error.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{error.detail}</span>
          ) : null}
        </p>
      ) : null}

      {report ? (
        <div className="border border-line bg-sunken px-4 py-3 text-sm">
          <p className="text-ink">
            {report.imported} added, {report.updated} updated, {report.skipped.length} skipped.
          </p>
          {report.unterminatedQuote ? (
            <p className="mt-2 border-t border-line pt-2 text-ink">
              The file ends inside a quoted field, so the last row may have been read wrong. Check it
              and re-import that row.
            </p>
          ) : null}
          {report.skipped.length > 0 ? (
            <ul className="mt-2 space-y-1 border-t border-line pt-2">
              {report.skipped.map((entry) => (
                <li key={`${entry.line}-${entry.reason}`} className="text-xs text-ink-muted">
                  <span className="font-mono">line {entry.line}</span> · {entry.reason} — {entry.detail}
                  {entry.raw ? (
                    <span className="mt-0.5 block font-mono text-ink-subtle">{entry.raw}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
