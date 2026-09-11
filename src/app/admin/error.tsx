'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

/**
 * The admin's error boundary.
 *
 * There is a root boundary above this one, and it is written for a reader of the
 * public site: it says the page could not be rendered and offers the way home.
 * An operator needs one thing it cannot say, which is that a failed *read* is
 * not a failed *write* — the pages here are mostly queries over the content
 * index, and an error while rendering one of them means the screen is missing
 * data, not that a file was touched. The other thing they need is the digest,
 * which is what ties this page to a stack trace in the server log.
 *
 * The error itself is deliberately not printed. It can name a host, a relation
 * or a file path, and a screenshot of an admin page is a thing people send to
 * other people. The console gets the whole object; the page gets the digest.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    // The whole object rather than `error.message`: in development the stack is
    // the useful part, and React has already stripped it down in production.
    console.error('[admin] a page failed to render:', error)
  }, [error])

  return (
    <div className="mx-auto w-full max-w-[46rem]">
      <div className="border border-danger/40 bg-danger/5 px-5 py-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">Error</p>
        <h1 className="mt-2 font-serif text-xl tracking-tight text-ink">
          This admin page could not be rendered.
        </h1>
        <p className="mt-3 max-w-[36rem] text-sm leading-relaxed text-ink-muted">
          The failure was in reading or rendering, so nothing you were editing has been written by
          it. If you had unsaved text in the editor, do not reload — go back to it and copy the
          buffer out first, because the buffer lives in that page and this one replaced it.
        </p>
        {error.digest ? (
          <p className="mt-3 text-xs text-ink-muted">
            Server log identifier: <span className="font-mono text-ink">{error.digest}</span>
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => retry()}>
            Try again
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <Link href="/admin">Dashboard</Link>
          </Button>
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link href="/admin/system">System and audit</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
