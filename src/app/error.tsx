'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Container } from '@/components/site/container'
import { Button } from '@/components/ui/button'

/**
 * The error boundary.
 *
 * Two audiences, and the split is the whole design. The reader gets a sentence
 * saying the page failed and nothing was lost, and two ways forward — try
 * again, or go somewhere that works. The operator gets the error itself, in the
 * browser console, with the digest Next attaches to it, which is the only way
 * to tie what the reader saw to a stack trace in the server log.
 *
 * The raw error is therefore logged and never printed. A stack trace in the
 * middle of a page tells a reader nothing they can act on, and on a site whose
 * failure modes include a database that is down it can name hosts and queries
 * to whoever happens to be looking. The digest is the compromise: meaningless
 * on its own, and enough to find the corresponding entry in the log.
 *
 * A client component by necessity — `reset` is a function the boundary hands
 * down, and the boundary itself only exists on the client.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Deliberately the whole error object, not `error.message`: in development
    // the stack is the useful part, and in production React has already
    // stripped it down to what is safe to log.
    console.error('[error] a page failed to render:', error)
  }, [error])

  return (
    <Container>
      <div className="flex flex-col gap-5 py-20 sm:py-28">
        <p className="font-mono text-xs tracking-widest text-ink-subtle">ERROR</p>

        <h1 className="text-2xl tracking-tight text-ink sm:text-3xl">
          This page could not be rendered.
        </h1>

        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          Something failed on the way to producing this page. It is not something
          you did, and nothing that was already published is affected. Trying
          again often works; if it does not, the rest of the site is still there.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="button" onClick={reset} variant="outline" size="sm">
            Try again
          </Button>
          <Link href="/" className="link-underline text-sm text-ink-muted">
            Home
          </Link>
          <Link href="/search" className="link-underline text-sm text-ink-muted">
            Search
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-8 border-t border-line pt-4 font-mono text-xs text-ink-subtle">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </Container>
  )
}
