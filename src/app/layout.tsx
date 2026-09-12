import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'

import { FontPreloadLink } from '@/components/content/font-preload'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/toaster'
import { siteOrigin } from '@/env'
import { UI_FONT } from '@/lib/fonts'
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

/*
 * `preload: false` on these two, and not on `Inter`.
 *
 * A preload is a promise that a resource is needed for the first paint, and the
 * promise is kept on every page this layout serves. Inter is: it sets the UI,
 * and on a page with no article on it — the home page, a tag list, the archive
 * — it is the only family any rule asks for. The serif is the prose face and
 * the mono is the code face, and neither belongs above the fold of a page that
 * has no prose or code on it.
 *
 * This is a statement about which family is worth preloading, and it is the
 * reason the build's font manifest lists Inter against `/` and not the other
 * two. It does not, on its own, put a preload in the page: `next/font`'s
 * mechanism for that is inert in this version — see `src/lib/fonts.ts` — and the
 * one hint the site does emit is written by hand there.
 *
 * Leaving them unpreloaded does not mean leaving them unloaded. All three are
 * declared in the same stylesheet, so a page that renders prose or a code block
 * fetches the family it needs when it lays that text out, a little later than a
 * preload but only on the pages that have such text, and `display: 'swap'`
 * means the fallback is readable in the meantime rather than blank.
 */
const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
  preload: false,
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  preload: false,
})

/** The three variable classes, in one string for the `<html>` element. */
const fontClasses = `${sans.variable} ${serif.variable} ${mono.variable}`

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
    /*
     * The font variables belong on `<html>`, not on `<body>`, and it is not a
     * detail of taste. `globals.css` declares
     * `--font-sans: var(--font-inter), ui-sans-serif, …` on `:root`, and a
     * custom property is substituted on the element that declares it — so on
     * `:root`, where `--font-inter` was not yet defined, the whole declaration
     * became invalid at computed-value time, `--font-sans` came out empty, and
     * `body { font-family: var(--font-sans) }` was dropped in turn. Every page
     * then inherited Tailwind's preflight stack and rendered in the system
     * font, while the fonts themselves were still fetched and never applied to
     * a glyph. On `<html>` the variables are defined where the `:root`
     * declaration can see them.
     */
    <html lang={settings.locale} className={fontClasses} suppressHydrationWarning>
      <head>
        {/*
         * The interface face, on every page there is. The article face's hint
         * is emitted by `ArticleBody` instead, because only a document route
         * paints it — `src/lib/fonts.ts` has the reasoning for both.
         */}
        <FontPreloadLink font={UI_FONT} />
      </head>
      <body>
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
