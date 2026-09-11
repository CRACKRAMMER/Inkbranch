'use client'

import { useEffect } from 'react'

/**
 * The boundary of last resort.
 *
 * This one catches a failure in the root layout itself — the theme provider, the
 * shell, anything that wraps every route — which is why it replaces the root
 * layout rather than sitting inside it. Two consequences follow, and the file is
 * shaped by both:
 *
 *   - It renders its own `<html>` and `<body>`. There is no layout above it to
 *     do that, and a document without them is not a document.
 *   - The styles are inline. The site's stylesheet is imported by the layout
 *     that just failed, so the class names the rest of the site uses may not be
 *     applied here at all — and a centred column of unstyled text is a worse
 *     answer than three lines of CSS that cannot be missing.
 *
 * The message is the same one `error.tsx` shows, deliberately: from the
 * reader's side these are the same event, and the difference between "the page
 * failed" and "the shell failed" is an operator's distinction, not theirs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global-error] the root layout failed to render:', error)
  }, [error])

  return (
    /*
     * The one page that cannot read the site's locale: it renders when the root
     * layout — which is what reads it — has already failed. English prose, so
     * English it says.
     */
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1.25rem',
          background: '#fdfdfc',
          color: '#18181b',
          fontFamily:
            'ui-sans-serif, system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
          lineHeight: 1.7,
        }}
      >
        <div style={{ maxWidth: '38rem' }}>
          <p
            style={{
              margin: 0,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.75rem',
              letterSpacing: '0.1em',
              color: '#71717a',
            }}
          >
            ERROR
          </p>

          <h1 style={{ margin: '1rem 0 0', fontSize: '1.5rem', letterSpacing: '-0.01em' }}>
            The site could not be rendered.
          </h1>

          <p style={{ margin: '1rem 0 0', fontSize: '0.875rem', color: '#52525b' }}>
            Something failed before the page could be built — most likely a
            temporary problem with the server. Nothing published has been lost.
          </p>

          <div
            style={{
              marginTop: '1.75rem',
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'center',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                font: 'inherit',
                fontSize: '0.875rem',
                padding: '0.4rem 0.75rem',
                border: '1px solid #d4d4d8',
                borderRadius: '0.375rem',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{ fontSize: '0.875rem', color: '#52525b', textUnderlineOffset: '3px' }}
            >
              Home
            </a>
          </div>

          {error.digest ? (
            <p
              style={{
                margin: '2rem 0 0',
                paddingTop: '1rem',
                borderTop: '1px solid #e4e4e7',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.75rem',
                color: '#71717a',
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  )
}
