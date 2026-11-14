import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Search } from 'lucide-react'

export function NotFoundPage() {
  useEffect(() => {
    document.title = '404 Not Found — Inkbranch'
  }, [])

  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <div className="editorial-card p-8 sm:p-10">
        <div className="font-mono text-5xl font-bold text-[var(--accent)]">404</div>
        <h1 id="page-heading" tabIndex={-1} className="mt-4 text-2xl font-bold">
          未找到所访问的页面
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          这篇文章可能已修改路径、转为草稿，或网址拼写有误。你可以返回首页或通过全文检索定位目标内容。
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            返回首页
          </Link>
          <Link
            to="/search"
            search={{ q: '' }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--border-strong)]"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            全站搜索
          </Link>
        </div>
      </div>
    </div>
  )
}
