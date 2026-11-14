import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Fingerprint,
  Image,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  MessageSquare,
  PenTool,
  Settings2,
  ShieldCheck,
  Users,
  Webhook,
} from 'lucide-react'
import { adminApi, type AdminUser } from './api'
import { MarkdownWorkspace } from './MarkdownEditor'
import {
  CommentsPanel,
  FriendsPanel,
  MediaPanel,
  NewsletterPanel,
  OverviewPanel,
  SecurityBackupsPanel,
  SettingsRedirectsPanel,
  TokensWebhooksPanel,
} from './StudioPanels'

type StudioTab =
  | 'overview'
  | 'editor'
  | 'media'
  | 'comments'
  | 'friends'
  | 'newsletter'
  | 'settings'
  | 'integrations'
  | 'security'

const STUDIO_TABS: Array<{ id: StudioTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '概览分析', icon: LayoutDashboard },
  { id: 'editor', label: '写作台', icon: PenTool },
  { id: 'media', label: '媒体库', icon: Image },
  { id: 'comments', label: '评论审核', icon: MessageSquare },
  { id: 'friends', label: '友链', icon: Users },
  { id: 'newsletter', label: '邮件订阅', icon: Mail },
  { id: 'settings', label: '设置重定向', icon: Settings2 },
  { id: 'integrations', label: '令牌 Webhook', icon: Webhook },
  { id: 'security', label: '安全备份', icon: ShieldCheck },
]

export function AdminApp() {
  const [checking, setChecking] = useState(true)
  const [user, setUser] = useState<AdminUser | null>(null)
  const [activeTab, setActiveTab] = useState<StudioTab>('editor')

  // Login / MFA state
  const [email, setEmail] = useState('crackrammer@gmail.com')
  const [password, setPassword] = useState('')
  const [mfaToken, setMfaToken] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [toast, setToast] = useState('')

  const checkSession = useCallback(async () => {
    setChecking(true)
    try {
      const me = await adminApi.authMe()
      if (me.authenticated && me.user) {
        setUser(me.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    document.title = 'Admin Studio — Inkbranch'
    void checkSession()
  }, [checkSession])

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    try {
      const res = await adminApi.login(email, password)
      if (res.mfaRequired && res.mfaToken) {
        setMfaToken(res.mfaToken)
        setPassword('')
        return
      }
      if (res.authenticated && res.user) {
        setUser(res.user)
        setPassword('')
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '登录失败，请检查账号或密码')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleMFASubmit = async (e: FormEvent) => {
    e.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    try {
      const res = await adminApi.verifyMFA(mfaToken, mfaCode)
      if (res.authenticated && res.user) {
        setUser(res.user)
        setMfaToken('')
        setMfaCode('')
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '双步验证失败')
    } finally {
      setAuthBusy(false)
    }
  }

  const handlePasskeyLogin = async () => {
    setAuthBusy(true)
    setAuthError('')
    try {
      const res = await adminApi.loginWithPasskey(email)
      if (res.authenticated && res.user) {
        setUser(res.user)
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Passkey 登录失败')
    } finally {
      setAuthBusy(false)
    }
  }

  if (checking) {
    return (
      <div className="mx-auto max-w-md py-16">
        <div className="editorial-card h-72 animate-pulse" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-10">
        <div className="editorial-card space-y-6 p-7">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]"
            >
              <LockKeyhole className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 id="page-heading" tabIndex={-1} className="text-xl font-bold text-[var(--text-primary)]">
                Inkbranch Studio 登录
              </h1>
              <p className="text-xs text-[var(--text-muted)]">
                Argon2id + HttpOnly CSRF + TOTP + WebAuthn Passkey
              </p>
            </div>
          </div>

          {authError && (
            <div role="alert" className="rounded-xl border border-[var(--tone-danger)]/40 bg-[var(--tone-danger)]/10 px-3.5 py-2.5 text-xs font-medium text-[var(--tone-danger)]">
              {authError}
            </div>
          )}

          {mfaToken ? (
            <form onSubmit={handleMFASubmit} className="space-y-4">
              <label className="block space-y-1.5 text-xs">
                <span className="font-medium text-[var(--text-secondary)]">TOTP 6 位动态验证码 或 8 位恢复码</span>
                <input
                  required
                  autoFocus
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="123456"
                  className="editorial-input font-mono tracking-widest"
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={authBusy}
                  className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-60"
                >
                  {authBusy ? '验证中...' : '验证并进入 Studio'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMfaToken('')
                    setMfaCode('')
                  }}
                  className="rounded-xl border border-[var(--border-subtle)] px-3.5 py-2.5 text-xs"
                >
                  返回
                </button>
              </div>
            </form>
          ) : (
            <>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <label className="block space-y-1.5 text-xs">
                  <span className="font-medium text-[var(--text-secondary)]">管理员邮箱</span>
                  <input
                    required
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="editorial-input"
                  />
                </label>
                <label className="block space-y-1.5 text-xs">
                  <span className="font-medium text-[var(--text-secondary)]">登录密码</span>
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="首次启动请查看服务器 0600 初始密码文件"
                    className="editorial-input"
                  />
                </label>
                <button
                  type="submit"
                  disabled={authBusy}
                  className="w-full rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-60"
                >
                  {authBusy ? '登录中...' : '密码登录'}
                </button>
              </form>

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-[var(--border-subtle)]" />
                <span className="mx-3 shrink text-[11px] text-[var(--text-muted)]">或使用硬件 / 生物密钥</span>
                <div className="flex-grow border-t border-[var(--border-subtle)]" />
              </div>

              <button
                type="button"
                disabled={authBusy}
                onClick={() => void handlePasskeyLogin()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent)]"
              >
                <Fingerprint className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                使用 Passkey 一键登录
              </button>
            </>
          )}

          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]">
            <span>管理员：{email}</span>
            <Link to="/" className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              返回博客首页
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="editorial-card flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="page-heading" tabIndex={-1} className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
            Inkbranch Studio
          </h1>
          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--accent)]">
            {user.name} · {user.email}
          </span>
          {toast && <span className="text-xs text-[var(--tone-tip)]">{toast}</span>}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Link to="/" className="rounded-xl border border-[var(--border-subtle)] px-3 py-1.5 font-medium hover:border-[var(--accent)]">
            前台预览
          </Link>
          <button
            type="button"
            onClick={async () => {
              await adminApi.logout()
              setUser(null)
            }}
            className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] px-3 py-1.5 font-medium text-[var(--tone-danger)] hover:bg-[var(--bg-elevated)]"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            退出登录
          </button>
        </div>
      </div>

      {/* Studio Sub-Navigation */}
      <nav aria-label="Studio Sections" className="flex flex-wrap gap-1.5">
        {STUDIO_TABS.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                active
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </nav>

      {/* Active Studio Panel */}
      <div>
        {activeTab === 'overview' && <OverviewPanel onJump={(t) => setActiveTab(t as StudioTab)} />}
        {activeTab === 'editor' && (
          <MarkdownWorkspace
            onDirtyNotice={(m) => {
              setToast(m)
              window.setTimeout(() => setToast(''), 4000)
            }}
          />
        )}
        {activeTab === 'media' && <MediaPanel />}
        {activeTab === 'comments' && <CommentsPanel />}
        {activeTab === 'friends' && <FriendsPanel />}
        {activeTab === 'newsletter' && <NewsletterPanel />}
        {activeTab === 'settings' && <SettingsRedirectsPanel />}
        {activeTab === 'integrations' && <TokensWebhooksPanel />}
        {activeTab === 'security' && <SecurityBackupsPanel />}
      </div>
    </div>
  )
}

export default AdminApp
