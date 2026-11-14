import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  Archive,
  Check,
  Copy,
  Download,
  FileWarning,
  KeyRound,
  Link2,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react'
import {
  adminApi,
  type AdminCommentRecord,
  type AdminOverviewResponse,
  type APITokenRecord,
  type AssetRecord,
  type BackupRecord,
  type FriendLinkRecord,
  type NewsletterRecord,
  type PasskeyRecord,
  type RedirectRecord,
  type SessionRecord,
  type SiteSettingsMap,
  type SubscriberRecord,
  type WebhookDeliveryRecord,
  type WebhookRecord,
} from './api'

function FeedbackBanner({ message, error }: { message?: string; error?: string }) {
  if (!message && !error) return null
  return (
    <div
      role="status"
      className={`rounded-xl border px-3.5 py-2 text-xs font-medium ${
        error
          ? 'border-[var(--tone-danger)]/40 bg-[var(--tone-danger)]/10 text-[var(--tone-danger)]'
          : 'border-[var(--tone-tip)]/40 bg-[var(--tone-tip)]/10 text-[var(--tone-tip)]'
      }`}
    >
      {error || message}
    </div>
  )
}

function PanelHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-[var(--text-primary)]">{title}</h2>
        {subtitle && <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function OverviewPanel({ onJump }: { onJump: (tab: string) => void }) {
  const [data, setData] = useState<AdminOverviewResponse | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await adminApi.overview())
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载概览失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (err) return <FeedbackBanner error={err} />
  if (!data) {
    return <div className="editorial-card h-64 animate-pulse" />
  }

  const statTiles = [
    { label: '已发布文档', value: data.content.published ?? 0, sub: `总计 ${data.content.total ?? 0}`, tab: 'editor' },
    { label: '30 天阅读量', value: data.analytics.totalViews ?? 0, sub: `独立访客 ${data.analytics.uniqueVisitors ?? 0}`, tab: 'overview' },
    { label: '待审评论 / 友链', value: (data.inbox.pendingComments ?? 0) + (data.inbox.pendingFriends ?? 0), sub: `${data.inbox.pendingComments} 评论 · ${data.inbox.pendingFriends} 友链`, tab: data.inbox.pendingComments > 0 ? 'comments' : 'friends' },
    { label: '邮件订阅 / 备份', value: data.inbox.activeSubscribers ?? 0, sub: `${data.inbox.backups ?? 0} 份站点备份`, tab: 'newsletter' },
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statTiles.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onJump(t.tab)}
            className="editorial-card editorial-card-interactive p-4 text-left"
          >
            <div className="text-xs font-medium text-[var(--text-muted)]">{t.label}</div>
            <div className="mt-1.5 text-2xl font-bold tracking-tight text-[var(--text-primary)]">{t.value}</div>
            <div className="mt-1 text-[11px] text-[var(--text-secondary)]">{t.sub}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className="editorial-card space-y-3 p-5 lg:col-span-7">
          <PanelHeader
            title="无 Cookie 隐私阅读统计 (近 30 天)"
            subtitle={`平均停留 ${Math.round((data.analytics.avgDwellMs ?? 0) / 1000)}s · 平均阅读深度 ${data.analytics.avgScrollPct ?? 0}%`}
            actions={
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                刷新
              </button>
            }
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">热门页面 Top</h3>
              {(data.analytics.topPaths ?? []).length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">暂无阅读记录</p>
              ) : (
                <div className="space-y-1.5 text-xs">
                  {(data.analytics.topPaths ?? []).slice(0, 6).map((p) => (
                    <div key={p.path} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-elevated)]/70 px-2.5 py-1.5">
                      <span className="truncate font-mono">{p.path}</span>
                      <span className="shrink-0 font-semibold">{p.views}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">来源站点 Referrer</h3>
              {(data.analytics.topReferrers ?? []).length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">暂无外链来源</p>
              ) : (
                <div className="space-y-1.5 text-xs">
                  {(data.analytics.topReferrers ?? []).slice(0, 6).map((r) => (
                    <div key={r.referrer} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-elevated)]/70 px-2.5 py-1.5">
                      <span className="truncate">{r.referrer}</span>
                      <span className="shrink-0 font-semibold">{r.views}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="editorial-card space-y-3 p-5 lg:col-span-5">
          <PanelHeader title="安全与操作审计日志" subtitle="最近关键管理员操作" />
          <div className="space-y-1.5 text-xs">
            {(data.auditLogs ?? []).length === 0 ? (
              <p className="text-[var(--text-muted)]">暂无审计记录</p>
            ) : (
              data.auditLogs.map((log) => (
                <div key={log.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5">
                  <div>
                    <span className="font-mono font-semibold text-[var(--text-primary)]">{log.action}</span>
                    {log.targetId && <span className="ml-1.5 text-[var(--text-muted)]">({log.targetId})</span>}
                  </div>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{new Date(log.createdAt).toLocaleString()}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export function MediaPanel() {
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [orphans, setOrphans] = useState<AssetRecord[]>([])
  const [altText, setAltText] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [copiedId, setCopiedId] = useState('')

  const load = useCallback(async () => {
    try {
      const [m, o] = await Promise.all([adminApi.listMedia(), adminApi.listOrphanMedia()])
      setAssets(m.items ?? [])
      setOrphans(o.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载媒体库失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleUpload = async (file: File) => {
    setErr('')
    try {
      const res = await adminApi.uploadMedia(file, altText)
      setAltText('')
      setMsg(`上传成功：${res.asset.filename} (EXIF 已清理)`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '上传失败')
    }
  }

  return (
    <div className="editorial-card space-y-5 p-5">
      <PanelHeader
        title={`媒体与附件库 (${assets.length})`}
        subtitle="支持图片自动 EXIF 隐私剥离与方向纠正、Local / Cloudflare R2 存储及孤立附件扫描"
        actions={
          <button
            type="button"
            onClick={async () => {
              const res = await adminApi.cleanOrphanMedia()
              setMsg(`已清理 ${res.deleted} 个未引用过期孤立附件`)
              await load()
            }}
            disabled={orphans.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <FileWarning className="h-3.5 w-3.5 text-[var(--tone-warning)]" aria-hidden="true" />
            清理孤立资源 ({orphans.length})
          </button>
        }
      />

      <FeedbackBanner message={msg} error={err} />

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-elevated)]/40 p-4 text-xs">
        <input
          type="text"
          value={altText}
          onChange={(e) => setAltText(e.target.value)}
          placeholder="可选图片描述 Alt Text"
          className="editorial-input !min-h-9 max-w-xs !py-1 !text-xs"
        />
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2 font-semibold text-[var(--accent-ink)]">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          上传图片 / 媒体
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleUpload(f)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {assets.map((a) => {
          const isImg = a.mimeType.startsWith('image/')
          const md = `![${a.altText || a.filename}](${a.publicUrl})`
          return (
            <div key={a.id} className="flex flex-col justify-between gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 p-3 text-xs">
              <div className="space-y-2">
                {isImg && (
                  <img
                    src={a.publicUrl}
                    alt={a.altText || a.filename}
                    loading="lazy"
                    className="h-36 w-full rounded-lg border border-[var(--border-subtle)] object-cover"
                  />
                )}
                <div className="font-semibold text-[var(--text-primary)] truncate">{a.filename}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  <span>{Math.max(1, Math.round(a.byteSize / 1024))} KB</span>
                  {a.width && a.height && <span>{a.width}×{a.height}</span>}
                  {a.exifStripped && <span className="rounded bg-[var(--tone-tip)]/15 px-1.5 py-0.5 text-[10px] text-[var(--tone-tip)]">EXIF Stripped</span>}
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(md)
                    setCopiedId(a.id)
                    window.setTimeout(() => setCopiedId(''), 1500)
                  }}
                  className="inline-flex items-center gap-1 font-medium text-[var(--accent)]"
                >
                  {copiedId === a.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  复制 Markdown
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.deleteMedia(a.id)
                    setMsg(`已删除 ${a.filename}`)
                    await load()
                  }}
                  className="text-[var(--tone-danger)] hover:underline"
                >
                  删除
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function CommentsPanel() {
  const [statusFilter, setStatusFilter] = useState('pending')
  const [items, setItems] = useState<AdminCommentRecord[]>([])
  const [replyOpenId, setReplyOpenId] = useState('')
  const [replyText, setReplyText] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await adminApi.listComments(statusFilter || undefined)
      setItems(res.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载评论列表失败')
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="editorial-card space-y-4 p-5">
      <PanelHeader
        title={`评论审核与管理 (${items.length})`}
        actions={
          <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 text-xs">
            {[
              { id: 'pending', label: '待审核' },
              { id: 'approved', label: '已通过' },
              { id: 'spam', label: '垃圾' },
              { id: '', label: '全部' },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStatusFilter(s.id)}
                className={`rounded-lg px-2.5 py-1 font-medium ${statusFilter === s.id ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : ''}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      />
      <FeedbackBanner message={msg} error={err} />

      {items.length === 0 ? (
        <p className="py-8 text-center text-xs text-[var(--text-muted)]">当前筛选条件下暂无评论</p>
      ) : (
        <div className="space-y-3">
          {items.map((c) => (
            <div key={c.id} className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-[var(--text-primary)]">{c.authorName}</span>
                  {c.isAdmin && <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">作者</span>}
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">@{c.contentType}/{c.contentSlug}</span>
                  <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] uppercase">{c.status}</span>
                </div>
                <span className="text-[11px] text-[var(--text-muted)]">{new Date(c.createdAt).toLocaleString()}</span>
              </div>

              <div className="prose-article rounded-lg bg-[var(--bg-surface)] p-3 text-sm" dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />

              <div className="flex flex-wrap items-center gap-2">
                {c.status !== 'approved' && (
                  <button
                    type="button"
                    onClick={async () => {
                      await adminApi.moderateComment(c.id, { status: 'approved' })
                      setMsg('已审核通过')
                      await load()
                    }}
                    className="rounded-lg bg-[var(--accent)] px-2.5 py-1 font-semibold text-[var(--accent-ink)]"
                  >
                    通过
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.moderateComment(c.id, { status: 'spam' })
                    setMsg('已标记垃圾')
                    await load()
                  }}
                  className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1"
                >
                  标记垃圾
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.moderateComment(c.id, { pinned: !c.pinned })
                    setMsg(c.pinned ? '已取消置顶' : '已置顶评论')
                    await load()
                  }}
                  className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1"
                >
                  {c.pinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  onClick={() => setReplyOpenId(replyOpenId === c.id ? '' : c.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1"
                >
                  <MessageSquare className="h-3 w-3" aria-hidden="true" />
                  作者回复
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.deleteComment(c.id)
                    setMsg('评论已删除')
                    await load()
                  }}
                  className="ml-auto text-[var(--tone-danger)] hover:underline"
                >
                  删除
                </button>
              </div>

              {replyOpenId === c.id && (
                <div className="flex flex-col gap-2 pt-2">
                  <textarea
                    rows={2}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="输入作者回复 Markdown（自动批准父评论并推送邮件通知）..."
                    className="editorial-input !min-h-16 !text-xs"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        await adminApi.replyComment(c.id, replyText)
                        setReplyText('')
                        setReplyOpenId('')
                        setMsg('已发表作者回复')
                        await load()
                      }}
                      className="rounded-lg bg-[var(--accent)] px-3 py-1 font-semibold text-[var(--accent-ink)]"
                    >
                      发送回复
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FriendsPanel() {
  const [items, setItems] = useState<FriendLinkRecord[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [desc, setDesc] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await adminApi.listFriends()
      setItems(res.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载友链失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="editorial-card space-y-5 p-5">
      <PanelHeader
        title={`友链与订阅朋友圈 (${items.length})`}
        actions={
          <button
            type="button"
            onClick={async () => {
              const res = await adminApi.pollFriends()
              setMsg(`已抓取 ${res.checked} 个友链订阅源，新增/更新 ${res.itemsUpdated} 条动态`)
              await load()
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)]"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            立即轮询友链 RSS
          </button>
        }
      />
      <FeedbackBanner message={msg} error={err} />

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await adminApi.createFriend({ name, url, feedUrl, description: desc, status: 'active' })
            setName('')
            setUrl('')
            setFeedUrl('')
            setDesc('')
            setMsg('友链已添加')
            await load()
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : '添加失败')
          }
        }}
        className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3 sm:grid-cols-5"
      >
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="站点名称" className="editorial-input !min-h-9 !py-1 !text-xs" />
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" className="editorial-input !min-h-9 !py-1 !text-xs" />
        <input type="url" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="RSS/Atom URL" className="editorial-input !min-h-9 !py-1 !text-xs" />
        <input required value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话简介" className="editorial-input !min-h-9 !py-1 !text-xs" />
        <button type="submit" className="inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)]">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          添加友链
        </button>
      </form>

      <div className="space-y-2 text-xs">
        {items.map((fl) => (
          <div key={fl.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] p-3">
            <div>
              <div className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                <span>{fl.name}</span>
                <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] uppercase">{fl.status}</span>
              </div>
              <div className="text-[var(--text-muted)]">{fl.url} {fl.feedUrl ? `· ${fl.feedUrl}` : ''}</div>
            </div>
            <div className="flex items-center gap-2">
              {fl.status !== 'active' && (
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.updateFriend(fl.id, { status: 'active' })
                    setMsg(`已通过友链：${fl.name}`)
                    await load()
                  }}
                  className="rounded-lg bg-[var(--accent)] px-2.5 py-1 font-semibold text-[var(--accent-ink)]"
                >
                  通过审核
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  await adminApi.deleteFriend(fl.id)
                  setMsg(`已移除友链：${fl.name}`)
                  await load()
                }}
                className="text-[var(--tone-danger)] hover:underline"
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function NewsletterPanel() {
  const [subs, setSubs] = useState<SubscriberRecord[]>([])
  const [campaigns, setCampaigns] = useState<NewsletterRecord[]>([])
  const [subject, setSubject] = useState('')
  const [bodyMarkdown, setBodyMarkdown] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([adminApi.listSubscribers(), adminApi.listCampaigns()])
      setSubs(s.items ?? [])
      setCampaigns(c.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载邮件订阅数据失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader title="群发 Newsletter 通讯" subtitle="自动附加 RFC 8058 一键退订头与 Double Opt-In 状态过滤" />
        <FeedbackBanner message={msg} error={err} />
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr('')
            try {
              const res = await adminApi.sendCampaign({ subject, bodyMarkdown })
              setSubject('')
              setBodyMarkdown('')
              setMsg(`发送完成：成功 ${res.campaign.sentCount}，失败 ${res.campaign.failedCount}`)
              await load()
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : '群发失败')
            }
          }}
          className="space-y-3 text-xs"
        >
          <input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="邮件主题 Subject" className="editorial-input !min-h-9 !py-1.5 !text-xs" />
          <textarea required rows={6} value={bodyMarkdown} onChange={(e) => setBodyMarkdown(e.target.value)} placeholder="Markdown 正文..." className="editorial-input !text-xs" />
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]">
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            发送给已激活订阅者
          </button>
        </form>

        <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3 text-xs">
          <h3 className="font-semibold">历史投递记录 ({campaigns.length})</h3>
          {campaigns.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-elevated)]/60 px-3 py-2">
              <span className="font-medium">{c.subject}</span>
              <span className="text-[var(--text-muted)]">送达 {c.sentCount} · {new Date(c.createdAt).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="editorial-card space-y-3 p-5 lg:col-span-6">
        <PanelHeader title={`订阅者列表 (${subs.length})`} />
        <div className="space-y-2 text-xs">
          {subs.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] px-3 py-2">
              <div>
                <div className="font-semibold">{s.email}</div>
                <div className="text-[11px] text-[var(--text-muted)]">{s.status} · {new Date(s.createdAt).toLocaleDateString()}</div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await adminApi.deleteSubscriber(s.id)
                  await load()
                }}
                className="text-[var(--tone-danger)] hover:underline"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function SettingsRedirectsPanel() {
  const [settings, setSettings] = useState<SiteSettingsMap | null>(null)
  const [redirects, setRedirects] = useState<RedirectRecord[]>([])
  const [srcPath, setSrcPath] = useState('')
  const [dstPath, setDstPath] = useState('')
  const [statusCode, setStatusCode] = useState(301)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([adminApi.getSettings(), adminApi.listRedirects()])
      setSettings(s.settings)
      setRedirects(r.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载配置失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader title="站点动态配置" subtitle="即时生效（RSS 全文/摘要、评论模式、站点标题）" />
        <FeedbackBanner message={msg} error={err} />
        {settings && (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setErr('')
              try {
                const res = await adminApi.putSettings(settings)
                setSettings(res.settings)
                setMsg('站点配置已保存')
              } catch (ex) {
                setErr(ex instanceof Error ? ex.message : '保存设置失败')
              }
            }}
            className="space-y-3 text-xs"
          >
            <label className="block space-y-1">
              <span className="text-[var(--text-muted)]">站点名称</span>
              <input value={settings.site_name} onChange={(e) => setSettings({ ...settings, site_name: e.target.value })} className="editorial-input !min-h-9 !py-1 !text-xs" />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-muted)]">站点描述</span>
              <input value={settings.site_description} onChange={(e) => setSettings({ ...settings, site_description: e.target.value })} className="editorial-input !min-h-9 !py-1 !text-xs" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[var(--text-muted)]">RSS/Atom/JSON Feed 模式</span>
                <select
                  value={settings.feed_mode}
                  onChange={(e) => setSettings({ ...settings, feed_mode: e.target.value as 'full' | 'summary' })}
                  className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2"
                >
                  <option value="full">full (完整正文)</option>
                  <option value="summary">summary (仅摘要)</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[var(--text-muted)]">评论系统模式</span>
                <select
                  value={settings.comments_mode}
                  onChange={(e) => setSettings({ ...settings, comments_mode: e.target.value as 'builtin' | 'giscus' | 'off' })}
                  className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2"
                >
                  <option value="builtin">内置嵌套评论</option>
                  <option value="giscus">Giscus</option>
                  <option value="off">全站关闭</option>
                </select>
              </label>
            </div>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(settings.comment_auto_approve)}
                onChange={(e) => setSettings({ ...settings, comment_auto_approve: e.target.checked })}
              />
              新评论免人工审核自动发布
            </label>
            {settings.comments_mode === 'giscus' && (
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--bg-elevated)]/60 p-3">
                <input placeholder="giscus repo" value={settings.giscus_repo ?? ''} onChange={(e) => setSettings({ ...settings, giscus_repo: e.target.value })} className="editorial-input !min-h-8 !text-xs" />
                <input placeholder="repoId" value={settings.giscus_repo_id ?? ''} onChange={(e) => setSettings({ ...settings, giscus_repo_id: e.target.value })} className="editorial-input !min-h-8 !text-xs" />
                <input placeholder="category" value={settings.giscus_category ?? ''} onChange={(e) => setSettings({ ...settings, giscus_category: e.target.value })} className="editorial-input !min-h-8 !text-xs" />
                <input placeholder="categoryId" value={settings.giscus_category_id ?? ''} onChange={(e) => setSettings({ ...settings, giscus_category_id: e.target.value })} className="editorial-input !min-h-8 !text-xs" />
              </div>
            )}
            <div>
              <button type="submit" className="rounded-xl bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]">
                保存站点配置
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader title={`路由重定向 (${redirects.length})`} subtitle="内置环形回路检测，保护历史 SEO 权重" />
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr('')
            try {
              await adminApi.createRedirect({ sourcePath: srcPath, targetPath: dstPath, statusCode })
              setSrcPath('')
              setDstPath('')
              setMsg('重定向规则已添加')
              await load()
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : '添加失败')
            }
          }}
          className="grid grid-cols-1 gap-2 sm:grid-cols-4 text-xs"
        >
          <input required value={srcPath} onChange={(e) => setSrcPath(e.target.value)} placeholder="/old-slug" className="editorial-input !min-h-9 !py-1 !text-xs" />
          <input required value={dstPath} onChange={(e) => setDstPath(e.target.value)} placeholder="/posts/new-slug" className="editorial-input !min-h-9 !py-1 !text-xs" />
          <select value={statusCode} onChange={(e) => setStatusCode(Number(e.target.value))} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2">
            <option value={301}>301 永久</option>
            <option value={302}>302 临时</option>
            <option value={308}>308 永久保留方法</option>
          </select>
          <button type="submit" className="inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)]">
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            添加
          </button>
        </form>
        <div className="space-y-1.5 text-xs">
          {redirects.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] px-3 py-2">
              <div className="font-mono">
                <span className="font-semibold">{r.sourcePath}</span> → <span>{r.targetPath}</span>{' '}
                <span className="text-[10px] text-[var(--text-muted)]">({r.statusCode} · {r.hits} hits)</span>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await adminApi.deleteRedirect(r.id)
                  await load()
                }}
                className="text-[var(--tone-danger)] hover:underline"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function TokensWebhooksPanel() {
  const [tokens, setTokens] = useState<APITokenRecord[]>([])
  const [webhooks, setWebhooks] = useState<WebhookRecord[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[]>([])
  const [selectedHookId, setSelectedHookId] = useState('')
  const [tokenName, setTokenName] = useState('')
  const [tokenScopes, setTokenScopes] = useState<string[]>(['content:read', 'content:write'])
  const [newPlainToken, setNewPlainToken] = useState('')
  const [hookName, setHookName] = useState('')
  const [hookUrl, setHookUrl] = useState('')
  const [newHookSecret, setNewHookSecret] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const [t, w] = await Promise.all([adminApi.listTokens(), adminApi.listWebhooks()])
      setTokens(t.items ?? [])
      setWebhooks(w.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载开放接口配置失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const allScopes = ['admin:*', 'content:read', 'content:write', 'media:write', 'comments:moderate', 'webhooks:manage']

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader title="Personal Access Tokens (CLI / MCP)" subtitle="Bearer 细粒度作用域 API 令牌（仅创建时明文展示一次）" />
        <FeedbackBanner message={msg} error={err} />

        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr('')
            try {
              const res = await adminApi.createToken({ name: tokenName, scopes: tokenScopes, expiresInDays: 90 })
              setNewPlainToken(res.token)
              setTokenName('')
              setMsg('PAT 令牌已签发')
              await load()
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : '创建失败')
            }
          }}
          className="space-y-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3 text-xs"
        >
          <input required value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="令牌名称（如 mcp-agent / github-ci）" className="editorial-input !min-h-9 !py-1 !text-xs" />
          <div className="flex flex-wrap gap-2">
            {allScopes.map((sc) => (
              <label key={sc} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1">
                <input
                  type="checkbox"
                  checked={tokenScopes.includes(sc)}
                  onChange={(e) =>
                    setTokenScopes((prev) => (e.target.checked ? [...prev, sc] : prev.filter((x) => x !== sc)))
                  }
                />
                <span className="font-mono">{sc}</span>
              </label>
            ))}
          </div>
          <button type="submit" className="inline-flex items-center gap-1 rounded-xl bg-[var(--accent)] px-3.5 py-1.5 font-semibold text-[var(--accent-ink)]">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            签发 PAT (90 天)
          </button>
        </form>

        {newPlainToken && (
          <div className="space-y-1 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-xs">
            <div className="font-bold">请立即复制保存，页面刷新后将不再展示：</div>
            <div className="flex items-center justify-between gap-2 font-mono">
              <code className="break-all">{newPlainToken}</code>
              <button type="button" onClick={() => void navigator.clipboard.writeText(newPlainToken)} className="shrink-0 font-semibold text-[var(--accent)]">
                复制
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2 text-xs">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] px-3 py-2">
              <div>
                <div className="font-semibold">{t.name} <span className="font-mono text-[var(--text-muted)]">({t.tokenPrefix}...)</span></div>
                <div className="text-[11px] text-[var(--text-muted)]">{t.scopes.join(', ')} {t.revokedAt ? '· 已吊销' : ''}</div>
              </div>
              {!t.revokedAt && (
                <button
                  type="button"
                  onClick={async () => {
                    await adminApi.revokeToken(t.id)
                    await load()
                  }}
                  className="text-[var(--tone-danger)] hover:underline"
                >
                  吊销
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader title="HMAC-SHA256 Webhooks" subtitle="文章发布、评论创建等事件签名推送 (`X-Inkbranch-Signature-256`)" />
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr('')
            try {
              const res = await adminApi.createWebhook({ name: hookName, targetUrl: hookUrl, events: ['*'], enabled: true })
              setNewHookSecret(res.signingSecret)
              setHookName('')
              setHookUrl('')
              setMsg('Webhook 已创建')
              await load()
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : '创建失败')
            }
          }}
          className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3 text-xs sm:grid-cols-3"
        >
          <input required value={hookName} onChange={(e) => setHookName(e.target.value)} placeholder="名称" className="editorial-input !min-h-9 !py-1 !text-xs" />
          <input required type="url" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://hook.example.com" className="editorial-input !min-h-9 !py-1 !text-xs" />
          <button type="submit" className="inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)]">
            <Webhook className="h-3.5 w-3.5" aria-hidden="true" />
            添加 Webhook
          </button>
        </form>

        {newHookSecret && (
          <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-xs">
            Signing Secret: <code className="font-mono break-all">{newHookSecret}</code>
          </div>
        )}

        <div className="space-y-2 text-xs">
          {webhooks.map((w) => (
            <div key={w.id} className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">{w.name}</div>
                  <div className="font-mono text-[11px] text-[var(--text-muted)]">{w.targetUrl}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await adminApi.testWebhook(w.id)
                        setMsg(res.ok ? `测试推送成功 (HTTP ${res.delivery?.statusCode ?? 200})` : `推送失败: ${res.error ?? 'error'}`)
                        const dl = await adminApi.listWebhookDeliveries(w.id)
                        setSelectedHookId(w.id)
                        setDeliveries(dl.items ?? [])
                      } catch (ex) {
                        setErr(ex instanceof Error ? ex.message : '测试失败')
                      }
                    }}
                    className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 hover:border-[var(--accent)]"
                  >
                    测试推送
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const dl = await adminApi.listWebhookDeliveries(w.id)
                      setSelectedHookId(w.id)
                      setDeliveries(dl.items ?? [])
                    }}
                    className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1"
                  >
                    投递日志
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await adminApi.deleteWebhook(w.id)
                      await load()
                    }}
                    className="text-[var(--tone-danger)]"
                  >
                    删除
                  </button>
                </div>
              </div>
              {selectedHookId === w.id && deliveries.length > 0 && (
                <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">
                  {deliveries.slice(0, 5).map((d) => (
                    <div key={d.id} className="flex items-center justify-between font-mono text-[11px]">
                      <span>{d.eventName} · HTTP {d.statusCode ?? 'ERR'}</span>
                      <span className="text-[var(--text-muted)]">{d.errorMessage || new Date(d.createdAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function SecurityBackupsPanel() {
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [recoveryLeft, setRecoveryLeft] = useState(0)
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [currentSessId, setCurrentSessId] = useState('')
  const [backups, setBackups] = useState<BackupRecord[]>([])

  const [curPass, setCurPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string; recoveryCodes: string[] } | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [passkeyLabel, setPasskeyLabel] = useState('MacBook / iCloud Keychain')

  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [sec, bk] = await Promise.all([adminApi.securityOverview(), adminApi.listBackups()])
      setTotpEnabled(sec.totpEnabled)
      setRecoveryLeft(sec.recoveryCodesRemaining)
      setPasskeys(sec.passkeys ?? [])
      setSessions(sec.sessions ?? [])
      setCurrentSessId(sec.currentSessionId)
      setBackups(bk.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载安全与备份数据失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <section className="editorial-card space-y-5 p-5 lg:col-span-6">
        <PanelHeader title="账户安全 · Passkey / TOTP / 会话" subtitle="Argon2id 密码哈希 + WebAuthn 无密码通行密钥" />
        <FeedbackBanner message={msg} error={err} />

        {/* Password Change */}
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr('')
            try {
              await adminApi.changePassword(curPass, newPass)
              setCurPass('')
              setNewPass('')
              setMsg('管理员密码已更新')
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : '修改密码失败')
            }
          }}
          className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3.5 text-xs"
        >
          <div className="font-bold">修改登录密码</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input required type="password" value={curPass} onChange={(e) => setCurPass(e.target.value)} placeholder="当前密码" className="editorial-input !min-h-9 !py-1 !text-xs" />
            <input required minLength={10} type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="新密码（至少 10 位）" className="editorial-input !min-h-9 !py-1 !text-xs" />
          </div>
          <button type="submit" className="rounded-xl bg-[var(--accent)] px-3.5 py-1.5 font-semibold text-[var(--accent-ink)]">
            更新密码
          </button>
        </form>

        {/* WebAuthn Passkeys */}
        <div className="space-y-2.5 rounded-xl border border-[var(--border-subtle)] p-3.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold inline-flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
              WebAuthn 通行密钥 Passkeys ({passkeys.length})
            </span>
            <div className="flex items-center gap-1.5">
              <input value={passkeyLabel} onChange={(e) => setPasskeyLabel(e.target.value)} className="editorial-input !min-h-8 w-44 !py-1 !text-xs" />
              <button
                type="button"
                onClick={async () => {
                  setErr('')
                  try {
                    await adminApi.registerPasskey(passkeyLabel)
                    setMsg('已绑定新 Passkey 设备')
                    await load()
                  } catch (ex) {
                    setErr(ex instanceof Error ? ex.message : 'Passkey 注册失败')
                  }
                }}
                className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-semibold text-[var(--accent-ink)]"
              >
                绑定 Passkey
              </button>
            </div>
          </div>
          {passkeys.map((pk) => (
            <div key={pk.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-elevated)]/60 px-3 py-1.5">
              <span>{pk.label || 'Passkey'} · 使用次数 {pk.signCount}</span>
              <button
                type="button"
                onClick={async () => {
                  await adminApi.deletePasskey(pk.id)
                  await load()
                }}
                className="text-[var(--tone-danger)]"
              >
                移除
              </button>
            </div>
          ))}
        </div>

        {/* TOTP */}
        <div className="space-y-2.5 rounded-xl border border-[var(--border-subtle)] p-3.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-bold">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
              TOTP 双步验证：{totpEnabled ? `已开启 (剩余恢复码 ${recoveryLeft})` : '未开启'}
            </span>
            {totpEnabled ? (
              <button
                type="button"
                onClick={async () => {
                  await adminApi.disableTOTP()
                  setTotpSetup(null)
                  setMsg('已关闭 TOTP')
                  await load()
                }}
                className="text-[var(--tone-danger)] hover:underline"
              >
                关闭 TOTP
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  setTotpSetup(await adminApi.setupTOTP())
                }}
                className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 font-medium hover:border-[var(--accent)]"
              >
                初始化 TOTP 密钥
              </button>
            )}
          </div>
          {totpSetup && (
            <div className="space-y-2 rounded-xl bg-[var(--bg-elevated)] p-3">
              <div>密钥 Secret: <code className="font-mono select-all">{totpSetup.secret}</code></div>
              <div className="text-[11px] break-all text-[var(--text-muted)]">URI: {totpSetup.otpauthUrl}</div>
              <div className="font-semibold">10 个一次性恢复码（请离线妥善保存）：</div>
              <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                {totpSetup.recoveryCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <div className="flex gap-2 pt-1">
                <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="输入验证器 6 位数字激活" className="editorial-input !min-h-8 !text-xs" />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await adminApi.verifyTOTP(totpCode)
                      setTotpSetup(null)
                      setTotpCode('')
                      setMsg('TOTP 双步验证已开启')
                      await load()
                    } catch (ex) {
                      setErr(ex instanceof Error ? ex.message : '验证码错误')
                    }
                  }}
                  className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1 font-semibold text-[var(--accent-ink)]"
                >
                  确认启用
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Active Sessions */}
        <div className="space-y-2 text-xs">
          <div className="inline-flex items-center gap-1.5 font-bold">
            <Activity className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
            活跃登录会话 ({sessions.length})
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] px-3 py-2">
              <div className="truncate">
                <span className="font-medium">{s.userAgent || 'Browser Session'}</span>
                {s.id === currentSessId && <span className="ml-1.5 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">当前</span>}
              </div>
              {s.id !== currentSessId && (
                <button type="button" onClick={() => void adminApi.revokeSession(s.id).then(load)} className="shrink-0 text-[var(--tone-danger)]">
                  下线
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="editorial-card space-y-4 p-5 lg:col-span-6">
        <PanelHeader
          title={`整站备份与灾备恢复 (.tar.zst · ${backups.length})`}
          subtitle="打包数据库快照 + content/ + uploads/ + SHA-256 manifest（恢复前自动创建回滚点）"
          actions={
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const res = await adminApi.createBackup()
                  setMsg(`备份已生成：${res.backup.filename}`)
                  await load()
                } catch (ex) {
                  setErr(ex instanceof Error ? ex.message : '备份失败')
                } finally {
                  setBusy(false)
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)]"
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              立即创建整站备份
            </button>
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-elevated)]/40 p-3 text-xs">
          <span>从外部 `.tar.zst` 归档文件恢复：</span>
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 font-medium hover:border-[var(--accent)]">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            上传并恢复
            <input
              type="file"
              accept=".tar.zst,.zst"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file || !window.confirm(`确认从 ${file.name} 恢复站点？系统会先自动保存一份回滚备份。`)) return
                setBusy(true)
                try {
                  await adminApi.restoreBackupFile(file)
                  setMsg('站点恢复成功')
                  await load()
                } catch (ex) {
                  setErr(ex instanceof Error ? ex.message : '恢复失败')
                } finally {
                  setBusy(false)
                }
              }}
            />
          </label>
        </div>

        <div className="space-y-2 text-xs">
          {backups.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] p-3">
              <div>
                <div className="font-mono font-semibold">{b.filename}</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {Math.max(1, Math.round(b.byteSize / 1024))} KB · {b.storageDriver} · {new Date(b.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/admin/backups/${encodeURIComponent(b.id)}/download`}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 hover:border-[var(--accent)]"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  下载
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`确认恢复到 ${b.filename}？`)) return
                    try {
                      await adminApi.restoreBackupById(b.id)
                      setMsg(`已恢复至 ${b.filename}`)
                      await load()
                    } catch (ex) {
                      setErr(ex instanceof Error ? ex.message : '恢复失败')
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1 font-semibold text-[var(--accent)]"
                >
                  <Trash2 className="hidden" />
                  恢复
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
