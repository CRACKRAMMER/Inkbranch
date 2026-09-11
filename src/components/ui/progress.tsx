'use client'

import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils/cn'

export function Progress({
  className,
  value,
  max = 100,
  style,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const percent =
    typeof value === 'number' && max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
        style={{ ...style, width: `${percent}%` }}
      />
    </ProgressPrimitive.Root>
  )
}
