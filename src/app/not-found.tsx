import Link from 'next/link'

import { Container } from '@/components/site/container'
import { listContent, type ContentSummary } from '@/lib/content/queries'

/**
 * The 404.
 *
 * Three things, in this order, because that is the order a reader needs them:
 * what happened, a way to keep looking, and a short list of what is actually
 * here. A bare "not found" makes the reader guess whether the site is broken,
 * the link is stale, or the page never existed — and on a site whose whole point
 * is that its URLs are stable, the honest answer is usually "the link is stale".
 *
 * The recent list is optional on purpose. It is a database read on a page that
 * is reached by definition from something that is already wrong, so a failure
 * here logs and renders the page without it rather than turning a 404 into a
 * 500. The rest of the page needs no data at all, which is why the fallback is
 * a missing section and not a missing page.
 *
 * This file sits at the root rather than in the `(site)` group, so it is the
 * boundary for `/admin` and every API path too — a mistyped admin URL lands here
 * with a link home rather than on a framework error page.
 *
 * `force-dynamic` for the same reason the site layout gives at length, and it
 * has to be repeated because this file sits outside that layout and inherits
 * nothing from it. Without it the recent list would be rendered once during
 * `next build` — from whatever database happened to be reachable, or from none
 * at all, which is the likely case and would bake an empty list into every 404
 * on the deployed site.
 */
export const dynamic = 'force-dynamic'

/** Enough to recognise the shape of the archive; not another index page. */
const RECENT_LIMIT = 5

async function recentWriting(): Promise<ContentSummary[]> {
  try {
    return await listContent({ limit: RECENT_LIMIT })
  } catch (error) {
    // Reached when the database is unreachable. The reader still gets a 404 and
    // a way home, which is the part they can act on.
    console.error(
      '[not-found] recent content could not be listed:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

export default async function NotFound() {
  const recent = await recentWriting()

  return (
    <Container>
      <div className="flex flex-col gap-5 py-20 sm:py-28">
        <p className="font-mono text-xs tracking-widest text-ink-subtle">404</p>

        <h1 className="text-2xl tracking-tight text-ink sm:text-3xl">
          This page does not exist.
        </h1>

        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          The address may be mistyped, or it may point at something that was
          moved. Nothing published here is hidden — anything that is still on the
          site can be found by searching or by browsing the index.
        </p>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1 text-sm">
          <Link href="/search" className="link-underline text-ink">
            Search the site
          </Link>
          <Link href="/" className="link-underline text-ink-muted">
            Home
          </Link>
        </div>

        {recent.length > 0 ? (
          <section aria-labelledby="recent" className="mt-10 border-t border-line pt-6">
            <h2 id="recent" className="font-mono text-xs tracking-widest text-ink-subtle">
              RECENTLY PUBLISHED
            </h2>
            <ul className="mt-4 flex flex-col gap-3">
              {recent.map((item) => (
                <li key={item.id}>
                  <Link href={item.url} className="link-underline text-sm text-ink">
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Container>
  )
}
