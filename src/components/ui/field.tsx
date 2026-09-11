'use client'

import * as React from 'react'

import { cn } from '@/lib/utils/cn'
import { Label } from './label'

export function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field" className={cn('space-y-1.5', className)} {...props} />
}

export type FieldLabelProps = React.ComponentProps<typeof Label> & {
  required?: boolean
}

export function FieldLabel({ className, required = false, children, ...props }: FieldLabelProps) {
  return (
    <Label data-slot="field-label" className={cn('leading-none', className)} {...props}>
      {children}
      {required ? (
        <span aria-hidden="true" className="text-destructive">
          *
        </span>
      ) : null}
    </Label>
  )
}

export function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

export type FieldErrorProps = Omit<React.ComponentProps<'p'>, 'children'> & {
  children?: string | undefined
}

export function FieldError({ className, children, ...props }: FieldErrorProps) {
  if (!children) return null

  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn('text-xs text-destructive', className)}
      {...props}
    >
      {children}
    </p>
  )
}
