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
  focus(): void
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
    const handlers = useRef({ onChange, onSave, onUploadFile, onUploadStateChange, onTogglePreview })
    useEffect(() => {
      handlers.current = { onChange, onSave, onUploadFile, onUploadStateChange, onTogglePreview }
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
