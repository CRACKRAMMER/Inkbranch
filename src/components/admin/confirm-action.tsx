'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Button, type ButtonProps } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ActionResult } from '@/lib/admin/result'

/**
 * A destructive action behind a dialog that says what it will do.
 *
 * `window.confirm` would be four lines and would also be unstyleable, unlabelled
 * for a screen reader and blocked by some browsers. More importantly the dialog
 * has room for the consequence — which files, how many, and what cannot be undone
 * — and that sentence is the point of asking at all.
 */
export interface ConfirmActionProps<P> {
  action: (payload: P) => Promise<ActionResult<unknown>>
  payload: P
  title: string
  /** The consequence, in plain words. Rendered as the dialog's description. */
  description: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  triggerLabel: string
  triggerVariant?: ButtonProps['variant']
  triggerSize?: ButtonProps['size']
  destructive?: boolean
  successMessage?: string
  /** Receives the action's data, for callers that report in more detail. */
  onSuccess?: (data: unknown) => void
}

export function ConfirmAction<P>({
  action,
  payload,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  triggerLabel,
  triggerVariant = 'secondary',
  triggerSize = 'sm',
  destructive = true,
  successMessage,
  onSuccess,
}: ConfirmActionProps<P>) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function confirm() {
    setError(null)
    startTransition(async () => {
      const result = await action(payload)
      if (!result.ok) {
        // The dialog stays open: closing it would leave the operator unsure
        // whether the thing happened.
        setError({ message: result.error, detail: result.detail })
        return
      }
      setOpen(false)
      if (successMessage) toast.success(successMessage)
      onSuccess?.(result.data)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        {triggerLabel}
      </Button>

      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm leading-relaxed text-ink-muted">{description}</div>
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-ink">
              {error.message}
              {error.detail ? (
                <span className="mt-1 block text-xs text-ink-muted">{error.detail}</span>
              ) : null}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={destructive ? 'destructive' : 'default'}
              onClick={confirm}
              disabled={pending}
            >
              {pending ? 'Working…' : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
