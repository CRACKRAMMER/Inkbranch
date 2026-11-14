import { useId, useState, type FormEvent } from 'react'
import { CheckCircle2, Mail, Send } from 'lucide-react'
import { APIError, subscribeNewsletter } from '../lib/api'

interface NewsletterBoxProps {
  compact?: boolean
  lang?: string
}

export function NewsletterBox({ compact = false, lang = 'zh-CN' }: NewsletterBoxProps) {
  const inputId = useId()
  const errId = useId()
  const [email, setEmail] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success'>('idle')
  const [serverMessage, setServerMessage] = useState('')

  const validateEmail = (val: string) => {
    const trimmed = val.trim()
    if (!trimmed) return '请输入邮箱地址'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return '邮箱格式不正确，请检查后重试'
    }
    return ''
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const v = validateEmail(email)
    if (v) {
      setErrorMsg(v)
      return
    }
    setErrorMsg('')
    setStatus('submitting')
    try {
      const res = await subscribeNewsletter({ email: email.trim(), lang })
      setStatus('success')
      setServerMessage(
        res.message ?? '确认邮件已发送至您的收件箱，点击邮件内链接即可完成订阅。',
      )
      setEmail('')
    } catch (err) {
      setStatus('idle')
      if (err instanceof APIError) {
        setErrorMsg(err.detail || err.message || '订阅暂不可用，请稍后重试')
      } else {
        setErrorMsg('网络请求失败，请稍后重试')
      }
    }
  }

  return (
    <section
      aria-label="Newsletter 订阅"
      className={
        compact
          ? 'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]'
          : 'editorial-card p-6 sm:p-7'
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <Mail className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight text-[var(--text-primary)]">
            订阅新文章与技术通讯
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            双确认（Double Opt-in）无打扰投递，新长文发布时推送到您的邮箱，随时一键退订。
          </p>
        </div>
      </div>

      {status === 'success' ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{serverMessage}</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="mt-4">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-stretch">
            <div className="flex-1">
              <label htmlFor={inputId} className="visually-hidden">
                订阅邮箱地址
              </label>
              <input
                id={inputId}
                type="email"
                name="email"
                required
                autoComplete="email"
                autocorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (errorMsg) setErrorMsg('')
                }}
                onBlur={() => {
                  if (email.trim()) {
                    setErrorMsg(validateEmail(email))
                  }
                }}
                aria-invalid={errorMsg ? 'true' : undefined}
                aria-describedby={errorMsg ? errId : undefined}
                className="editorial-input"
              />
            </div>
            <button
              type="submit"
              disabled={status === 'submitting'}
              className="inline-flex min-h-12 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              <span>{status === 'submitting' ? '提交中...' : '订阅更新'}</span>
            </button>
          </div>
          {errorMsg ? (
            <p id={errId} role="alert" className="mt-2 text-xs font-medium text-[var(--tone-danger)]">
              {errorMsg}
            </p>
          ) : null}
        </form>
      )}
    </section>
  )
}
