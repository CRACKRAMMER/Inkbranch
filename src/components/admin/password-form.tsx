'use client'

import { useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { changePasswordAction } from '@/app/admin/actions/auth'
import { MIN_PASSWORD_LENGTH, passwordStrength } from '@/lib/auth/password-policy'

/**
 * Changing the owner's password.
 *
 * ## What this form is actually for
 *
 * The credential this replaces is the only way into the admin, and until this
 * existed there was no way to replace it at all: the seed script declined to
 * touch an existing account and told the operator to use the admin, and the
 * admin had no such screen. An install whose password had been typed into a
 * shared terminal could not retire it.
 *
 * ## What it says before you press the button
 *
 * That every other device is signed out. This is the one irreversible thing the
 * form does, it happens to sessions the operator may have forgotten about, and
 * a sentence afterwards is not the same as a sentence before. The current
 * device stays signed in, which is what makes a typo in the new password
 * survivable — the alternative, signing out everywhere, locks the owner out of
 * the site over a keystroke they cannot see.
 *
 * ## Why the fields are uncontrolled
 *
 * A failed submit must leave what was typed exactly where it was. Reading the
 * values from the form on submit and never writing to them means a refused
 * attempt costs the operator one correction rather than three retypings — and
 * nothing here re-renders on typing, so a password never enters React state.
 */

/** Strength is shown for the field being typed, and only once there is something to judge. */
function StrengthMeter({ value }: { value: string }) {
  if (!value) return null

  const { score, label, suggestions } = passwordStrength(value)
  const tone =
    score >= 3 ? 'text-ink' : score === 2 ? 'text-ink-muted' : 'text-ink-subtle'

  return (
    <div aria-live="polite" className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((step) => (
          <span
            key={step}
            className={
              step < score
                ? 'h-1 w-6 rounded-full bg-ink-muted'
                : 'h-1 w-6 rounded-full bg-line'
            }
          />
        ))}
      </span>
      <span className={`text-xs ${tone}`}>{label}</span>
      {suggestions.length > 0 ? (
        <span className="text-xs text-ink-subtle">{suggestions[0]}</span>
      ) : null}
    </div>
  )
}

export function PasswordForm() {
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [newPassword, setNewPassword] = useState('')

  function submit() {
    const form = formRef.current
    if (!form) return

    const data = new FormData(form)
    const input = {
      currentPassword: String(data.get('currentPassword') ?? ''),
      newPassword: String(data.get('newPassword') ?? ''),
      confirmPassword: String(data.get('confirmPassword') ?? ''),
    }

    setFailure(null)
    setFieldErrors({})

    startTransition(async () => {
      const result = await changePasswordAction(input)

      if (!result.ok) {
        setFailure({ message: result.error, detail: result.detail })
        if (result.fieldErrors) setFieldErrors(result.fieldErrors)
        return
      }

      // Cleared, not reset: the three values are in the DOM, and leaving them
      // there would keep the new password in a form the operator has finished
      // with.
      form.reset()
      setNewPassword('')

      const { revoked } = result.data
      toast.success('Password changed.', {
        description:
          revoked === 0
            ? 'This is the only device that was signed in, so nothing else was signed out.'
            : `${revoked} other session${revoked === 1 ? '' : 's'} signed out. This device stays signed in.`,
      })
    })
  }

  const currentError = fieldErrors.currentPassword
  const newError = fieldErrors.newPassword
  const confirmError = fieldErrors.confirmPassword

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending) submit()
      }}
    >
      <Field>
        <FieldLabel htmlFor="current-password" required>
          Current password
        </FieldLabel>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={currentError ? true : undefined}
        />
        <FieldDescription>
          Required even though you are signed in: it is what proves the request is yours and not
          someone using a session they took.
        </FieldDescription>
        <FieldError>{currentError}</FieldError>
      </Field>

      <Field className="mt-6">
        <FieldLabel htmlFor="new-password" required>
          New password
        </FieldLabel>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={newError ? true : undefined}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <StrengthMeter value={newPassword} />
        <FieldError>{newError}</FieldError>
      </Field>

      <Field className="mt-6">
        <FieldLabel htmlFor="confirm-password" required>
          New password again
        </FieldLabel>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={confirmError ? true : undefined}
        />
        <FieldError>{confirmError}</FieldError>
      </Field>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </Button>
        <p className="text-xs leading-relaxed text-ink-subtle">
          Every other device is signed out. This one stays signed in.
        </p>
      </div>

      {failure ? (
        <p role="alert" className="mt-4 border-l-2 border-danger pl-3 text-sm text-ink">
          {failure.message}
          {failure.detail ? (
            <span className="mt-1 block text-xs text-ink-muted">{failure.detail}</span>
          ) : null}
        </p>
      ) : null}
    </form>
  )
}
