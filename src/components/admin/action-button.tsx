'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { toast } from 'sonner'

import { Button, type ButtonProps } from '@/components/ui/button'
import type { ActionResult } from '@/lib/admin/result'

/**
 * A button that runs one Server Action and reports what happened.
 *
 * The result is a value rather than a thrown error, so a refusal can be shown as
 * a message next to the thing that was refused instead of replacing the page
 * with an error boundary. Success is announced by a toast and a refresh, because
 * these buttons change server data and the screen behind them is now stale.
 */

export interface ActionButtonProps<P> {
  action: (payload: P) => Promise<ActionResult<unknown>>
  payload: P
  label: string
  /** Shown while the action is in flight; the label is not reflowed. */
  pendingLabel?: string
  successMessage?: string
  /** Receives the action's data, for callers that report in more detail. */
  onSuccess?: (data: unknown) => void
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
  disabled?: boolean
  title?: string
}

export function ActionButton<P>({
  action,
  payload,
  label,
  pendingLabel,
  successMessage,
  onSuccess,
  variant = 'secondary',
  size = 'sm',
  className,
  disabled,
  title,
}: ActionButtonProps<P>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function run() {
    startTransition(async () => {
      const result = await action(payload)
      if (!result.ok) {
        toast.error(result.error, { description: result.detail })
        return
      }
      if (successMessage) toast.success(successMessage)
      onSuccess?.(result.data)
      router.refresh()
    })
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      title={title}
      disabled={disabled || pending}
      onClick={run}
    >
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  )
}
