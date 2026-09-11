import * as React from 'react'

import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils/cn'

export type EmptyStateProps = {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {Icon ? (
        <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/50">
          <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
