import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { ContentCard } from '../components/ContentCard'
import { listContent } from '../lib/api'
import type { ProjectStatus } from '../lib/types'

export function ProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectStatus>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['content-list', 'project'],
    queryFn: () => listContent({ type: 'project', limit: 100 }),
    staleTime: 60_000,
  })

  useEffect(() => {
    document.title = '作品展厅 Projects — Inkbranch'
  }, [])

  const items = data?.items ?? []
  const filtered =
    statusFilter === 'all'
      ? items
      : items.filter((p) => p.projectStatus === statusFilter)

  return (
    <div className="space-y-8">
      <header className="space-y-3 border-b border-[var(--border-subtle)] pb-6">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
          <FolderGit2 className="h-4 w-4" aria-hidden="true" />
          <span>Projects Showcase · 个人作品与开源实践</span>
        </div>
        <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
          软件系统、工程工具与实验项目
        </h1>
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          从构思到上线运维的开源工具、架构实验与个人产品复盘，共 {items.length} 个公开项目。
        </p>

        <div className="flex flex-wrap gap-2 pt-2 text-xs">
          {(
            [
              { id: 'all', label: '全部项目' },
              { id: 'active', label: 'Active · 活跃维护' },
              { id: 'maintained', label: 'Maintained · 稳定运行' },
              { id: 'experiment', label: 'Experiment · 实验探索' },
              { id: 'archived', label: 'Archived · 已归档' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setStatusFilter(opt.id)}
              aria-pressed={statusFilter === opt.id}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 font-medium ${
                statusFilter === opt.id
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          <div className="editorial-card h-56 animate-pulse" />
          <div className="editorial-card h-56 animate-pulse" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="editorial-card p-10 text-center text-sm text-[var(--text-muted)]">
          该状态下暂无项目条目
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <ContentCard key={item.slug} item={item} variant="project" />
          ))}
        </div>
      )}
    </div>
  )
}
