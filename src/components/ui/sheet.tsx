'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva } from 'class-variance-authority'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils/cn'

export type SheetSide = 'top' | 'right' | 'bottom' | 'left'

// SheetHeader renders the drag handle for the bottom sheet; the side lives on
// SheetContent, so it is threaded down instead of duplicated as a prop.
const SheetSideContext = React.createContext<SheetSide>('right')

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 overflow-y-auto rounded-none border-border bg-background p-4 transition-opacity duration-150 motion-reduce:transition-none',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b',
        bottom: 'inset-x-0 bottom-0 max-h-[80vh] rounded-t-lg border-t pt-0',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
        right: 'inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
)

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close

export function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 motion-reduce:transition-none data-[state=closed]:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

export type SheetContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: SheetSide
  /**
   * Modal sheets dim and block the page behind them, which is right for a task
   * the reader is in the middle of. A sheet opened with `modal={false}` on the
   * root — one that is a shortcut into the page rather than a step away from it
   * — must not: the dimming would be a lie about what is still usable.
   */
  overlay?: boolean
}

export function SheetContent({
  className,
  children,
  side = 'right',
  overlay = true,
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      {overlay ? <SheetOverlay /> : null}
      <SheetSideContext.Provider value={side}>
        <DialogPrimitive.Content
          data-slot="sheet-content"
          className={cn(sheetVariants({ side }), className)}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            data-slot="sheet-close"
            className="absolute right-3 top-3 rounded-sm p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:pointer-events-none"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </SheetSideContext.Provider>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, children, ...props }: React.ComponentProps<'div'>) {
  const side = React.useContext(SheetSideContext)

  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col space-y-1.5', className)}
      {...props}
    >
      {side === 'bottom' ? (
        <div
          data-slot="sheet-drag-handle"
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-10 rounded-full bg-border"
        />
      ) : null}
      {children}
    </div>
  )
}

export function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-base font-medium leading-none tracking-tight', className)}
      {...props}
    />
  )
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Sheet, SheetTrigger, SheetClose }
