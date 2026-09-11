'use client'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

/**
 * CodeMirror 6, configured as a Markdown source editor.
 *
 * The document is uncontrolled: the view owns the text, and React never
 * re-renders it per keystroke. That is not an optimisation for its own sake —
 * a controlled `value` prop on a CodeMirror view means a state update per
 * character typed, which is what makes a web editor feel heavy on a laptop with
 * a hundred browser tabs open. The parent keeps a ref to the current text for
 * saving, and gets a notification only when the text actually changes.
 *
 * Syntax highlighting is class-based rather than inline-styled, so the colours
 * come from `admin.css` and follow dark mode with the rest of the admin.
 */

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-heading' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.emphasis, class: 'cm-emphasis' },
  { tag: [tags.link, tags.url], class: 'cm-link' },
  { tag: [tags.monospace, tags.labelName], class: 'cm-monospace' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.list, class: 'cm-list' },
  { tag: [tags.meta, tags.comment], class: 'cm-meta' },
  { tag: [tags.processingInstruction, tags.tagName], class: 'cm-processingInstruction' },
])

export interface MarkdownEditorHandle {
  /** Replace the whole buffer — an explicit server overwrite, never a sync. */
  replaceAll(text: string): void
  /** Insert text at the caret, replacing the selection. */
  insert(text: string): void
  /** Wrap the selection (or the caret's word-less position) in markers. */
  wrapSelection(before: string, after: string): void
  /** Insert a Markdown link, leaving the caret on the part only the author has. */
  insertLink(): void
  focus(): void
}

/**
 * `[text](url)`, with the caret on whatever is still missing.
 *
 * Two shapes, because the two cases are missing different halves. With a
 * selection the text is already right and only the destination is missing, so
 * the caret goes inside the empty parentheses — paste the URL and the link is
 * done. With no selection both halves are missing, and the half an author types
 * first is the text, so the template goes in with `text` selected: typing
 * replaces it.
 *
 * No dialog asking for the URL. The author is looking at the Markdown source —
 * that is what this editor is — and a modal would be a slower way to type two
 * characters they can see. Markdown is the interface here, not an implementation
 * detail behind one.
 */
function insertLink(instance: EditorView): void {
  const { from, to } = instance.state.selection.main
  const selected = instance.state.sliceDoc(from, to)

  const text = selected || 'text'
  const insert = `[${text}](url)`
  // With a selection: an empty destination, caret inside it. Without: the
  // placeholder `text` selected, so the first keystroke replaces it. The
  // destination is left as the literal `url` in that case, because a link with
  // nothing in the parentheses is not Markdown anybody can see is unfinished.
  const selection = selected
    ? { anchor: from + insert.length - 1 }
    : { anchor: from + 1, head: from + 1 + text.length }

  instance.dispatch({ changes: { from, to, insert }, selection })
  instance.focus()
}

export interface UploadedMarkdown {
  markdown: string
  filename: string
}

export interface MarkdownEditorProps {
  /** Initial text. Later changes to this prop do not touch the view. */
  initialValue: string
  onChange: (value: string) => void
  /** Called for Mod-S. Returning true keeps the browser from doing its own. */
  onSave: () => void
  /** Called when a file is pasted or dropped; resolves to the text to insert. */
  onUploadFile?: (file: File) => Promise<UploadedMarkdown | null>
  /** Called when a paste or drop upload starts and finishes, for the status line. */
  onUploadStateChange?: (state: 'idle' | 'uploading' | 'failed') => void
  /**
   * Called for Mod-Shift-I. The editor cannot open a file picker itself: the
   * upload belongs to the parent, which owns the action, the progress line and
   * the message on failure. All this side does is say the key was pressed.
   */
  onPickImage?: () => void
  onTogglePreview?: () => void
  readOnly?: boolean
  'aria-label'?: string
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      initialValue,
      onChange,
      onSave,
      onUploadFile,
      onUploadStateChange,
      onPickImage,
      onTogglePreview,
      readOnly = false,
      'aria-label': ariaLabel,
    },
    ref,
  ) {
    const host = useRef<HTMLDivElement | null>(null)
    const view = useRef<EditorView | null>(null)

    // Callbacks live in refs so the view is built once. Rebuilding it on a
    // render would discard the undo history, the selection and the scroll
    // position — for a prop that changed because a parent re-rendered.
    const handlers = useRef({
      onChange,
      onSave,
      onUploadFile,
      onUploadStateChange,
      onPickImage,
      onTogglePreview,
    })
    useEffect(() => {
      handlers.current = {
        onChange,
        onSave,
        onUploadFile,
        onUploadStateChange,
        onPickImage,
        onTogglePreview,
      }
    })

    useImperativeHandle(
      ref,
      () => ({
        replaceAll(text: string) {
          const instance = view.current
          if (!instance) return
          instance.dispatch({
            changes: { from: 0, to: instance.state.doc.length, insert: text },
            selection: { anchor: 0 },
          })
        },
        insert(text: string) {
          const instance = view.current
          if (!instance) return
          const { from, to } = instance.state.selection.main
          instance.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
          })
          instance.focus()
        },
        wrapSelection(before: string, after: string) {
          const instance = view.current
          if (!instance) return
          const { from, to } = instance.state.selection.main
          const selected = instance.state.sliceDoc(from, to)
          const insert = `${before}${selected}${after}`
          instance.dispatch({
            changes: { from, to, insert },
            selection: selected
              ? { anchor: from + before.length, head: from + before.length + selected.length }
              : { anchor: from + before.length },
          })
          instance.focus()
        },
        insertLink() {
          const instance = view.current
          if (!instance) return
          insertLink(instance)
        },
        focus() {
          view.current?.focus()
        },
      }),
      [],
    )

    useEffect(() => {
      const parent = host.current
      if (!parent) return

      const upload = async (file: File): Promise<void> => {
        const uploadHandler = handlers.current.onUploadFile
        if (!uploadHandler) return
        handlers.current.onUploadStateChange?.('uploading')
        try {
          const result = await uploadHandler(file)
          if (!result) {
            handlers.current.onUploadStateChange?.('idle')
            return
          }
          const instance = view.current
          if (instance) {
            const { from, to } = instance.state.selection.main
            instance.dispatch({
              changes: { from, to, insert: result.markdown },
              selection: { anchor: from + result.markdown.length },
            })
          }
          handlers.current.onUploadStateChange?.('idle')
        } catch {
          // The parent action already turned the failure into a message; this
          // only has to stop the status line from claiming an upload happened.
          handlers.current.onUploadStateChange?.('failed')
        }
      }

      const state = EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(highlightStyle),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handlers.current.onChange(update.state.doc.toString())
            }
          }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave()
                return true
              },
            },
            {
              key: 'Mod-p',
              preventDefault: true,
              run: () => {
                handlers.current.onTogglePreview?.()
                return true
              },
            },
            {
              // The view is the argument rather than `view.current`: this runs
              // inside the keymap the view itself owns, and reading the ref
              // would be a second source of truth for the same instance.
              key: 'Mod-k',
              preventDefault: true,
              run: (target) => {
                insertLink(target)
                return true
              },
            },
            {
              key: 'Mod-Shift-i',
              preventDefault: true,
              run: () => {
                handlers.current.onPickImage?.()
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.domEventHandlers({
            paste: (event) => {
              const files = filesFrom(event.clipboardData)
              if (files.length === 0) return false
              event.preventDefault()
              for (const file of files) void upload(file)
              return true
            },
            drop: (event) => {
              const files = filesFrom(event.dataTransfer)
              if (files.length === 0) return false
              event.preventDefault()
              for (const file of files) void upload(file)
              return true
            },
          }),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel ?? 'Markdown source',
            spellcheck: 'true',
          }),
        ],
      })

      const instance = new EditorView({ state, parent })
      view.current = instance

      return () => {
        instance.destroy()
        view.current = null
      }
      // `initialValue` is deliberately not a dependency: the view owns the text
      // after mount, and re-creating it whenever a parent re-renders with a new
      // string would discard undo history on every save.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return <div ref={host} className="h-full min-h-0 overflow-hidden" />
  },
)

/** Image and video files only: a dropped `.md` file is a link, not an upload. */
function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files: File[] = []
  for (const item of Array.from(transfer.files)) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/')) files.push(item)
  }
  return files
}
