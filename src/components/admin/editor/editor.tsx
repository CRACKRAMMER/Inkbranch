'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ContentStatus, ContentType } from '@/lib/content/schema'
import type { ContentFormValues } from '@/lib/admin/frontmatter-form'
import { indexDriftNotice, type IndexDrift } from '@/lib/admin/index-drift'
import type { ActionFailure } from '@/lib/admin/result'
// From `message`, not `@/lib/git`: this is a client component, and the module
// that runs git is server-only. What is imported here is the phrase — pure
// string formatting with no process and no filesystem behind it.
import { describeGitOutcome, type GitCommitNote } from '@/lib/git/message'
import { textStats, type TextStats } from '@/lib/utils/text'
import { cn } from '@/lib/utils/cn'
import { formatBytes } from '@/lib/utils/format'
import { autosaveContentAction, saveContentAction } from '@/app/admin/actions/content'
import { previewMarkdownAction } from '@/app/admin/actions/preview'
import { uploadAssetAction } from '@/app/admin/actions/assets'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { StatusBadge } from '@/components/admin/status-badge'
import { useUnsavedGuard } from '@/components/admin/unsaved-guard'
import { MetadataPanel } from './metadata-panel'
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor'

/**
 * The editor.
 *
 * Three things are true at once here and the UI has to keep them apart, because
 * confusing any two of them is how an author loses work:
 *
 *   1. **The buffer** — what is in the text field. Only this can be unsaved.
 *   2. **The file** — written on Ctrl/Cmd+S, or by nothing at all. Autosave does
 *      not touch it.
 *   3. **The draft revision** — captured two seconds after typing stops, inside
 *      Postgres. It is what survives a crash, and it is not a save.
 *
 * So the status line reports the file ("Saved to file at 14:32") and, separately,
 * the draft ("Draft revision recorded 14:32"). A failed save says the file was
 * not modified, because that is the only fact the author needs to decide whether
 * to retype their work.
 *
 * A fourth line belongs to none of them: whether the content directory's git
 * repository took the change. It is reported beside the save and never as the
 * save, because a commit that did not happen leaves a file that is still written.
 */

export interface EditorDocumentPayload {
  type: ContentType
  slug: string
  path: string
  status: ContentStatus
  checksum: string
  body: string
  values: ContentFormValues
  /** Frontmatter keys the panel does not own, shown read-only. */
  preserved: Record<string, unknown>
  wordCount: number
  updatedAt: string
  derivedTitle: string
  /** How the index disagrees with the file on disk, or null when it does not. */
  indexDrift: IndexDrift | null
}

type SaveState =
  | { kind: 'saved'; at: string | null; commit: GitCommitNote | null }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'failed'; failure: ActionFailure }

type DraftState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'recorded'; at: string; revisionNo: number | null }
  | { kind: 'off' }
  | { kind: 'failed'; message: string }

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; html: string; broken: string[] }
  | { kind: 'failed'; message: string }

type Mode = 'write' | 'split' | 'preview'
type Pane = 'metadata' | 'write' | 'preview'

const AUTOSAVE_DELAY_MS = 2000
const PREVIEW_DELAY_MS = 350
const UNSAVED_MESSAGE =
  'This document has changes that have not been saved to the file. Leave anyway?'

export function Editor({
  doc,
  locale,
  listHref,
  segment,
}: {
  doc: EditorDocumentPayload
  locale: string
  listHref: string
  segment: string
}) {
  const router = useRouter()
  const editor = useRef<MarkdownEditorHandle | null>(null)
  const imageInput = useRef<HTMLInputElement | null>(null)

  // The buffer, the metadata and the checksum are refs as well as state: the
  // autosave timer and the save handler read them when they fire, and a closure
  // over a state value would send whatever the render that scheduled it saw.
  const bodyRef = useRef(doc.body)
  const valuesRef = useRef(doc.values)
  const checksumRef = useRef(doc.checksum)
  const slugRef = useRef(doc.slug)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const reloadRequested = useRef(false)

  const [values, setValues] = useState(doc.values)
  const [stats, setStats] = useState<TextStats>(() => textStats(doc.body))
  const [save, setSave] = useState<SaveState>({ kind: 'saved', at: null, commit: null })
  const [draft, setDraft] = useState<DraftState>({ kind: 'idle' })
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' })
  const [mode, setMode] = useState<Mode>('split')
  const [pane, setPane] = useState<Pane>('write')
  const [uploading, setUploading] = useState(false)
  /**
   * Bumped on every edit. The debounced effects depend on this rather than on
   * the text itself, because the text lives in a ref and a ref is not a
   * dependency React can see change.
   */
  const [revision, setRevision] = useState(0)

  const readOnly = save.kind === 'failed' && save.failure.code === 'stale'
  const dirty = save.kind === 'dirty' || save.kind === 'failed'

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    setRevision((value) => value + 1)
    setSave((current) => (current.kind === 'saving' ? current : { kind: 'dirty' }))
  }, [])

  const handleBodyChange = useCallback(
    (text: string) => {
      bodyRef.current = text
      setStats(textStats(text))
      markDirty()
    },
    [markDirty],
  )

  const handleValuesChange = useCallback(
    (next: ContentFormValues) => {
      valuesRef.current = next
      setValues(next)
      markDirty()
    },
    [markDirty],
  )

  const formatTime = useCallback(
    (date: Date) =>
      new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date),
    [locale],
  )

  /* ---------------------------------------------------------------------- */
  /*  Save                                                                   */
  /* ---------------------------------------------------------------------- */

  const runSave = useCallback(
    async (force = false) => {
      if (savingRef.current) return
      savingRef.current = true
      setSave({ kind: 'saving' })

      try {
        const result = await saveContentAction({
          path: doc.path,
          baseChecksum: checksumRef.current,
          values: valuesRef.current,
          body: bodyRef.current,
          force,
        })

        if (!result.ok) {
          setSave({ kind: 'failed', failure: result })
          return
        }

        checksumRef.current = result.data.checksum
        dirtyRef.current = false
        setSave({
          kind: 'saved',
          at: formatTime(new Date(result.data.savedAt)),
          // Null unless this site has asked git to commit its content. The file
          // is written either way: what this adds is a phrase, never a state.
          commit: result.data.git ? describeGitOutcome(result.data.git) : null,
        })
        setDraft((current) => (current.kind === 'recorded' ? { kind: 'idle' } : current))
        setStats(textStats(bodyRef.current))

        if (result.data.slug !== slugRef.current) {
          slugRef.current = result.data.slug
          // The URL names the slug, so a rename is a navigation. `replace`, not
          // `push`: the old URL no longer resolves to anything.
          router.replace(`/admin/${segment}/${result.data.slug}/edit`)
        } else {
          router.refresh()
        }
      } finally {
        savingRef.current = false
      }
    },
    [doc.path, formatTime, router, segment],
  )

  /* ---------------------------------------------------------------------- */
  /*  Autosave                                                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(async () => {
      // A save in flight already carries this buffer to disk; recording a draft
      // beside it would file the same keystrokes twice.
      if (savingRef.current) return
      setDraft({ kind: 'saving' })

      const result = await autosaveContentAction({
        path: doc.path,
        values: valuesRef.current,
        body: bodyRef.current,
      })

      if (!result.ok) {
        setDraft({ kind: 'failed', message: result.error })
        return
      }
      if (result.data.revisionsDisabled) {
        setDraft({ kind: 'off' })
        return
      }
      setDraft({
        kind: 'recorded',
        at: formatTime(new Date(result.data.savedAt)),
        revisionNo: result.data.revisionNo,
      })
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [dirty, revision, doc.path, formatTime])

  /* ---------------------------------------------------------------------- */
  /*  Preview                                                                */
  /* ---------------------------------------------------------------------- */

  const previewVisible = mode !== 'write' || pane === 'preview'

  useEffect(() => {
    if (!previewVisible) return
    const timer = setTimeout(async () => {
      setPreview({ kind: 'loading' })
      const result = await previewMarkdownAction({
        body: bodyRef.current,
        title: valuesRef.current.title,
      })
      if (!result.ok) {
        setPreview({ kind: 'failed', message: result.error })
        return
      }
      setPreview({ kind: 'ready', html: result.data.html, broken: result.data.broken })
    }, PREVIEW_DELAY_MS)

    return () => clearTimeout(timer)
  }, [previewVisible, revision])

  /* ---------------------------------------------------------------------- */
  /*  Leaving with unsaved changes                                           */
  /* ---------------------------------------------------------------------- */

  useUnsavedGuard(dirtyRef, UNSAVED_MESSAGE)

  /* ---------------------------------------------------------------------- */
  /*  Reload from disk                                                       */
  /* ---------------------------------------------------------------------- */

  // The page re-renders from the server after `router.refresh()`, which brings
  // new props and a new checksum. Adopting them is deliberate — it discards the
  // buffer — so it only happens when the author asked for it.
  useEffect(() => {
    if (!reloadRequested.current) return
    if (doc.checksum === checksumRef.current) return
    reloadRequested.current = false
    bodyRef.current = doc.body
    valuesRef.current = doc.values
    checksumRef.current = doc.checksum
    slugRef.current = doc.slug
    dirtyRef.current = false
    editor.current?.replaceAll(doc.body)
    setValues(doc.values)
    setStats(textStats(doc.body))
    setSave({ kind: 'saved', at: null, commit: null })
    setDraft({ kind: 'idle' })
  }, [doc.body, doc.checksum, doc.slug, doc.values])

  const handleUpload = useCallback(async (file: File) => {
    const formData = new FormData()
    formData.set('file', file)
    const result = await uploadAssetAction(formData)
    if (!result.ok) {
      toast.error(result.error, { description: result.detail })
      return null
    }
    toast.success('Uploaded.', {
      description: `${result.data.filename} · ${formatBytes(result.data.size)}`,
    })
    return { markdown: result.data.markdown, filename: result.data.filename }
  }, [])

  /*
   * Ctrl/Cmd+Shift+I, which is the keyboard route to what paste and drop
   * already do.
   *
   * The picker is a real `<input type="file">` in the document rather than the
   * File System Access API, because the input is the one that works everywhere
   * and needs no permission prompt. The editor cannot reach it — the view has
   * no idea a picker exists — so the key travels up as a request and comes back
   * as a file, which is the same `handleUpload` the paste path uses. One upload
   * implementation, three ways in.
   *
   * The markdown lands at the caret, which survives the dialog: focus leaving
   * the view does not clear its selection, so the author gets the image where
   * they were typing rather than at the start of the document.
   */
  const handlePickImage = useCallback(() => {
    imageInput.current?.click()
  }, [])

  const handlePickedImage = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Cleared before the upload, and not after: picking the same file twice
      // in a row is a real thing to do — the first attempt failed, say — and an
      // input whose value never changed fires no second change event. Clearing
      // it also drops the reference the browser holds to the file.
      event.target.value = ''
      if (!file) return

      const uploaded = await handleUpload(file)
      if (uploaded) editor.current?.insert(uploaded.markdown)
    },
    [handleUpload],
  )

  const failure = save.kind === 'failed' ? save.failure : null
  const title = values.title.trim() || doc.derivedTitle
  const driftNotice = indexDriftNotice(doc.indexDrift)

  return (
    <div className="mx-auto flex w-full max-w-none flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4">
        <Link href={listHref} className="text-sm text-ink-muted no-underline hover:text-brand">
          ← List
        </Link>
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
          {doc.type}
        </span>
        <h1 className="min-w-0 flex-1 truncate font-serif text-lg tracking-tight text-ink">
          {title}
        </h1>
        <StatusBadge status={values.status} />

        <div className="flex items-center gap-2">
          {/* A file the index has no row for has no revisions either — they
              attach to the row's id — and the page that lists them can only
              answer with a 404. The notice above says why there are none. */}
          {doc.indexDrift === 'unindexed' ? null : (
            <Link
              href={`/admin/${segment}/${values.slug}/revisions`}
              className="text-sm text-ink-muted hover:text-brand"
            >
              Revisions
            </Link>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void runSave()}
            disabled={save.kind === 'saving' || !dirty}
          >
            {save.kind === 'saving' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <StatusLine
        save={save}
        draft={draft}
        stats={stats}
        uploading={uploading}
        path={doc.path}
      />

      {driftNotice ? (
        <p className="mt-4 border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-ink">
          {driftNotice}
        </p>
      ) : null}

      {failure ? (
        <FailureBanner
          failure={failure}
          onOverwrite={() => void runSave(true)}
          onReload={() => {
            reloadRequested.current = true
            router.refresh()
          }}
        />
      ) : null}

      <ModeBar
        mode={mode}
        pane={pane}
        onMode={setMode}
        onPane={setPane}
        broken={preview.kind === 'ready' ? preview.broken : []}
      />

      <div className="mt-4 grid min-h-[70vh] grid-cols-1 gap-px overflow-hidden border border-line bg-line lg:grid-cols-[19rem_1fr]">
        {/* Metadata: a pane of its own below the breakpoint, a fixed column above it. */}
        <aside
          className={cn(
            'min-w-0 overflow-y-auto bg-surface p-4 lg:block lg:max-h-[80vh]',
            pane === 'metadata' ? 'block' : 'hidden',
          )}
        >
          <MetadataPanel
            type={doc.type}
            values={values}
            onChange={handleValuesChange}
            preserved={doc.preserved}
            errors={failure?.fieldErrors}
            disabled={save.kind === 'saving' || readOnly}
          />
        </aside>

        <div className="min-w-0 bg-surface lg:col-start-2">
          <div
            className={cn(
              'grid min-h-[70vh] grid-cols-1',
              mode === 'split' ? 'lg:grid-cols-2 lg:gap-px lg:bg-line' : 'lg:grid-cols-1',
            )}
          >
            <div
              className={cn(
                'min-w-0 bg-surface lg:block',
                pane === 'write' ? 'block' : 'hidden',
                mode === 'preview' ? 'lg:hidden' : '',
              )}
            >
              <MarkdownEditor
                ref={editor}
                initialValue={doc.body}
                onChange={handleBodyChange}
                onSave={() => void runSave()}
                onUploadFile={handleUpload}
                onUploadStateChange={(state) => setUploading(state === 'uploading')}
                onPickImage={handlePickImage}
                onTogglePreview={() =>
                  setMode((current) => (current === 'write' ? 'split' : 'write'))
                }
                readOnly={readOnly}
                aria-label={`Markdown source for ${title}`}
              />

              {/*
                Here rather than in the editor: it is the parent that owns the
                upload action, and an input inside CodeMirror's own DOM would be
                a node the view does not know about. `hidden` and not
                `sr-only` — a file input reachable by Tab is a control nobody
                asked for, and its dialog is opened from the keyboard by the
                shortcut (or by clicking the line of hints below).
              */}
              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handlePickedImage(event)}
              />
            </div>

            <div
              className={cn(
                'min-w-0 overflow-y-auto bg-surface lg:block lg:max-h-[80vh]',
                pane === 'preview' ? 'block' : 'hidden',
                mode === 'write' ? 'lg:hidden' : '',
              )}
            >
              <Preview state={preview} />
            </div>
          </div>
        </div>
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-subtle">
        <span>
          <Kbd>Ctrl</Kbd> <Kbd>S</Kbd> save to file
        </span>
        <span>
          <Kbd>Ctrl</Kbd> <Kbd>P</Kbd> preview
        </span>
        <span>
          <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> link
        </span>
        <span>
          <Kbd>Ctrl</Kbd> <Kbd>Shift</Kbd> <Kbd>I</Kbd> image
        </span>
        <span>Paste or drop an image to upload it</span>
        <span className="truncate">{doc.path}</span>
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function StatusLine({
  save,
  draft,
  stats,
  uploading,
  path,
}: {
  save: SaveState
  draft: DraftState
  stats: TextStats
  uploading: boolean
  path: string
}) {
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          'font-medium',
          save.kind === 'saved' && 'text-success',
          save.kind === 'dirty' && 'text-warning',
          save.kind === 'saving' && 'text-ink-muted',
          save.kind === 'failed' && 'text-danger',
        )}
      >
        {save.kind === 'saved'
          ? save.at
            ? `Saved to file at ${save.at}`
            : 'Saved to file'
          : save.kind === 'dirty'
            ? 'Unsaved changes — not yet written to the file'
            : save.kind === 'saving'
              ? 'Saving to file…'
              : 'Not saved to file'}
      </span>

      {save.kind === 'saved' && save.commit ? (
        <span className={cn(save.commit.attention ? 'text-warning' : 'text-ink-subtle')}>
          {save.commit.text}
        </span>
      ) : null}

      <span className="text-ink-subtle">
        {draft.kind === 'recorded'
          ? `Draft revision recorded ${draft.at}${draft.revisionNo ? ` (#${draft.revisionNo})` : ''}`
          : draft.kind === 'saving'
            ? 'Recording draft revision…'
            : draft.kind === 'off'
              ? 'Revision history is switched off — drafts are not being recorded'
              : draft.kind === 'failed'
                ? `Draft not recorded: ${draft.message}`
                : 'Draft revisions record two seconds after you stop typing'}
      </span>

      {uploading ? <span className="text-ink-muted">Uploading…</span> : null}

      <span className="ml-auto tabular-nums text-ink-subtle">
        {stats.words} words · {stats.readingTime} min read ·{' '}
        <span className="font-mono">{path}</span>
      </span>
    </div>
  )
}

function FailureBanner({
  failure,
  onOverwrite,
  onReload,
}: {
  failure: ActionFailure
  onOverwrite: () => void
  onReload: () => void
}) {
  return (
    <div role="alert" className="mt-4 border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-ink">
      <p className="font-medium">{failure.error}</p>
      {failure.detail ? <p className="mt-1 text-xs text-ink-muted">{failure.detail}</p> : null}
      {failure.code === 'stale' ? (
        <>
          <p className="mt-2 text-xs text-ink-muted">
            The version on disk was not modified, and neither was the buffer below — it is still
            what you typed. Reloading discards the buffer; overwriting replaces the file with it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={onOverwrite}>
              Overwrite the file with this buffer
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onReload}>
              Discard the buffer and reload from disk
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function ModeBar({
  mode,
  pane,
  onMode,
  onPane,
  broken,
}: {
  mode: Mode
  pane: Pane
  onMode: (mode: Mode) => void
  onPane: (pane: Pane) => void
  broken: string[]
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      {/* Below the breakpoint there is no room for two panes side by side, so
          the same three choices become one visible pane at a time. */}
      <div className="flex gap-1 lg:hidden" role="group" aria-label="Editor pane">
        {(
          [
            ['metadata', 'Metadata'],
            ['write', 'Write'],
            ['preview', 'Preview'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={pane === value}
            onClick={() => onPane(value)}
            className={cn(
              'rounded-sm border px-3 py-1.5 text-sm transition-colors',
              pane === value
                ? 'border-line-strong bg-sunken text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="hidden gap-1 lg:flex" role="group" aria-label="Editor layout">
        {(
          [
            ['write', 'Write'],
            ['split', 'Split'],
            ['preview', 'Preview'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onMode(value)}
            className={cn(
              'rounded-sm border px-3 py-1.5 text-sm transition-colors',
              mode === value
                ? 'border-line-strong bg-sunken text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-xs text-ink-subtle" aria-live="polite">
        {broken.length > 0
          ? `${broken.length} link${broken.length === 1 ? '' : 's'} point at nothing: ${broken
              .slice(0, 3)
              .join(', ')}${broken.length > 3 ? '…' : ''}`
          : ''}
      </p>
    </div>
  )
}

function Preview({ state }: { state: PreviewState }) {
  if (state.kind === 'failed') {
    return (
      <p className="p-4 text-sm text-danger" role="alert">
        The preview could not be rendered: {state.message}
      </p>
    )
  }
  if (state.kind === 'ready') {
    return (
      <div className="editor-preview px-5 pt-4">
        <div className="prose" dangerouslySetInnerHTML={{ __html: state.html }} />
      </div>
    )
  }
  return (
    <p className="p-4 text-sm text-ink-subtle">
      {state.kind === 'loading' ? 'Rendering…' : 'The preview appears here as you type.'}
    </p>
  )
}

