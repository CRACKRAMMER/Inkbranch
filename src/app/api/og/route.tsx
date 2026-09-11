import { renderOgImage } from '@/lib/seo/og-image'
import { siteIdentityFromSettings } from '@/lib/seo/metadata'
import { getSettings } from '@/lib/settings'

import { listParam } from '../_params'

/**
 * Generated Open Graph cards.
 *
 * `defaultOgImageUrl` builds the URL this answers, and the two share one
 * contract: the title, the type label, the date and the terms all travel in the
 * query string, so a card is a pure function of its own URL. That is what makes
 * the response cacheable at all — a renderer that read the document itself
 * would have to be keyed by the document, and the CDN would have nothing to
 * hold on to.
 *
 * ## Why this parses leniently
 *
 * Every other route on this site refuses an unusable parameter. This one
 * ignores it, because of who is asking: the card URL is embedded in the
 * `og:image` meta tag of a page and fetched by whichever crawler is building a
 * preview. There is no one to show a 400 to, and a card that renders without a
 * date is a working preview, while a 400 is a broken one that the platform will
 * cache for as long as it likes. So a value that is not a type, not a date, or
 * not a set of terms is dropped and the rest of the card is rendered.
 *
 * ## The font
 *
 * `renderOgImage` reads the CJK subset from `public/fonts` with `node:fs`, so
 * this must be the Node runtime — the edge runtime has no filesystem, and the
 * `next/og` default font has no CJK glyphs, which for this site means a card of
 * empty boxes. The runtime is declared rather than inferred so that a future
 * edge deployment fails at build time instead of at the first share.
 */

export const runtime = 'nodejs'

/**
 * Rendered per request, cached by shared caches.
 *
 * The renderer sets its own `Cache-Control` on the response it returns — one
 * hour in a browser, a day at the edge, a week of grace — and that header is
 * the card's caching policy. Nothing here overrides it: a second policy stated
 * in this file would be the one that drifts.
 */
export const dynamic = 'force-dynamic'

/** Types that name a label on the card. `page` is a site page, not a document. */
const LABEL_TYPES = ['post', 'note', 'project', 'page'] as const

/**
 * The metadata builder truncates the title at 120 characters on its way into
 * the URL; this is the backstop for a URL typed by hand. Truncated rather than
 * refused, for the reason above — and because the card clips what will not fit
 * anyway, so a longer title costs a wasted layout pass and nothing else.
 */
const MAX_TITLE_LENGTH = 200

/** Matches the builder's `slice(0, 4)`: the footer has room for four terms. */
const MAX_TAGS = 4

/** A term longer than this is a sentence, and it would push the site off the card. */
const MAX_TAG_LENGTH = 40

/**
 * `YYYY-MM-DD` to a UTC date, or `null`.
 *
 * The round trip is checked rather than trusted: `new Date('2026-02-31…')` does
 * not fail, it rolls over into March, and a card that shows a date the URL does
 * not contain is worse than one that shows no date.
 */
function parseDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null

  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10) === value ? date : null
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams

  // Compared as strings, so an unknown type is simply not a label rather than a
  // cast that claims it is one.
  const rawType = params.get('type') ?? ''
  const label = (LABEL_TYPES as readonly string[]).includes(rawType)
    ? rawType
    : undefined

  const title = (params.get('title') ?? '').slice(0, MAX_TITLE_LENGTH)
  const tags = listParam(params.getAll('tags'))
    .map((tag) => tag.slice(0, MAX_TAG_LENGTH))
    .slice(0, MAX_TAGS)

  try {
    const settings = await getSettings()

    return await renderOgImage({
      title,
      site: siteIdentityFromSettings(settings),
      label,
      publishedAt: parseDate(params.get('date')),
      tags,
    })
  } catch (error) {
    // A card that cannot be rendered is a broken preview, and a broken preview
    // is invisible to the person whose page it belongs to — which is exactly
    // why the failure is logged rather than swallowed.
    console.error(
      '[og] the card could not be rendered:',
      error instanceof Error ? error.message : error,
    )
    return new Response('The image could not be generated. See the server log.\n', {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
}
