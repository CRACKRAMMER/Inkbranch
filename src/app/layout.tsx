import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'

import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/toaster'
import { siteOrigin } from '@/env'
import { SITE_ATOM_PATH, SITE_RSS_PATH } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

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
   * The home page's own canonical, and the site's feeds.
   *
   * Every other page builds its metadata with `buildPageMetadata`, which
   * replaces `alternates` with its own canonical and re-states the feeds —
   * a page cannot inherit half of this object. So this is not the site-wide
   * default it looks like; it is the answer for the one route that renders no
   * metadata of its own. The paths come from the SEO module so that these two
   * and the ones every other page carries are the same strings.
   */
  alternates: {
    canonical: '/',
    types: {
      'application/rss+xml': SITE_RSS_PATH,
      'application/atom+xml': SITE_ATOM_PATH,
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

/**
 * The document shell.
 *
 * This is the only component that renders `<html>`, so it is the only place the
 * page's language can be declared, and a screen reader that is told the wrong
 * one reads the whole page in the wrong voice — including the parts it would
 * otherwise get right. The value comes from settings rather than from a
 * constant, because the site is bilingual by design and the setting is where
 * the author says which language the chrome is in. Each document can then
 * override it for itself, which `DocumentView` does from its own frontmatter.
 *
 * The read is memoised per request by `getSettings`, so the layouts and pages
 * that also need settings still cost one query between them. If it throws — no
 * database — this layout throws with it, and `global-error.tsx` renders its own
 * `<html>` outside this tree, which is why that file still has to spell a
 * language out by hand.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings()

  return (
    /*
     * `suppressHydrationWarning` is required by next-themes: the theme class is
     * set by an inline script before React hydrates, so the server HTML and the
     * first client render legitimately differ on this one attribute.
     */
    <html lang={settings.locale} suppressHydrationWarning>
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
