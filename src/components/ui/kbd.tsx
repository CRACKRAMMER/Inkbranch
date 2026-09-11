import * as React from 'react'

import { cn } from '@/lib/utils/cn'

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-muted px-1 font-mono text-[11px] text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function KbdGroup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="kbd-group" className={cn('inline-flex items-center gap-0.5', className)} {...props} />
  )
}
