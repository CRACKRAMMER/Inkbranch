import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Network } from 'lucide-react'
import { KnowledgeGraphCanvas } from '../components/KnowledgeGraphCanvas'
import { getGraph, listTags } from '../lib/api'
import { collectionLabel } from '../lib/format'
import type { ContentType, GraphNode } from '../lib/types'

export function GraphPage() {
  const [typeFilter, setTypeFilter] = useState<'' | ContentType>('')
  const [tagFilter, setTagFilter] = useState('')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)

  const { data: graph, isLoading } = useQuery({
    queryKey: ['graph', typeFilter, tagFilter],
    queryFn: () => getGraph({ type: typeFilter, tag: tagFilter }),
    staleTime: 60_000,
  })

  const { data: tagsData } = useQuery({
    queryKey: ['tags'],
    queryFn: listTags,
    staleTime: 120_000,
  })

  useEffect(() => {
    document.title = '知识图谱 Knowledge Graph — Inkbranch'
  }, [])

  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []

  return (
    <div className="space-y-6">
      <header className="space-y-4 border-b border-[var(--border-subtle)] pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
              <Network className="h-4 w-4" aria-hidden="true" />
              <span>Knowledge Graph 2.0</span>
            </div>
            <h1 id="page-heading" tabIndex={-1} className="mt-1 text-3xl font-bold tracking-tight">
              全站双链知识图谱
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#d97736]" aria-hidden="true" />
              长文
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6]" aria-hidden="true" />
              随笔
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" aria-hidden="true" />
              项目
            </span>
            <span className="font-mono text-[var(--text-muted)]">
              {nodes.length} 节点 · {edges.length} 关联边
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              { id: '', label: '全部内容' },
              { id: 'post', label: '长文 Posts' },
              { id: 'note', label: '随笔 Notes' },
              { id: 'project', label: '项目 Projects' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id || 'all'}
              type="button"
              onClick={() => {
                setTypeFilter(opt.id)
                setSelectedNode(null)
              }}
              aria-pressed={typeFilter === opt.id}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 font-medium ${
                typeFilter === opt.id
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
              }`}
            >
              {opt.label}
            </button>
          ))}

          {tagsData && tagsData.items.length > 0 ? (
            <label className="ml-auto flex items-center gap-2">
              <span className="text-[var(--text-muted)]">按标签筛选</span>
              <select
                value={tagFilter}
                onChange={(e) => {
                  setTagFilter(e.target.value)
                  setSelectedNode(null)
                }}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              >
                <option value="">全部标签</option>
                {tagsData.items.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    #{t.name} ({t.count})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="lg:col-span-9">
          {isLoading || !graph ? (
            <div className="editorial-card h-[min(68dvh,38rem)] animate-pulse" />
          ) : (
            <KnowledgeGraphCanvas
              graph={graph}
              mode="global"
              onSelectNode={(node) => setSelectedNode(node)}
            />
          )}
        </div>

        <aside aria-label="图谱节点详情" className="space-y-4 lg:col-span-3">
          {selectedNode ? (
            <div className="editorial-card space-y-3 p-5">
              <div className="text-xs font-semibold text-[var(--accent)]">
                {collectionLabel(selectedNode.type)}
                {selectedNode.category ? ` · ${selectedNode.category}` : ''}
              </div>
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                {selectedNode.title}
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                图谱连接度：{selectedNode.degree} 条关系
              </p>
              {selectedNode.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {selectedNode.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              ) : null}
              <Link
                to={selectedNode.url}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
              >
                <span>打开完整内容</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <div className="editorial-card space-y-2 p-5 text-xs leading-relaxed text-[var(--text-secondary)]">
              <h2 className="text-sm font-bold text-[var(--text-primary)]">交互提示</h2>
              <p>· 拖拽画布可平移视角，右下角支持缩放与复位</p>
              <p>· 鼠标悬停节点可高亮其一跳双向关联</p>
              <p>· 单击任意节点即可查看简介并跳转阅读</p>
              <p className="pt-2 text-[var(--text-muted)]">
                图谱自动聚合正文 <code>[[Wikilink]]</code> 双链（实线）、系列归属（细实线）与共享主题标签（虚线）。
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

export default GraphPage
