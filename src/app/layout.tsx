import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'

import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/toaster'
import { siteOrigin } from '@/env'

import './globals.css'

/**
 * The three families, and why each is here.
 *
 * All three are self-hosted by `next/font` at build time, so the served page
 * makes no request to a font CDN and the CSP's `font-src 'self'` holds. The
 * subsets are narrow on purpose: a CJK web font is several megabytes, and the
 * fallback stack in `globals.css` already names the system CJK faces, which is
 * both faster and correct for the reader's locale.
 */
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: 'A technical notebook',
    template: '%s',
  },
  description: 'Notes, articles and projects on software and systems.',
  /*
   * The default. Individual pages override with an absolute canonical, and the
   * feed and sitemap advertise themselves here so a crawler finds them from any
   * entry point rather than only the home page.
   */
  alternates: {
    canonical: '/',
    types: {
      'application/rss+xml': '/rss.xml',
      'application/atom+xml': '/atom.xml',
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'A technical notebook',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * One theme colour per scheme, so the browser chrome matches the page rather
   * than flashing white above a dark canvas.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdfdfc' },
    { media: '(prefers-color-scheme: dark)', color: '#171716' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` is required by next-themes: the theme class is
     * set by an inline script before React hydrates, so the server HTML and the
     * first client render legitimately differ on this one attribute.
     */
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
        <ThemeProvider>
          {/*
           * The skip link is the first focusable thing on the page. A reader on
           * a keyboard should not have to tab through the whole header on every
           * navigation to reach the article.
           */}
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
          >
            Skip to content
          </a>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
