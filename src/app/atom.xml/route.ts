import { siteIdentityFromSettings } from '@/lib/seo/metadata'
import { buildAtomFeed } from '@/lib/seo/rss'
import { getSettings } from '@/lib/settings'

import { loadSeoDocuments } from '../sitemap'

/**
 * Atom 1.0.
 *
 * The same items as `/rss.xml`, from the same list and the same `feedItems`, so
 * the two formats cannot disagree about what the site published — which is the
 * only reason both exist rather than one. The differences are the serialisation
 * and the word `alternate` in a rel attribute.
 *
 * The response policy below is deliberately parallel to the RSS handler's
 * rather than shared with it: it is the part that has to be read alongside the
 * format it serves, and a helper both routes called would still have to be told
 * which content type, which self URL and which log tag it was serving.
 */

/** See the RSS handler: rendered per request, cached by shared caches. */
export const dynamic = 'force-dynamic'

const CACHE_CONTROL = 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400'

export async function GET(): Promise<Response> {
  const settings = await getSettings()

  if (!settings.rssEnabled) {
    return new Response('Feeds are disabled on this site.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  try {
    const xml = buildAtomFeed({
      site: siteIdentityFromSettings(settings),
      documents: await loadSeoDocuments(),
      selfUrl: '/atom.xml',
      limit: settings.rssItemLimit,
    })

    return new Response(xml, {
      headers: {
        'content-type': 'application/atom+xml; charset=utf-8',
        'cache-control': CACHE_CONTROL,
      },
    })
  } catch (error) {
    console.error(
      '[atom] feed could not be generated:',
      error instanceof Error ? error.message : error,
    )
    return new Response('The feed could not be generated. See the server log.\n', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
