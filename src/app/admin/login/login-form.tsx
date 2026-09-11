'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loginAction, type LoginState } from '../actions/auth'

/**
 * The sign-in form.
 *
 * `autoComplete` and `autoFocus` are not conveniences here: a password manager
 * is the realistic way anyone signs into a blog admin, and a form that defeats
 * one trains the operator to pick a weaker password.
 */
export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState | undefined, FormData>(
    loginAction,
    undefined,
  )

  const hasError = Boolean(state?.error)

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoFocus
          required
          maxLength={320}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? 'login-error' : undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? 'login-error' : undefined}
        />
      </div>

      {/*
        `role="alert"` so the message is announced when it appears; the form
        itself is not replaced, so focus stays where the operator left it and
        the values they typed are still there to correct.
      */}
      <div id="login-error" role="alert" aria-live="assertive" className="empty:hidden">
        {hasError ? (
          <p className="border-l-2 border-danger pl-3 text-sm text-ink">
            {state?.error}
            {state?.detail ? (
              <span className="mt-1 block text-xs text-ink-muted">{state.detail}</span>
            ) : null}
          </p>
        ) : null}
      </div>

      <SubmitButton />
    </form>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}
