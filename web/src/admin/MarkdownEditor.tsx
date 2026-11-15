import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  Bold,
  Check,
  Code2,
  Columns2,
  Copy,
  Eye,
  FilePlus2,
  Heading2,
  History,
  ImagePlus,
  Italic,
  Link2,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  Quote,
  RotateCcw,
  Save,
  Send,
  Share2,
  Slash,
  Trash2,
} from 'lucide-react'
import type { ContentStatus, ContentType } from '../lib/types'
import {
  adminApi,
  isBlogStudioPath,
  type AdminContentSummary,
  type DraftPreviewRecord,
  type RevisionRecord,
} from './api'

interface EditorDocMeta {
  type: ContentType
  title: string
  slug: string
  status: ContentStatus
  publishAt: string
  category: string
  tags: string
  series: string
  seriesOrder: string
  description: string
  featured: boolean
  comments: boolean
  projectStatus: string
  repo: string
  website: string
  stack: string
}

const SLASH_SNIPPETS: Array<{ label: string; hint: string; insert: string }> = [
  { label: '二级标题', hint: 'H2 Section', insert: '\n## 章节标题\n\n' },
  { label: '提示框 [!NOTE]', hint: 'Callout Note', insert: '\n> [!NOTE] 说明\n> 在此补充背景信息。\n\n' },
  { label: '技巧框 [!TIP]', hint: 'Callout Tip', insert: '\n> [!TIP] 实践建议\n> 写下关键要点。\n\n' },
  { label: '代码块', hint: 'Fenced Code', insert: '\n```go\nfunc main() {\n\t// code\n}\n```\n\n' },
  { label: '双列对比表格', hint: 'Markdown Table', insert: '\n| 维度 | 说明 |\n| :--- | :--- |\n| 要点 A | 描述 |\n\n' },
]

function buildTemplateMarkdown(type: ContentType): string {
  const now = new Date().toISOString()
  if (type === 'note') {
    return `---\ntitle: 新随笔\nslug: note-${now.slice(0, 10)}\ndate: ${now}\nstatus: draft\ntags: [随笔]\ncomments: true\n---\n\n记录一条快速思考或读书笔记。\n`
  }
  if (type === 'project') {
    return `---\ntitle: 新项目\nslug: project-${now.slice(0, 10)}\ndate: ${now}\nstatus: draft\nprojectStatus: active\nstack: [Go, React]\ntags: [开源]\ndescription: 简短概括项目定位。\n---\n\n## 项目背景\n\n`
  }
  return `---\ntitle: 未命名文章\nslug: post-${now.slice(0, 10)}\ndate: ${now}\nstatus: draft\ncategory: 技术思考\ntags: [工程实践]\ndescription: 用一句话介绍这篇文章的核心观点。\ncomments: true\nfeatured: false\n---\n\n## 引言\n\n从这里开始写作，按 \`/\` 插入内容块，或按 \`[[\` 引用站内文章。\n`
}

function splitYamlFrontmatter(raw: string): { hasFM: boolean; yamlLines: string[]; body: string } {
  const norm = raw.replace(/\r\n/g, '\n')
  if (!norm.startsWith('---\n')) {
    return { hasFM: false, yamlLines: [], body: norm }
  }
  const rest = norm.slice(4)
  const endIdx = rest.indexOf('\n---')
  if (endIdx < 0) {
    return { hasFM: false, yamlLines: [], body: norm }
  }
  const yamlBlock = rest.slice(0, endIdx)
  let after = rest.slice(endIdx + 4)
  if (after.startsWith('\n')) after = after.slice(1)
  return {
    hasFM: true,
    yamlLines: yamlBlock.split('\n'),
    body: after,
  }
}

function unquoteYaml(val: string): string {
  const s = val.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function formatYamlScalar(val: string): string {
  const v = val.trim()
  if (v === '') return '""'
  if (/[:#[\]{}&*!|>'"]|^\s|\s$/.test(v) || v.includes('\n')) {
    return JSON.stringify(v)
  }
  return v
}

function parseMetaFromMarkdown(raw: string, fallbackType: ContentType): EditorDocMeta {
  const { yamlLines } = splitYamlFrontmatter(raw)
  const map: Record<string, string> = {}
  const listFields: Record<string, string[]> = {}
  let activeListKey = ''

  for (const line of yamlLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('- ') && activeListKey) {
      const arr = listFields[activeListKey] ?? (listFields[activeListKey] = [])
      arr.push(unquoteYaml(trimmed.slice(2)))
      continue
    }
    const colon = line.indexOf(':')
    if (colon > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const k = line.slice(0, colon).trim()
      const rest = line.slice(colon + 1).trim()
      activeListKey = ''
      if (rest === '') {
        activeListKey = k
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        listFields[k] = rest
          .slice(1, -1)
          .split(',')
          .map((s) => unquoteYaml(s))
          .filter(Boolean)
      } else {
        map[k] = unquoteYaml(rest)
      }
    }
  }

  return {
    type: fallbackType,
    title: map.title ?? '',
    slug: map.slug ?? '',
    status: (map.status as ContentStatus) || 'published',
    publishAt: map.publishAt ?? '',
    category: map.category ?? map.categories ?? '',
    tags: (listFields.tags ?? []).join(', '),
    series: map.series ?? '',
    seriesOrder: map.seriesOrder ?? '',
    description: map.description ?? map.summary ?? map.excerpt ?? '',
    featured: map.featured === 'true',
    comments: map.comments !== 'false',
    projectStatus: map.projectStatus ?? 'active',
    repo: map.repo ?? map.github ?? '',
    website: map.website ?? map.homepage ?? '',
    stack: (listFields.stack ?? []).join(', '),
  }
}

function applyMetaToMarkdown(raw: string, meta: EditorDocMeta): string {
  const { yamlLines, body } = splitYamlFrontmatter(raw)
  const managed = new Set([
    'title',
    'slug',
    'status',
    'publishAt',
    'category',
    'tags',
    'series',
    'seriesOrder',
    'description',
    'featured',
    'comments',
    'projectStatus',
    'repo',
    'website',
    'stack',
  ])

  const preservedLines: string[] = []
  let skippingList = false
  for (const line of yamlLines) {
    if (line.trim().startsWith('- ') && skippingList) {
      continue
    }
    const colon = line.indexOf(':')
    if (colon > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const key = line.slice(0, colon).trim()
      if (managed.has(key)) {
        skippingList = line.slice(colon + 1).trim() === ''
        continue
      }
    }
    skippingList = false
    preservedLines.push(line)
  }

  const nextLines: string[] = [
    `title: ${formatYamlScalar(meta.title || '未命名')}`,
    meta.slug ? `slug: ${formatYamlScalar(meta.slug)}` : '',
    `status: ${meta.status || 'draft'}`,
    meta.status === 'scheduled' && meta.publishAt ? `publishAt: ${formatYamlScalar(meta.publishAt)}` : '',
    meta.category ? `category: ${formatYamlScalar(meta.category)}` : '',
    `tags: [${meta.tags
      .split(',')
      .map((t) => formatYamlScalar(t))
      .filter((t) => t !== '""')
      .join(', ')}]`,
    meta.series ? `series: ${formatYamlScalar(meta.series)}` : '',
    meta.seriesOrder ? `seriesOrder: ${Number(meta.seriesOrder) || 1}` : '',
    meta.description ? `description: ${formatYamlScalar(meta.description)}` : '',
    `featured: ${meta.featured ? 'true' : 'false'}`,
    `comments: ${meta.comments ? 'true' : 'false'}`,
    ...(meta.type === 'project'
      ? [
          `projectStatus: ${meta.projectStatus || 'active'}`,
          meta.repo ? `repo: ${formatYamlScalar(meta.repo)}` : '',
          meta.website ? `website: ${formatYamlScalar(meta.website)}` : '',
          `stack: [${meta.stack
            .split(',')
            .map((s) => formatYamlScalar(s))
            .filter((s) => s !== '""')
            .join(', ')}]`,
        ]
      : []),
    ...preservedLines.filter((l) => l.trim() !== ''),
  ].filter(Boolean)

  return `---\n${nextLines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`
}

export function MarkdownWorkspace({
  onDirtyNotice,
  siteUrl,
}: {
  onDirtyNotice?: (msg: string) => void
  siteUrl?: string
}) {
  const [items, setItems] = useState<AdminContentSummary[]>([])
  const [filterType, setFilterType] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [searchQ, setSearchQ] = useState('')
  const [loadingList, setLoadingList] = useState(true)

  const [docType, setDocType] = useState<ContentType>('post')
  const [activeSlug, setActiveSlug] = useState<string>('')
  const [previousPath, setPreviousPath] = useState<string>('')
  const [checksum, setChecksum] = useState<string>('')
  const [rawMarkdown, setRawMarkdown] = useState<string>(() => buildTemplateMarkdown('post'))
  const [revisions, setRevisions] = useState<RevisionRecord[]>([])
  const [previews, setPreviews] = useState<DraftPreviewRecord[]>([])
  const [createRedirectOnRename, setCreateRedirectOnRename] = useState(true)

  const [metaOpen, setMetaOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split')
  const [zenMode, setZenMode] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [wikiFilter, setWikiFilter] = useState('')

  const [previewHtml, setPreviewHtml] = useState('')
  const [previewErr, setPreviewErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [generatedPreviewUrl, setGeneratedPreviewUrl] = useState('')
  const [copiedUrl, setCopiedUrl] = useState(false)

  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const rawRef = useRef(rawMarkdown)
  const saveHandlerRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadHandlerRef = useRef<(file: File) => Promise<void>>(async () => {})

  rawRef.current = rawMarkdown

  const loadList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await adminApi.listContent({
        type: filterType || undefined,
        status: filterStatus || undefined,
        q: searchQ || undefined,
      })
      setItems(res.items ?? [])
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载文档列表失败')
    } finally {
      setLoadingList(false)
    }
  }, [filterType, filterStatus, searchQ])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const openDocument = async (type: ContentType, slug: string) => {
    setErrorMsg('')
    setStatusMsg('')
    setGeneratedPreviewUrl('')
    try {
      const detail = await adminApi.getContent(type, slug)
      setDocType(type)
      setActiveSlug(slug)
      setPreviousPath(detail.relativePath)
      setChecksum(detail.checksum)
      setRawMarkdown(detail.rawMarkdown)
      setRevisions(detail.revisions ?? [])
      setPreviews(detail.previews ?? [])
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取文章失败')
    }
  }

  const startNewDocument = (type: ContentType) => {
    setDocType(type)
    setActiveSlug('')
    setPreviousPath('')
    setChecksum('')
    setRevisions([])
    setPreviews([])
    setGeneratedPreviewUrl('')
    setErrorMsg('')
    setStatusMsg('已创建新草稿模板')
    setRawMarkdown(buildTemplateMarkdown(type))
  }

  const insertAtCursor = useCallback((snippet: string) => {
    const view = editorViewRef.current
    if (!view) {
      setRawMarkdown((prev) => prev + snippet)
      return
    }
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: snippet },
      selection: { anchor: sel.from + snippet.length },
    })
    view.focus()
  }, [])

  const wrapSelection = useCallback((before: string, after: string, placeholder: string) => {
    const view = editorViewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const chosen = view.state.sliceDoc(sel.from, sel.to) || placeholder
    const text = `${before}${chosen}${after}`
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + before.length, head: sel.from + before.length + chosen.length },
    })
    view.focus()
  }, [])

  const handleUploadFile = useCallback(
    async (file: File) => {
      setUploading(true)
      setErrorMsg('')
      try {
        const res = await adminApi.uploadMedia(file, file.name.replace(/\.[^.]+$/, ''))
        const alt = res.asset.altText || res.asset.filename
        insertAtCursor(`\n![${alt}](${res.asset.publicUrl})\n`)
        setStatusMsg(`已上传并插入图片：${res.asset.filename}`)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '媒体上传失败')
      } finally {
        setUploading(false)
      }
    },
    [insertAtCursor],
  )
  uploadHandlerRef.current = handleUploadFile

  const handleSave = useCallback(async () => {
    setSaving(true)
    setErrorMsg('')
    setStatusMsg('')
    try {
      const res = await adminApi.saveContent({
        type: docType,
        filename: activeSlug ? `${activeSlug}.md` : undefined,
        rawMarkdown: rawRef.current,
        expectedChecksum: checksum || undefined,
        previousPath: previousPath || undefined,
        createRedirectOnRename,
      })
      setActiveSlug(res.slug)
      setPreviousPath(res.relativePath)
      setChecksum(res.checksum)
      const notice = res.autoRedirectCreated
        ? `已保存 (${res.slug}) · 自动添加 301: ${res.autoRedirectCreated}`
        : `已保存 (${res.relativePath})`
      setStatusMsg(notice)
      onDirtyNotice?.(notice)
      await loadList()
      const detail = await adminApi.getContent(docType, res.slug)
      setRevisions(detail.revisions ?? [])
      setPreviews(detail.previews ?? [])
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [activeSlug, checksum, createRedirectOnRename, docType, loadList, onDirtyNotice, previousPath])
  saveHandlerRef.current = () => {
    void handleSave()
  }

  // Initialize CodeMirror 6 instance once editorHostRef is mounted
  useEffect(() => {
    const host = editorHostRef.current
    if (!host) return

    const cmTheme = EditorView.theme({
      '&': {
        height: '100%',
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        fontSize: '0.9375rem',
        fontFamily: 'var(--font-mono)',
      },
      '.cm-scroller': {
        overflow: 'auto',
        lineHeight: '1.7',
        padding: '0.75rem 0',
      },
      '.cm-content': {
        padding: '0 1rem',
        caretColor: 'var(--accent)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-muted)',
        borderRight: '1px solid var(--border-subtle)',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--accent-soft)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    })

    const state = EditorState.create({
      doc: rawRef.current,
      extensions: [
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        cmTheme,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              saveHandlerRef.current()
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.domEventHandlers({
          paste: (event) => {
            const first = event.clipboardData?.files?.[0]
            if (first && first.type.startsWith('image/')) {
              event.preventDefault()
              void uploadHandlerRef.current(first)
              return true
            }
            return false
          },
          drop: (event) => {
            const first = event.dataTransfer?.files?.[0]
            if (first && first.type.startsWith('image/')) {
              event.preventDefault()
              void uploadHandlerRef.current(first)
              return true
            }
            return false
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextVal = update.state.doc.toString()
            rawRef.current = nextVal
            setRawMarkdown(nextVal)

            const cursor = update.state.selection.main.head
            if (cursor >= 2 && nextVal.slice(cursor - 2, cursor) === '[[') {
              setWikiOpen(true)
            }
            const lineFrom = update.state.doc.lineAt(cursor).from
            const beforeOnLine = nextVal.slice(lineFrom, cursor)
            if (beforeOnLine === '/') {
              setSlashOpen(true)
            }
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    editorViewRef.current = view

    return () => {
      view.destroy()
      editorViewRef.current = null
    }
  }, [viewMode])

  // Sync external updates (loading a doc, metadata drawer, restoring revision) into CodeMirror
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== rawMarkdown) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: rawMarkdown },
      })
    }
  }, [rawMarkdown])

  // Debounced server-side Goldmark + Chroma + Callouts preview
  useEffect(() => {
    if (viewMode === 'edit') return
    const timer = window.setTimeout(async () => {
      try {
        const res = await adminApi.previewMarkdown(docType, rawMarkdown)
        const html = isBlogStudioPath()
          ? res.renderedHtml.replace(/(<img\b[^>]*?\bsrc=["'])\/uploads\//gi, '$1/blog/uploads/')
          : res.renderedHtml
        setPreviewHtml(html)
        setPreviewErr(res.frontmatterError)
      } catch (err) {
        setPreviewErr(err instanceof Error ? err.message : '预览渲染错误')
      }
    }, 280)
    return () => window.clearTimeout(timer)
  }, [docType, rawMarkdown, viewMode])

  useEffect(() => {
    if (!zenMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZenMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zenMode])

  const meta = useMemo(() => parseMetaFromMarkdown(rawMarkdown, docType), [docType, rawMarkdown])

  const updateMetaField = <K extends keyof EditorDocMeta>(key: K, val: EditorDocMeta[K]) => {
    const updated = { ...meta, [key]: val }
    setRawMarkdown(applyMetaToMarkdown(rawMarkdown, updated))
  }

  const filteredWikiItems = useMemo(() => {
    const q = wikiFilter.trim().toLowerCase()
    return items
      .filter((it) => !q || it.title.toLowerCase().includes(q) || it.slug.toLowerCase().includes(q))
      .slice(0, 10)
  }, [items, wikiFilter])

  const handleDeleteCurrent = async () => {
    if (!activeSlug) return
    if (!window.confirm(`确认删除 ${docType}/${activeSlug} 吗？`)) return
    try {
      await adminApi.deleteContent(docType, activeSlug)
      setStatusMsg(`已删除 ${docType}/${activeSlug}`)
      startNewDocument(docType)
      await loadList()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleCreatePreviewLink = async () => {
    if (!activeSlug) {
      setErrorMsg('请先保存文章再生成草稿分享链接')
      return
    }
    try {
      const res = await adminApi.createDraftPreview({
        type: docType,
        slug: activeSlug,
        label: `${docType}/${activeSlug}`,
        ttlHours: 72,
      })
      const baseOrigin = siteUrl ? siteUrl.replace(/\/$/, '') : window.location.origin
      const full = `${baseOrigin}${res.previewUrl}`
      setGeneratedPreviewUrl(full)
      const detail = await adminApi.getContent(docType, activeSlug)
      setPreviews(detail.previews ?? [])
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '生成分享链接失败')
    }
  }

  const handleRestoreRevision = async (revId: string) => {
    if (!window.confirm('确认回滚到此历史修订版本？这会在本地生成一个新的恢复记录。')) return
    try {
      const res = await adminApi.restoreRevision(revId)
      setRawMarkdown(res.rawMarkdown)
      setChecksum(res.checksum)
      setStatusMsg('已回滚至选定历史版本')
      await loadList()
      if (activeSlug) {
        const detail = await adminApi.getContent(docType, activeSlug)
        setRevisions(detail.revisions ?? [])
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '恢复修订失败')
    }
  }

  return (
    <div className={zenMode ? 'fixed inset-0 z-50 flex flex-col bg-[var(--bg-canvas)] p-4' : 'grid grid-cols-1 gap-5 lg:grid-cols-12'}>
      {/* Left Content Navigator */}
      {!zenMode && (
        <aside className="editorial-card flex flex-col gap-3 p-4 lg:col-span-3 lg:max-h-[82dvh]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-[var(--text-primary)]">内容库 ({items.length})</h2>
            <div className="flex items-center gap-1">
              {(['post', 'note', 'project'] as ContentType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => startNewDocument(t)}
                  title={`新建 ${t}`}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)]"
                >
                  <FilePlus2 className="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
                  {t}
                </button>
              ))}
            </div>
          </div>

          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="搜索标题 / Slug / 分类..."
            className="editorial-input !min-h-9 !py-1.5 !text-sm"
          />

          <div className="grid grid-cols-2 gap-2">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              aria-label="按类型筛选"
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs"
            >
              <option value="">全部类型</option>
              <option value="post">文章 (post)</option>
              <option value="note">随笔 (note)</option>
              <option value="project">项目 (project)</option>
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              aria-label="按状态筛选"
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs"
            >
              <option value="">全部状态</option>
              <option value="published">已发布</option>
              <option value="draft">草稿</option>
              <option value="scheduled">定时发布</option>
              <option value="unlisted">未列出</option>
              <option value="archived">归档</option>
            </select>
          </div>

          <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
            {loadingList ? (
              <div className="space-y-2 py-4">
                <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-elevated)]" />
                <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-elevated)]" />
              </div>
            ) : items.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--text-muted)]">没有匹配的文档</p>
            ) : (
              items.map((it) => {
                const selected = it.type === docType && it.slug === activeSlug
                return (
                  <button
                    key={`${it.type}:${it.slug}`}
                    type="button"
                    onClick={() => void openDocument(it.type, it.slug)}
                    className={`w-full rounded-xl border p-2.5 text-left transition-colors ${
                      selected
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 hover:border-[var(--border-strong)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-xs font-semibold text-[var(--text-primary)]">{it.title}</span>
                      <span className="shrink-0 rounded-md bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--text-muted)]">
                        {it.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                      <span>{it.type} / {it.slug}</span>
                      <span>{it.wordCount} 字</span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </aside>
      )}

      {/* Main CodeMirror Workspace + Preview + Drawer */}
      <section className={`editorial-card flex flex-col overflow-hidden ${zenMode ? 'flex-1' : 'lg:col-span-9 min-h-[78dvh]'}`}>
        {/* Studio Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/70 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" onClick={() => insertAtCursor('\n## ')} title="二级标题" className="rounded-lg p-1.5 hover:bg-[var(--bg-surface)]">
              <Heading2 className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => wrapSelection('**', '**', '加粗文本')} title="加粗" className="rounded-lg p-1.5 hover:bg-[var(--bg-surface)]">
              <Bold className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => wrapSelection('*', '*', '斜体文本')} title="斜体" className="rounded-lg p-1.5 hover:bg-[var(--bg-surface)]">
              <Italic className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => wrapSelection('`', '`', 'code')} title="行内代码" className="rounded-lg p-1.5 hover:bg-[var(--bg-surface)]">
              <Code2 className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => insertAtCursor('\n> [!NOTE] 说明\n> ')} title="Callout 提示框" className="rounded-lg p-1.5 hover:bg-[var(--bg-surface)]">
              <Quote className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setWikiOpen((v) => !v)}
              title="插入双链 [[wikilink]]"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-[var(--bg-surface)]"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              [[
            </button>
            <button
              type="button"
              onClick={() => setSlashOpen((v) => !v)}
              title="斜杠命令片段 /"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-[var(--bg-surface)]"
            >
              <Slash className="h-3.5 w-3.5" aria-hidden="true" />
              片段
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              title="上传图片或拖拽/粘贴进编辑器"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-[var(--bg-surface)]"
            >
              <ImagePlus className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
              {uploading ? '上传中...' : '插图'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleUploadFile(file)
                e.target.value = ''
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('edit')}
                className={`rounded-md px-2 py-1 ${viewMode === 'edit' ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : ''}`}
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${viewMode === 'split' ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : ''}`}
              >
                <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
                分栏
              </button>
              <button
                type="button"
                onClick={() => setViewMode('preview')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${viewMode === 'preview' ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : ''}`}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                预览
              </button>
            </div>

            {!zenMode && (
              <button
                type="button"
                onClick={() => setMetaOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs font-medium"
              >
                <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
                属性与版本
              </button>
            )}

            <button
              type="button"
              onClick={() => setZenMode((v) => !v)}
              title="禅意专注写作模式 (Esc 退出)"
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1.5"
            >
              {zenMode ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
            </button>

            {activeSlug && (
              <button
                type="button"
                onClick={() => void handleDeleteCurrent()}
                title="删除当前文档"
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1.5 text-[var(--tone-danger)] hover:bg-[var(--bg-elevated)]"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-[var(--accent-ink)] disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {saving ? '保存中...' : '保存 (⌘S)'}
            </button>
          </div>
        </div>

        {/* Status Banner */}
        {(statusMsg || errorMsg || previewErr) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 px-4 py-1.5 text-xs">
            <span className={errorMsg || previewErr ? 'text-[var(--tone-danger)] font-medium' : 'text-[var(--tone-tip)] font-medium'}>
              {errorMsg || previewErr || statusMsg}
            </span>
            {activeSlug && (
              <a
                href={`/${docType === 'post' ? 'posts' : docType === 'note' ? 'notes' : 'projects'}/${activeSlug}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-[var(--accent)] hover:underline"
              >
                前台查看 ↗
              </a>
            )}
          </div>
        )}

        {/* Popover Quick Menus (Wikilink / Slash) */}
        {(wikiOpen || slashOpen) && (
          <div className="grid grid-cols-1 gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/90 px-4 py-3 sm:grid-cols-2">
            {wikiOpen && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span>插入双链引用 [[slug|标题]]</span>
                  <button type="button" onClick={() => setWikiOpen(false)} className="text-[var(--text-muted)]">关闭</button>
                </div>
                <input
                  type="text"
                  value={wikiFilter}
                  onChange={(e) => setWikiFilter(e.target.value)}
                  placeholder="筛选文章标题或 slug..."
                  className="editorial-input !min-h-8 !py-1 !text-xs"
                />
                <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                  {filteredWikiItems.map((it) => (
                    <button
                      key={`${it.type}:${it.slug}`}
                      type="button"
                      onClick={() => {
                        insertAtCursor(`${it.slug}|${it.title}]]`)
                        setWikiOpen(false)
                      }}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-xs hover:border-[var(--accent)]"
                    >
                      {it.title} <span className="text-[var(--text-muted)]">({it.type})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {slashOpen && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span>斜杠快捷内容块</span>
                  <button type="button" onClick={() => setSlashOpen(false)} className="text-[var(--text-muted)]">关闭</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SLASH_SNIPPETS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => {
                        insertAtCursor(s.insert)
                        setSlashOpen(false)
                      }}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-left text-xs hover:border-[var(--accent)]"
                    >
                      <span className="font-semibold">{s.label}</span>
                      <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">{s.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Editor / Preview / Metadata Grid */}
        <div className="grid flex-1 grid-cols-1 divide-y divide-[var(--border-subtle)] lg:grid-cols-12 lg:divide-x lg:divide-y-0">
          {viewMode !== 'preview' && (
            <div
              className={
                viewMode === 'edit'
                  ? metaOpen && !zenMode
                    ? 'lg:col-span-8 min-h-[34rem]'
                    : 'lg:col-span-12 min-h-[34rem]'
                  : metaOpen && !zenMode
                    ? 'lg:col-span-4 min-h-[34rem]'
                    : 'lg:col-span-6 min-h-[34rem]'
              }
            >
              <div ref={editorHostRef} className="h-[68dvh] w-full overflow-hidden" />
            </div>
          )}

          {viewMode !== 'edit' && (
            <div
              className={
                viewMode === 'preview'
                  ? metaOpen && !zenMode
                    ? 'lg:col-span-8 h-[68dvh] overflow-y-auto p-6'
                    : 'lg:col-span-12 h-[68dvh] overflow-y-auto p-6'
                  : metaOpen && !zenMode
                    ? 'lg:col-span-4 h-[68dvh] overflow-y-auto p-5'
                    : 'lg:col-span-6 h-[68dvh] overflow-y-auto p-5'
              }
            >
              <div className="prose-article max-w-none" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}

          {/* Metadata + Preview Link + Revisions Drawer */}
          {metaOpen && !zenMode && (
            <aside className="space-y-4 overflow-y-auto bg-[var(--bg-elevated)]/30 p-4 text-xs lg:col-span-4 lg:max-h-[68dvh]">
              <div className="space-y-2.5">
                <h3 className="font-bold text-[var(--text-primary)]">文档属性 (Frontmatter)</h3>
                <label className="block space-y-1">
                  <span className="text-[var(--text-muted)]">标题</span>
                  <input
                    type="text"
                    value={meta.title}
                    onChange={(e) => updateMetaField('title', e.target.value)}
                    className="editorial-input !min-h-9 !py-1 !text-xs"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="text-[var(--text-muted)]">Slug 路径</span>
                    <input
                      type="text"
                      value={meta.slug}
                      onChange={(e) => updateMetaField('slug', e.target.value)}
                      className="editorial-input !min-h-9 !py-1 !text-xs"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[var(--text-muted)]">状态</span>
                    <select
                      value={meta.status}
                      onChange={(e) => updateMetaField('status', e.target.value as ContentStatus)}
                      className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2 text-xs"
                    >
                      <option value="published">published</option>
                      <option value="draft">draft</option>
                      <option value="scheduled">scheduled</option>
                      <option value="unlisted">unlisted</option>
                      <option value="archived">archived</option>
                    </select>
                  </label>
                </div>

                {meta.status === 'scheduled' && (
                  <label className="block space-y-1">
                    <span className="text-[var(--text-muted)]">定时发布时间 (RFC3339, 如 2026-12-01T08:00:00Z)</span>
                    <input
                      type="text"
                      value={meta.publishAt}
                      onChange={(e) => updateMetaField('publishAt', e.target.value)}
                      placeholder="2026-12-01T08:00:00Z"
                      className="editorial-input !min-h-9 !py-1 !text-xs"
                    />
                  </label>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="text-[var(--text-muted)]">分类</span>
                    <input
                      type="text"
                      value={meta.category}
                      onChange={(e) => updateMetaField('category', e.target.value)}
                      className="editorial-input !min-h-9 !py-1 !text-xs"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[var(--text-muted)]">专栏 Series</span>
                    <input
                      type="text"
                      value={meta.series}
                      onChange={(e) => updateMetaField('series', e.target.value)}
                      className="editorial-input !min-h-9 !py-1 !text-xs"
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-[var(--text-muted)]">标签 (逗号分隔)</span>
                  <input
                    type="text"
                    value={meta.tags}
                    onChange={(e) => updateMetaField('tags', e.target.value)}
                    className="editorial-input !min-h-9 !py-1 !text-xs"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[var(--text-muted)]">摘要 Description</span>
                  <textarea
                    rows={2}
                    value={meta.description}
                    onChange={(e) => updateMetaField('description', e.target.value)}
                    className="editorial-input !min-h-14 !py-1.5 !text-xs"
                  />
                </label>

                <div className="flex flex-wrap gap-3 pt-1">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={meta.featured}
                      onChange={(e) => updateMetaField('featured', e.target.checked)}
                    />
                    精选推荐
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={meta.comments}
                      onChange={(e) => updateMetaField('comments', e.target.checked)}
                    />
                    开启评论
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={createRedirectOnRename}
                      onChange={(e) => setCreateRedirectOnRename(e.target.checked)}
                    />
                    改名自动 301
                  </label>
                </div>
              </div>

              {/* Draft Preview Sharing */}
              <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-bold text-[var(--text-primary)]">
                    <Share2 className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                    私密草稿预览链接 (72h)
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCreatePreviewLink()}
                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2 py-1 font-semibold text-[var(--accent)]"
                  >
                    <Send className="h-3 w-3" aria-hidden="true" />
                    生成
                  </button>
                </div>

                {generatedPreviewUrl && (
                  <div className="flex items-center gap-1.5 rounded-xl border border-[var(--accent)]/40 bg-[var(--bg-surface)] p-2">
                    <input readOnly value={generatedPreviewUrl} className="w-full bg-transparent text-[11px] outline-none" />
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(generatedPreviewUrl)
                        setCopiedUrl(true)
                        window.setTimeout(() => setCopiedUrl(false), 1800)
                      }}
                      className="shrink-0 rounded-md p-1 text-[var(--accent)]"
                    >
                      {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                )}

                {previews.filter((p) => !p.revokedAt).map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5">
                    <span>到期 {new Date(p.expiresAt).toLocaleString()}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        await adminApi.revokeDraftPreview(p.id)
                        if (activeSlug) {
                          const detail = await adminApi.getContent(docType, activeSlug)
                          setPreviews(detail.previews ?? [])
                        }
                      }}
                      className="text-[var(--tone-danger)] hover:underline"
                    >
                      吊销
                    </button>
                  </div>
                ))}
              </div>

              {/* Zstd Revisions History */}
              <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
                <div className="flex items-center gap-1 font-bold text-[var(--text-primary)]">
                  <History className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                  历史修订版本 ({revisions.length})
                </div>
                {revisions.length === 0 ? (
                  <p className="text-[var(--text-muted)]">保存文章后自动记录 Zstd 压缩修订</p>
                ) : (
                  <div className="space-y-1.5">
                    {revisions.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
                        <div>
                          <div className="font-semibold">#{r.revisionNum} · {r.note || 'Revision'}</div>
                          <div className="text-[10px] text-[var(--text-muted)]">{new Date(r.createdAt).toLocaleString()}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRestoreRevision(r.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" />
                          回滚
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  )
}
