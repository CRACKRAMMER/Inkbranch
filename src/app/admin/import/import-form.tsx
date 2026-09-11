'use client'

import { useActionState, useRef, useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CONTENT_TYPES, type ContentType } from '@/lib/content/schema'
import { importAction, type ImportState } from './actions'

/**
 * The import form: source, report, confirm.
 *
 * The whole payload is assembled by hand rather than by a native form
 * submission. That is not gratuitous: the confirm step has to send the *same*
 * source that produced the report, and React resets an uncontrolled form after a
 * form action runs, which would clear the file input between the scan and the
 * confirm and leave the operator confirming a report they could no longer
 * reproduce. Keeping the files in state and building `FormData` here means both
 * submissions carry the same bytes, and the fingerprint check on the server has
 * something stable to compare.
 *
 * The two buttons differ in exactly one field — `intent` — and Confirm is only
 * rendered once there is a report to confirm.
 */

const TYPE_LABELS: Record<ContentType, string> = {
  post: 'Post',
  note: 'Note',
  project: 'Project',
}

/** Next's server-action body limit, which no file here can exceed. */
const SERVER_ACTION_LIMIT = '1 MiB'

export function ImportForm() {
  const [state, formAction, isPending] = useActionState<ImportState | undefined, FormData>(
    importAction,
    undefined,
  )
  const [, startTransition] = useTransition()

  const [source, setSource] = useState<'upload' | 'directory'>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [directory, setDirectory] = useState('')
  const [type, setType] = useState<ContentType>('note')
  const [overwrite, setOverwrite] = useState(false)
  const [titleFix, setTitleFix] = useState(false)

  const formRef = useRef<HTMLFormElement>(null)
  // Which button submitted. A ref rather than state, because it has to be read
  // in the same tick the submit happens; it resets to `scan` after each use, so
  // an implicit submit (Enter) can never apply anything.
  const intent = useRef<'scan' | 'apply'>('scan')
  // The same thing for the labels, which do have to survive the render that the
  // pending state causes.
  const [running, setRunning] = useState<'scan' | 'apply' | null>(null)

  const report = state?.report
  const applied = state?.applied
  const importable = report ? report.counts.create + report.counts.overwrite : 0

  function submit(): void {
    const chosen = intent.current
    intent.current = 'scan'
    setRunning(chosen)

    const data = new FormData()
    data.set('intent', chosen)
    data.set('source', source)
    data.set('type', type)
    if (overwrite) data.set('overwrite', 'on')
    if (titleFix) data.set('titleFix', 'on')
    data.set('directory', directory)
    for (const file of files) data.append('files', file)
    if (chosen === 'apply' && report) data.set('fingerprint', report.fingerprint)

    startTransition(() => formAction(data))
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="flex flex-col gap-8"
    >
      <fieldset className="flex flex-col gap-4" disabled={isPending}>
        <legend className="mb-1 text-xs font-medium text-ink-muted">Where the files are</legend>

        <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
          <SourceChoice
            id="source-upload"
            label="Upload files"
            checked={source === 'upload'}
            onSelect={() => setSource('upload')}
          />
          <SourceChoice
            id="source-directory"
            label="Scan a directory on the server"
            checked={source === 'directory'}
            onSelect={() => setSource('directory')}
          />
        </div>

        {source === 'upload' ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="files">Markdown files or one ZIP archive</Label>
            <input
              id="files"
              type="file"
              multiple
              accept=".md,.markdown,.zip"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              className="text-sm text-ink-muted file:mr-3 file:border file:border-line file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink"
            />
            <p className="text-xs leading-relaxed text-ink-muted">
              {files.length > 0
                ? `${files.length} file${files.length === 1 ? '' : 's'} selected.`
                : 'Nothing selected yet.'}{' '}
              Next caps a server action&rsquo;s request body at {SERVER_ACTION_LIMIT}, so a large
              archive has to be scanned from a directory instead — that path never uploads the
              bytes.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="directory">Directory to scan</Label>
            <Input
              id="directory"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="/srv/import or ./import"
              maxLength={4096}
              spellCheck={false}
              aria-invalid={Boolean(state?.fieldErrors?.directory) || undefined}
            />
            <p className="text-xs leading-relaxed text-ink-muted">
              Read where it is, never moved. Symbolic links that point outside the directory are
              refused, and only Markdown files are read.
            </p>
            {state?.fieldErrors?.directory ? (
              <p className="text-xs text-danger">{state.fieldErrors.directory}</p>
            ) : null}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4" disabled={isPending}>
        <legend className="mb-1 text-xs font-medium text-ink-muted">How to import</legend>

        <div className="flex flex-col gap-2 sm:max-w-[16rem]">
          <Label htmlFor="type">Type, when the file does not name one</Label>
          <select
            id="type"
            value={type}
            onChange={(event) => setType(event.target.value as ContentType)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-ink"
          >
            {CONTENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
          <p className="text-xs leading-relaxed text-ink-muted">
            A file under <code className="font-mono">posts/</code>,{' '}
            <code className="font-mono">notes/</code> or{' '}
            <code className="font-mono">projects/</code> keeps the type its path names. The report
            says which one decided each file.
          </p>
        </div>

        <label className="flex items-start gap-3">
          <Checkbox
            checked={overwrite}
            onCheckedChange={(value) => setOverwrite(value === true)}
            id="overwrite"
          />
          <span className="text-sm leading-snug text-ink">
            Overwrite documents that already exist
            <span className="mt-1 block text-xs text-ink-muted">
              Without this, a file whose slug is taken is skipped and listed in the report.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3">
          <Checkbox
            checked={titleFix}
            onCheckedChange={(value) => setTitleFix(value === true)}
            id="title-fix"
          />
          <span className="text-sm leading-snug text-ink">
            Write a derived title into the imported copy
            <span className="mt-1 block text-xs text-ink-muted">
              A post with no <code className="font-mono">title:</code> is otherwise refused. The
              file you uploaded is never modified — only the copy in the content tree.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={isPending}>
          {isPending && running === 'scan' ? 'Scanning…' : 'Scan'}
        </Button>

        {report ? (
          <Button
            type="submit"
            disabled={isPending || importable === 0}
            onClick={() => {
              intent.current = 'apply'
            }}
          >
            {isPending && running === 'apply'
              ? 'Writing…'
              : `Confirm and write ${importable} file${importable === 1 ? '' : 's'}`}
          </Button>
        ) : null}
      </div>

      {state?.error ? (
        <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
          {state.error}
          {state.detail ? <span className="mt-1 block text-xs text-ink-muted">{state.detail}</span> : null}
        </p>
      ) : null}

      {report ? <Report report={report} /> : null}
      {applied ? <Applied applied={applied} /> : null}
    </form>
  )
}

function SourceChoice({
  id,
  label,
  checked,
  onSelect,
}: {
  id: string
  label: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-ink">
      <input
        id={id}
        type="radio"
        name="source"
        checked={checked}
        onChange={onSelect}
        className="size-4 accent-brand"
      />
      {label}
    </label>
  )
}

function Report({ report }: { report: NonNullable<ImportState['report']> }) {
  const notable = report.files.filter((file) => file.problems.length > 0)

  return (
    <section className="border border-line bg-surface p-5" aria-live="polite">
      <h3 className="text-sm font-medium text-ink">Scan report</h3>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
        {report.source} · fingerprint {report.fingerprint.slice(0, 12)}
      </p>

      <ul className="mt-4 flex flex-col gap-1 text-sm text-ink">
        {report.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {report.truncated ? (
        <p className="mt-3 border-l-2 border-warning pl-3 text-sm text-ink">
          The scan stopped at the file cap. Files past it were not read — raise the cap (or split
          the batch) and scan again before confirming.
        </p>
      ) : null}

      {report.problems.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-3">
          {report.problems.map((problem, index) => (
            <li key={`${problem.code}-${index}`} className="text-sm">
              <span className="text-ink">{problem.path ?? report.source}: {problem.message}</span>
              <span className="mt-1 block text-xs text-ink-muted">{problem.suggestion}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {notable.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-4 border-t border-line pt-4">
          {notable.map((file) => (
            <li key={file.sourcePath}>
              <p className="font-mono text-xs text-ink">
                {file.action === 'reject' ? '✗' : file.action === 'skip' ? '·' : '✓'}{' '}
                {file.sourcePath}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {file.action} → {file.targetPath} · {TYPE_LABELS[file.type]} from {file.typeSource} ·{' '}
                {file.status}
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {file.problems.map((problem, index) => (
                  <li key={`${problem.code}-${index}`} className="text-xs">
                    <span
                      className={
                        problem.severity === 'error'
                          ? 'text-danger'
                          : problem.severity === 'warning'
                            ? 'text-ink'
                            : 'text-ink-subtle'
                      }
                    >
                      {problem.severity}
                      {problem.line !== undefined ? ` (line ${problem.line})` : ''}
                    </span>{' '}
                    <span className="text-ink-muted">{problem.message}</span>
                    <span className="mt-1 block text-ink-subtle">{problem.suggestion}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function Applied({ applied }: { applied: NonNullable<ImportState['applied']> }) {
  return (
    <section className="border border-line bg-sunken p-5" aria-live="polite">
      <h3 className="text-sm font-medium text-ink">Import result</h3>
      <p className="mt-2 text-sm text-ink-muted">
        {applied.created} created, {applied.overwritten} overwritten, {applied.skipped} skipped,{' '}
        {applied.rejected} refused, {applied.failed} failed · {applied.durationMs}ms
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        {applied.indexed} of {applied.created + applied.overwritten} written documents were indexed.
      </p>

      {applied.indexFailures.length > 0 ? (
        <div className="mt-3 border-l-2 border-warning pl-3">
          <p className="text-sm text-ink">
            These files are on disk but could not be indexed, so they will not appear in lists or
            search until the next sync:
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-muted">
            {applied.indexFailures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="mt-4 flex flex-col gap-1 font-mono text-xs text-ink-muted">
        {applied.files.map((file) => (
          <li key={`${file.outcome}-${file.targetPath}`}>
            {file.outcome === 'failed' ? '✗' : file.outcome === 'skipped' ? '·' : '+'}{' '}
            {file.targetPath}
            {file.message ? ` — ${file.message}` : ''}
          </li>
        ))}
      </ul>
    </section>
  )
}
