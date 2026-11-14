import type { ContentType, ProjectStatus } from './types'

export function formatDateISO(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function formatDateLong(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function collectionLabel(type: ContentType): string {
  switch (type) {
    case 'post':
      return '长文'
    case 'note':
      return '随笔'
    case 'project':
      return '项目'
  }
}

export function langLabel(lang?: string): string {
  if (!lang) return '中文'
  const low = lang.toLowerCase()
  if (low.startsWith('zh')) return '中文'
  if (low.startsWith('en')) return 'EN'
  return lang.toUpperCase()
}

export function projectStatusMeta(status?: ProjectStatus): {
  label: string
  dotClass: string
  badgeClass: string
} {
  switch (status) {
    case 'active':
      return {
        label: 'Active · 活跃维护',
        dotClass: 'bg-emerald-500',
        badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      }
    case 'maintained':
      return {
        label: 'Maintained · 稳定维护',
        dotClass: 'bg-sky-500',
        badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      }
    case 'experiment':
      return {
        label: 'Experiment · 实验探索',
        dotClass: 'bg-amber-500',
        badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      }
    case 'archived':
      return {
        label: 'Archived · 已归档',
        dotClass: 'bg-zinc-400',
        badgeClass: 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)]',
      }
    default:
      return {
        label: 'Project',
        dotClass: 'bg-[var(--accent)]',
        badgeClass: 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]',
      }
  }
}
