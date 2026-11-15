import { useId, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CornerDownRight, MessageSquare, ShieldCheck } from 'lucide-react'
import { APIError, getComments, postComment } from '../lib/api'
import { formatDateISO } from '../lib/format'
import { buildPublicLoginUrl, logoutPublicReader, usePublicAuth } from '../lib/publicAuth'
import type { CommentNode, ContentType } from '../lib/types'

interface CommentsSectionProps {
  contentType: ContentType
  slug: string
  commentsEnabled: boolean
}

function CommentCard({
  node,
  depth = 0,
  onReply,
}: {
  node: CommentNode
  depth?: number
  onReply: (id: string, name: string) => void
}) {
  return (
    <li className={depth > 0 ? 'mt-3 border-l-2 border-[var(--border-subtle)] pl-4' : ''}>
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            {node.avatarUrl ? (
              <img
                src={node.avatarUrl}
                alt=""
                width={26}
                height={26}
                loading="lazy"
                className="h-6.5 w-6.5 rounded-full border border-[var(--border-subtle)] object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex h-6.5 w-6.5 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent)]"
              >
                {node.authorName.slice(0, 1).toUpperCase()}
              </span>
            )}
            {node.authorUrl ? (
              <a
                href={node.authorUrl}
                target="_blank"
                rel="noopener noreferrer ugc"
                className="font-semibold text-[var(--text-primary)] hover:text-[var(--accent)]"
              >
                {node.authorName}
              </a>
            ) : (
              <span className="font-semibold text-[var(--text-primary)]">
                {node.authorName}
              </span>
            )}
            {node.isAuthor ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Author
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-3 text-[var(--text-muted)]">
            <time dateTime={node.createdAt}>{formatDateISO(node.createdAt)}</time>
            {depth === 0 ? (
              <button
                type="button"
                onClick={() => onReply(node.id, node.authorName)}
                className="cursor-pointer font-medium text-[var(--accent)] hover:underline"
              >
                回复
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="editorial-prose mt-2.5 text-sm"
          dangerouslySetInnerHTML={{ __html: node.bodyHtml }}
        />
      </div>

      {node.replies && node.replies.length > 0 ? (
        <ul>
          {node.replies.map((child) => (
            <CommentCard key={child.id} node={child} depth={1} onReply={onReply} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function CommentsSection({
  contentType,
  slug,
  commentsEnabled,
}: CommentsSectionProps) {
  const queryClient = useQueryClient()
  const nameId = useId()
  const emailId = useId()
  const urlId = useId()
  const bodyId = useId()
  const notifyId = useId()
  const errorId = useId()
  const { data: authMe, isLoading: authLoading } = usePublicAuth()
  const requiresCitadel = Boolean(authMe?.usesCitadel)

  const { data } = useQuery({
    queryKey: ['comments', contentType, slug],
    queryFn: () => getComments(contentType, slug),
    enabled: commentsEnabled,
    staleTime: 30_000,
  })

  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [authorUrl, setAuthorUrl] = useState('')
  const [bodyMarkdown, setBodyMarkdown] = useState('')
  const [notifyOnReply, setNotifyOnReply] = useState(true)
  const [replyTarget, setReplyTarget] = useState<{ id: string; name: string } | null>(null)
  const [formError, setFormError] = useState('')
  const [submitMessage, setSubmitMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!commentsEnabled || data?.mode === 'off' || data?.commentsEnabled === false) {
    return (
      <section
        id="comments"
        aria-label="评论区"
        className="mt-10 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 text-sm text-[var(--text-muted)]"
      >
        本文已关闭评论互动。
      </section>
    )
  }

  if (data?.mode === 'giscus') {
    return (
      <section id="comments" aria-label="Giscus 评论区" className="editorial-card mt-10 p-6">
        <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
          <MessageSquare className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
          <span>社区讨论（Giscus）</span>
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          已启用 GitHub Discussions 评论模式（{data.giscus?.repo ?? 'Giscus 已配置'}）。
        </p>
      </section>
    )
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!requiresCitadel) {
      if (!authorName.trim()) {
        setFormError('请填写您的昵称')
        return
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail.trim())) {
        setFormError('请填写有效的邮箱地址（仅用于头像和回复通知）')
        return
      }
    } else if (!authMe?.authenticated || !authMe.user) {
      setFormError('请先使用 Citadel 账号登录后再发表评论')
      return
    }
    if (!bodyMarkdown.trim()) {
      setFormError('请填写评论内容')
      return
    }
    if (authorUrl.trim() && !/^https?:\/\//i.test(authorUrl.trim())) {
      setFormError('主页链接需以 http:// 或 https:// 开头')
      return
    }

    setFormError('')
    setSubmitMessage('')
    setSubmitting(true)
    try {
      const effectiveName = requiresCitadel
        ? (authMe?.user?.name || authMe?.user?.email || 'Reader')
        : authorName.trim()
      const effectiveEmail = requiresCitadel
        ? (authMe?.user?.email || '')
        : authorEmail.trim()
      const res = await postComment({
        type: contentType,
        slug,
        parentId: replyTarget?.id,
        authorName: effectiveName,
        authorEmail: effectiveEmail,
        authorUrl: authorUrl.trim() || undefined,
        bodyMarkdown: bodyMarkdown.trim(),
        notifyOnReply,
      })
      setBodyMarkdown('')
      setReplyTarget(null)
      setSubmitMessage(
        res.message ?? '评论已提交，将在审核通过后显示。感谢你的交流！',
      )
      void queryClient.invalidateQueries({ queryKey: ['comments', contentType, slug] })
    } catch (err) {
      if (err instanceof APIError) {
        if (err.status === 401) {
          void queryClient.invalidateQueries({ queryKey: ['public-auth-me'] })
        }
        setFormError(err.detail || err.message || '评论提交失败')
      } else {
        setFormError('评论提交失败，请稍后重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const items = data?.items ?? []
  const loginReturnTarget =
    typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}#comments`
      : '#comments'

  return (
    <section id="comments" aria-label="评论交流" className="mt-10 space-y-6">
      <div className="editorial-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
            <MessageSquare className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            <span>评论讨论（{items.length}）</span>
          </h2>
          <span className="text-xs text-[var(--text-muted)]">支持基础 Markdown 语法</span>
        </div>

        {replyTarget ? (
          <div className="mt-4 flex items-center justify-between rounded-xl bg-[var(--accent-soft)] px-3.5 py-2 text-xs text-[var(--accent)]">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
              正在回复 @{replyTarget.name}
            </span>
            <button
              type="button"
              onClick={() => setReplyTarget(null)}
              className="cursor-pointer font-semibold hover:underline"
            >
              取消回复
            </button>
          </div>
        ) : null}

        {requiresCitadel && authLoading ? (
          <div className="mt-4 h-24 animate-pulse rounded-xl bg-[var(--bg-elevated)]" />
        ) : requiresCitadel && (!authMe?.authenticated || !authMe.user) ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                请先使用 Citadel 账号登录后发表评论
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                登录后将自动绑定你的 Citadel 身份与邮箱通知设置，评论后将直接跳转回此处。
              </p>
            </div>
            <a
              href={buildPublicLoginUrl(loginReturnTarget)}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)]"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              使用 Citadel 登录并评论
            </a>
          </div>
        ) : (
        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
          {requiresCitadel && authMe?.user ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 px-3.5 py-2.5 text-xs sm:col-span-7">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">
                    {authMe.user.name || authMe.user.email}
                  </span>
                  <span className="text-[var(--text-muted)]">{authMe.user.email}</span>
                  {(authMe.user.allowAdmin || authMe.user.globalRole?.toLowerCase() === 'super_admin') && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      Author
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await logoutPublicReader()
                    await queryClient.invalidateQueries({ queryKey: ['public-auth-me'] })
                    if (res.citadelLogoutUrl) {
                      window.location.assign(res.citadelLogoutUrl)
                    }
                  }}
                  className="cursor-pointer font-medium text-[var(--text-muted)] hover:text-[var(--tone-danger)]"
                >
                  退出登录
                </button>
              </div>
              <div className="sm:col-span-5">
                <label htmlFor={urlId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                  网站主页（可选）
                </label>
                <input
                  id={urlId}
                  type="url"
                  autocorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={authorUrl}
                  onChange={(e) => setAuthorUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="editorial-input"
                />
              </div>
            </div>
          ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                昵称 <span className="text-[var(--tone-danger)]">*</span>
              </label>
              <input
                id={nameId}
                type="text"
                required
                value={authorName}
                onChange={(e) => {
                  setAuthorName(e.target.value)
                  if (formError) setFormError('')
                }}
                placeholder="怎么称呼你"
                className="editorial-input"
              />
            </div>

            <div>
              <label htmlFor={emailId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                邮箱（不公开） <span className="text-[var(--tone-danger)]">*</span>
              </label>
              <input
                id={emailId}
                type="email"
                required
                autocorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={authorEmail}
                onChange={(e) => {
                  setAuthorEmail(e.target.value)
                  if (formError) setFormError('')
                }}
                placeholder="仅用于头像与回复提醒"
                className="editorial-input"
              />
            </div>

            <div>
              <label htmlFor={urlId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                网站主页（可选）
              </label>
              <input
                id={urlId}
                type="url"
                autocorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={authorUrl}
                onChange={(e) => setAuthorUrl(e.target.value)}
                placeholder="https://example.com"
                className="editorial-input"
              />
            </div>
          </div>
          )}

          <div>
            <label htmlFor={bodyId} className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
              评论内容 <span className="text-[var(--tone-danger)]">*</span>
            </label>
            <textarea
              id={bodyId}
              required
              aria-invalid={Boolean(formError)}
              aria-describedby={formError ? errorId : undefined}
              value={bodyMarkdown}
              onChange={(e) => {
                setBodyMarkdown(e.target.value)
                if (formError) setFormError('')
              }}
              placeholder="分享你的思考、补充见解或疑问..."
              className="editorial-input editorial-textarea"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor={notifyId} className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                id={notifyId}
                type="checkbox"
                checked={notifyOnReply}
                onChange={(e) => setNotifyOnReply(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--border-strong)] accent-[var(--accent)]"
              />
              <span>有新回复时通过邮件通知我</span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? '正在提交...' : '发表评论'}
            </button>
          </div>

          {formError ? (
            <p id={errorId} role="alert" className="text-xs font-medium text-[var(--tone-danger)]">
              {formError}
            </p>
          ) : null}

          {submitMessage ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{submitMessage}</span>
            </div>
          ) : null}
        </form>
        )}
      </div>

      {items.length > 0 ? (
        <ul className="space-y-4">
          {items.map((node) => (
            <CommentCard
              key={node.id}
              node={node}
              onReply={(id, name) => {
                setReplyTarget({ id, name })
                document.getElementById(bodyId)?.focus()
              }}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
