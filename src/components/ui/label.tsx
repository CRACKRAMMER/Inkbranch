'use client'

import * as React from 'react'
import { Label as LabelPrimitive } from '@radix-ui/react-label'

import { cn } from '@/lib/utils/cn'

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive>) {
  return (
    <LabelPrimitive
      data-slot="label"
      className={cn(
        'flex select-none items-center gap-2 text-sm font-medium leading-none',
        'peer-disabled:pointer-events-none peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
