'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { Toaster as SonnerToaster } from 'sonner'

import type { ToasterProps } from 'sonner'

const classNames = {
  toast: 'rounded-md border border-border bg-popover text-popover-foreground shadow-sm',
  description: 'text-muted-foreground',
  actionButton: 'rounded-md bg-primary text-primary-foreground',
  cancelButton: 'rounded-md bg-muted text-muted-foreground',
} satisfies NonNullable<ToasterProps['toastOptions']>['classNames']

export function Toaster({ toastOptions, ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme()

  return (
    <SonnerToaster
      position="bottom-right"
      richColors={false}
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      toastOptions={{
        ...toastOptions,
        classNames: { ...classNames, ...toastOptions?.classNames },
      }}
      {...props}
    />
  )
}
