'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState, useTransition } from 'react'
import { toast } from 'sonner'

import {
  deleteTagAction,
  mergeTagAction,
  renameTagAction,
  tagMergeImpactAction,
  type TagActionResult,
} from '@/app/admin/actions/tags'
import {
  currentImpact,
  destinationFor,
  mergeConsequence,
  type ImpactState,
} from '@/lib/admin/tag-impact'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ActionResult } from '@/lib/admin/result'

/**
 * Rename, merge and delete, with the consequence stated before anything runs.
 *
 * All three rewrite the frontmatter of every document carrying the tag, so the
 * number of files is part of the question being asked, not a detail. And all
 * three can finish half-done — a file that cannot be locked is skipped while the
 * rest proceed — so the result panel reports what actually happened rather than
 * a tick: which documents were rewritten, which were not and why, and whether
 * the index was reconciled afterwards.
 *
 * That panel is the reason the run does not simply refresh the page it ran from.
 * This component is only ever rendered on one tag's page, and all three
 * operations can remove the tag that page is about, so a refresh after a
 * finished run asks for a 404 and discards the report with it. Only a run with a
 * failure in it left the page standing — a document that could not be written
 * still names the tag, so the row survives the prune — which is exactly
 * backwards: the clean run, where the toast is the only other confirmation there
 * is, was the one that ended on "Not found". `destinationFor` decides where the
 * operator goes instead, and it keeps them here whenever there is something to
 * read.
 */

export interface TagOperationTag {
  slug: string
  name: string
  /** Documents carrying the tag, at any status. */
  contentCount: number
  publishedCount: number
}

export function TagOperations({
  tag,
  others,
}: {
  tag: TagOperationTag
  /** Every other tag, for the merge target list. */
  others: { slug: string; name: string; contentCount: number }[]
}) {
  const [report, setReport] = useState<TagActionResult | null>(null)
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <RenameDialog
          tag={tag}
          onReport={setReport}
          onFailure={setFailure}
        />
        <MergeDialog tag={tag} others={others} onReport={setReport} onFailure={setFailure} />
        <DeleteDialog tag={tag} onReport={setReport} onFailure={setFailure} />
      </div>

      {failure ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {failure.message}
          {failure.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{failure.detail}</span>
          ) : null}
        </p>
      ) : null}

      {report ? <TagReport report={report} /> : null}
    </div>
  )
}

/**
 * What a run did, in full.
 *
 * The failure list is not collapsed into a count: a document that was skipped
 * is one whose tags now disagree with the rest, and the operator has to be able
 * to open it and fix it by hand.
 */
function TagReport({ report }: { report: TagActionResult }) {
  const verb =
    report.mode === 'delete' ? 'Removed from' : report.mode === 'merge' ? 'Merged in' : 'Renamed in'

  // A tag no document carries has no files to rewrite, so the operation renames
  // its row instead. "Renamed in 0 documents" was what this said before, which
  // is true and reads as a failure; the row is the tag in that case, and it now
  // says so.
  const sentence = report.renamedRow
    ? 'No document carried this tag, so the tag itself was renamed and nothing on disk changed.'
    : `${verb} ${report.written.length} document${report.written.length === 1 ? '' : 's'}.`

  return (
    <div className="border border-line bg-sunken px-4 py-3 text-sm">
      <p className="text-ink">
        {sentence}
        {!report.renamedRow && report.unchanged > 0
          ? ` ${report.unchanged} already read that way and were left alone.`
          : ''}
      </p>

      {report.failed.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-ink">
            {report.failed.length} document{report.failed.length === 1 ? '' : 's'} could not be
            written, so the change is incomplete:
          </p>
          <ul className="mt-2 space-y-1">
            {report.failed.map((entry) => (
              <li key={entry.path} className="text-xs text-ink-muted">
                <span className="font-mono">{entry.path}</span> — {entry.message}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-subtle">
            Run the same operation again once those files are writable; documents that already read
            the new way are left alone.
          </p>
        </div>
      ) : null}

      {!report.sync.ok ? (
        <p className="mt-3 border-t border-line pt-3 text-ink">
          The files were written, but the content index was not reconciled
          {report.sync.message ? `: ${report.sync.message}` : '.'} Until a sync runs, the site and
          these lists will still show the old tags.{' '}
          <Link href="/admin/system" className="text-brand underline underline-offset-2">
            Open System
          </Link>
          .
        </p>
      ) : null}
    </div>
  )
}

function useTagAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function run(
    action: () => Promise<ActionResult<TagActionResult>>,
    handlers: {
      onReport: (report: TagActionResult) => void
      onFailure: (failure: { message: string; detail?: string } | null) => void
      close: () => void
    },
  ) {
    handlers.onFailure(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        handlers.onFailure({ message: result.error, detail: result.detail })
        return
      }
      handlers.onReport(result.data)
      handlers.close()

      // Two things can be wrong with a run that returned rather than failed:
      // documents it could not write, and an index it could not reconcile. The
      // report says both — but the report is state on a page this run may be
      // about to leave, so the toast says them too. It is the one channel that
      // survives the navigation below, and without this the sync warning has no
      // other messenger at all.
      const warnings: string[] = []
      if (result.data.failed.length > 0) {
        warnings.push(
          `${result.data.failed.length} document(s) could not be written — see the report.`,
        )
      }
      if (!result.data.sync.ok) {
        warnings.push('The index was not reconciled, so the site still shows the old tags.')
      }
      toast.success('Tags updated.', {
        description: warnings.length > 0 ? warnings.join(' ') : undefined,
      })

      // Never a refresh of this page: the tag it is about may be the one the run
      // just removed, and a 404 would take the report — the thing the toast
      // above points at — with it. Next logs "the destination stream closed
      // early" when this happens; it is the aborted render of the page being
      // left behind, not a failure of the run.
      const destination = destinationFor({
        mode: result.data.mode,
        failed: result.data.failed.length,
        synced: result.data.sync.ok,
        toSlug: result.data.to?.slug ?? null,
      })

      if (destination) router.replace(destination)
      else router.refresh()
    })
  }

  return { pending, run }
}

function RenameDialog({
  tag,
  onReport,
  onFailure,
}: {
  tag: TagOperationTag
  onReport: (report: TagActionResult) => void
  onFailure: (failure: { message: string; detail?: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(tag.name)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const { pending, run } = useTagAction()
  const fieldId = useId()

  function submit() {
    if (!name.trim()) {
      setFieldError('A tag needs a name')
      return
    }
    setFieldError(null)
    run(() => renameTagAction({ slug: tag.slug, name: name.trim() }), {
      onReport,
      onFailure,
      close: () => setOpen(false),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" size="sm">
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename “{tag.name}”</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
              <p>
                Renaming rewrites the <span className="font-mono">tags:</span> list in the
                frontmatter of all {tag.contentCount} document
                {tag.contentCount === 1 ? '' : 's'} carrying it, then reconciles the index. The
                files are the source of truth, so anything less would be undone by the next sync.
              </p>
              <p>
                The tag&rsquo;s URL changes with its slug. A link to{' '}
                <span className="font-mono">/tags/{tag.slug}</span> stops resolving unless a
                redirect points at the new one.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor={fieldId}>New name</FieldLabel>
          <Input
            id={fieldId}
            value={name}
            autoComplete="off"
            aria-invalid={fieldError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
          <FieldDescription>
            The slug follows the name. Renaming onto an existing tag is a merge — use Merge for
            that.
          </FieldDescription>
          <FieldError>{fieldError ?? undefined}</FieldError>
        </Field>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? 'Renaming…' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MergeDialog({
  tag,
  others,
  onReport,
  onFailure,
}: {
  tag: TagOperationTag
  others: { slug: string; name: string; contentCount: number }[]
  onReport: (report: TagActionResult) => void
  onFailure: (failure: { message: string; detail?: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [into, setInto] = useState(others[0]?.slug ?? '')
  const [impact, setImpact] = useState<ImpactState>({ status: 'counting' })
  const { pending, run } = useTagAction()
  const fieldId = useId()
  const target = others.find((option) => option.slug === into)

  /*
    Ask what the merge would touch when the dialog opens and whenever the
    destination changes. The count is not a page-load figure: it is what the
    files would gain or lose, and it belongs to the tag selected now — which is
    why the answer is stored with the destination it was asked about, and why
    `cancelled` discards one that arrives after the selection moved on.
  */
  useEffect(() => {
    if (!open || !into) return

    let cancelled = false
    const asked = into

    void tagMergeImpactAction({ slug: tag.slug, into: asked }).then((result) => {
      if (cancelled) return
      setImpact(
        result.ok
          ? { status: 'counted', into: asked, impact: result.data }
          : { status: 'failed', into: asked },
      )
    })

    return () => {
      cancelled = true
    }
  }, [open, into, tag.slug])

  // The count is asked of the same function the rewrite reports through, so the
  // sentence and the run cannot disagree; `currentImpact` is what stops a count
  // for a tag that is no longer selected from being rendered beside the button.
  const consequence = currentImpact(impact, into)

  function submit() {
    if (!into) return
    run(() => mergeTagAction({ slug: tag.slug, into }), {
      onReport,
      onFailure,
      close: () => setOpen(false),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={others.length === 0}
          title={others.length === 0 ? 'There is no other tag to merge into' : undefined}
        >
          Merge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge “{tag.name}” into another tag</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
              <p>
                Every document carrying “{tag.name}” is rewritten to carry the tag you pick
                instead. A document that already carries both ends up with one.
              </p>
              <p>
                The files change, so this cannot be undone from here — each document keeps a
                revision you can restore individually from its own history.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor={fieldId}>Merge into</FieldLabel>
          <select
            id={fieldId}
            value={into}
            onChange={(event) => setInto(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {others.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.name} ({option.contentCount} document
                {option.contentCount === 1 ? '' : 's'})
              </option>
            ))}
          </select>
          <FieldDescription>
            {target ? mergeConsequence(tag, target, consequence) : 'Pick a destination tag.'}
          </FieldDescription>
        </Field>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={pending || !into}>
            {pending ? 'Merging…' : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({
  tag,
  onReport,
  onFailure,
}: {
  tag: TagOperationTag
  onReport: (report: TagActionResult) => void
  onFailure: (failure: { message: string; detail?: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const { pending, run } = useTagAction()

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete the tag “{tag.name}”?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
              <p>
                The tag is removed from the <span className="font-mono">tags:</span> list of all{' '}
                {tag.contentCount} document{tag.contentCount === 1 ? '' : 's'} carrying it, and the
                tag row is dropped once nothing references it. The documents themselves are kept.
              </p>
              <p>
                <span className="font-mono">/tags/{tag.slug}</span> will stop resolving. Deleting
                a tag is not reversible from here.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => run(() => deleteTagAction({ slug: tag.slug }), {
            onReport,
            onFailure,
            close: () => setOpen(false),
          })} disabled={pending}>
            {pending ? 'Deleting…' : 'Delete tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
