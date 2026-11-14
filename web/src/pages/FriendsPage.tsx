import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, Plus, Rss, Users, X } from 'lucide-react'
import { APIError, applyFriendLink, getFriends } from '../lib/api'
import { attachClosedByFallback } from '../lib/dialog'
import { formatDateISO } from '../lib/format'

export function FriendsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['friends'],
    queryFn: getFriends,
    staleTime: 60_000,
  })

  const [applyOpen, setApplyOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const dialogTitleId = useId()
  const nameId = useId()
  const urlId = useId()
  const feedId = useId()
  const descId = useId()
  const emailId = useId()

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [formErr, setFormErr] = useState('')
  const [submitOK, setSubmitOK] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    document.title = '友链与 RSS 聚合 Friends — Inkbranch'
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClose = () => setApplyOpen(false)
    dialog.addEventListener('close', onClose)
    const cleanup = attachClosedByFallback(dialog, () => setApplyOpen(false))

    if (applyOpen) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }

    return () => {
      dialog.removeEventListener('close', onClose)
      cleanup()
    }
  }, [applyOpen])

  const handleApply = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!name.trim()) {
      setFormErr('请填写博客名称')
      return
    }
    if (!/^https?:\/\//i.test(url.trim())) {
      setFormErr('请填写完整的博客主页地址（含 https://）')
      return
    }
    if (feedUrl.trim() && !/^https?:\/\//i.test(feedUrl.trim())) {
      setFormErr('RSS 地址需以 http:// 或 https:// 开头')
      return
    }
    if (!description.trim()) {
      setFormErr('请填写一句简短博客介绍')
      return
    }

    setFormErr('')
    setSubmitting(true)
    try {
      const res = await applyFriendLink({
        name: name.trim(),
        url: url.trim(),
        feedUrl: feedUrl.trim() || undefined,
        description: description.trim(),
        contactEmail: contactEmail.trim() || undefined,
      })
      setSubmitOK(res.message ?? '友链申请已收到，审核通过后将自动纳入友链名录与 RSS 聚合。')
      setName('')
      setUrl('')
      setFeedUrl('')
      setDescription('')
      setContactEmail('')
    } catch (err) {
      if (err instanceof APIError) {
        setFormErr(err.detail || err.message || '提交失败，请稍后重试')
      } else {
        setFormErr('提交失败，请稍后重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const links = data?.links ?? []
  const feeds = data?.feeds ?? []

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--border-subtle)] pb-6">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
            <Users className="h-4 w-4" aria-hidden="true" />
            <span>Blogroll & Syndication</span>
          </div>
          <h1 id="page-heading" tabIndex={-1} className="text-3xl font-bold tracking-tight">
            邻里友链与博友动态聚合
          </h1>
          <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
            关注独立书写者与技术同行，后端每两小时礼貌巡检友好站点的 RSS 订阅流，保持独立博客间的连接。
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setSubmitOK('')
            setFormErr('')
            setApplyOpen(true)
          }}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>自助申请友链</span>
        </button>
      </header>

      {/* Blogroll Cards */}
      <section aria-label="友链名录" className="space-y-4">
        <h2 className="text-lg font-bold">友链站点名录 ({links.length})</h2>
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="editorial-card h-28 animate-pulse" />
            <div className="editorial-card h-28 animate-pulse" />
          </div>
        ) : links.length === 0 ? (
          <div className="editorial-card p-8 text-center text-sm text-[var(--text-muted)]">
            暂无公开友链站点，欢迎点击右上角“自助申请友链”成为第一位邻里伙伴。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {links.map((link) => (
              <a
                key={link.id}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="editorial-card editorial-card-interactive group flex items-start gap-3.5 p-4"
              >
                {link.avatarUrl ? (
                  <img
                    src={link.avatarUrl}
                    alt=""
                    width={42}
                    height={42}
                    loading="lazy"
                    className="h-10.5 w-10.5 shrink-0 rounded-full border border-[var(--border-subtle)] object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="inline-flex h-10.5 w-10.5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-sm font-bold text-[var(--accent)]"
                  >
                    {link.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                      {link.name}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">
                    {link.description}
                  </p>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      {/* Syndicated RSS Timeline */}
      <section aria-label="博友近期更新聚合" className="space-y-4">
        <div className="flex items-center gap-2">
          <Rss className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
          <h2 className="text-lg font-bold">博友近期更新动态 ({feeds.length})</h2>
        </div>

        {feeds.length === 0 ? (
          <div className="editorial-card p-8 text-center text-sm text-[var(--text-muted)]">
            暂无友链 RSS 聚合更新文章，待订阅友链站点后将自动同步。
          </div>
        ) : (
          <ul className="editorial-card divide-y divide-[var(--border-subtle)]">
            {feeds.map((item) => (
              <li key={item.id} className="p-4 transition-colors hover:bg-[var(--bg-elevated)]">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                    <span className="font-semibold text-[var(--accent)]">{item.friendName}</span>
                    <time dateTime={item.publishedAt} className="font-mono">
                      {formatDateISO(item.publishedAt)}
                    </time>
                  </div>
                  <div className="text-sm font-bold text-[var(--text-primary)]">{item.title}</div>
                  {item.summary ? (
                    <p className="line-clamp-2 text-xs text-[var(--text-secondary)]">
                      {item.summary}
                    </p>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Friend Link Apply Modal */}
      <dialog
        ref={dialogRef}
        closedby="any"
        aria-labelledby={dialogTitleId}
        className="editorial-dialog"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-4">
          <h2 id={dialogTitleId} className="text-base font-bold text-[var(--text-primary)]">
            申请交换友情链接
          </h2>
          <button
            type="button"
            onClick={() => setApplyOpen(false)}
            aria-label="关闭申请弹窗"
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto p-6">
          {submitOK ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{submitOK}</span>
            </div>
          ) : (
            <form onSubmit={handleApply} noValidate className="space-y-4">
              <div>
                <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  站点名称 <span className="text-[var(--tone-danger)]">*</span>
                </label>
                <input
                  id={nameId}
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Inkbranch · 墨枝"
                  className="editorial-input"
                />
              </div>

              <div>
                <label htmlFor={urlId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  站点地址 <span className="text-[var(--tone-danger)]">*</span>
                </label>
                <input
                  id={urlId}
                  type="url"
                  required
                  autocorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://blog.example.com"
                  className="editorial-input"
                />
              </div>

              <div>
                <label htmlFor={feedId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  RSS / Atom 地址（填写后支持聚合同步）
                </label>
                <input
                  id={feedId}
                  type="url"
                  autocorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={feedUrl}
                  onChange={(e) => setFeedUrl(e.target.value)}
                  placeholder="https://blog.example.com/feed.xml"
                  className="editorial-input"
                />
              </div>

              <div>
                <label htmlFor={descId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  站点简介 <span className="text-[var(--tone-danger)]">*</span>
                </label>
                <input
                  id={descId}
                  type="text"
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话介绍你的技术关注或创作方向"
                  className="editorial-input"
                />
              </div>

              <div>
                <label htmlFor={emailId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  联系邮箱（仅审核联系，不公开）
                </label>
                <input
                  id={emailId}
                  type="email"
                  autocorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="editorial-input"
                />
              </div>

              {formErr ? (
                <p role="alert" className="text-xs font-medium text-[var(--tone-danger)]">
                  {formErr}
                </p>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setApplyOpen(false)}
                  className="cursor-pointer rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-xs font-semibold text-[var(--text-secondary)]"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="cursor-pointer rounded-xl bg-[var(--accent)] px-5 py-2 text-xs font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] disabled:opacity-60"
                >
                  {submitting ? '正在提交...' : '提交友链申请'}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </div>
  )
}
