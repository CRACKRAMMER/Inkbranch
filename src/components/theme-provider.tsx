'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

/**
 * Theme wiring.
 *
 * `attribute="class"` rather than `data-theme`, because `globals.css` defines
 * `.dark` as a custom variant and the whole palette is scoped to it. The theme
 * resolves before paint via next-themes' inline script, which is what stops a
 * dark reader seeing a white flash.
 *
 * `disableTransitionOnChange` matters more than it sounds: the entire palette is
 * CSS custom properties, so without it every colour on the page transitions at
 * once and the switch reads as a slow smear rather than an instant change.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
