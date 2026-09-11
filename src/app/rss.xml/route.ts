import { siteIdentityFromSettings } from '@/lib/seo/metadata'
import { buildRssFeed } from '@/lib/seo/rss'
import { getSettings } from '@/lib/settings'

import { loadSeoDocuments } from '../sitemap'

/**
 * RSS 2.0.
 *
 * The whole document — escaping, GUIDs, the item limit, `lastBuildDate` — comes
 * from `buildRssFeed`, which is where the rules are stated once and tested. This
 * handler's only jobs are to decide what a reader is served, to say how long it
 * may be cached, and to fail out loud.
 *
 * `selfUrl` is passed as the site-relative path and resolved to an absolute one
 * inside the feed: `atom:link rel="self"` has to be absolute for an aggregator
 * that was handed the feed by a proxy, and `absoluteUrl` is what guarantees it
 * rather than the request's own `Host`, which a proxy decides.
 */

/**
 * Rendered per request. A feed is a document that changes when content does —
 * caching it in the build output would freeze the archive at build time, and
 * the build has no database to read anyway.
 */
export const dynamic = 'force-dynamic'

/** One hour at the edge, matching the sitemap's policy in ARCHITECTURE.md. */
const CACHE_CONTROL = 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400'

export async function GET(): Promise<Response> {
  const settings = await getSettings()

  // A feed the site has stopped advertising is not served. The setting hides
  // the links; answering here as well is what makes it a switch rather than a
  // cosmetic preference, and a plain 404 is what a reader already does with a
  // feed that has gone away.
  if (!settings.rssEnabled) {
    return new Response('Feeds are disabled on this site.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  try {
    const xml = buildRssFeed({
      site: siteIdentityFromSettings(settings),
      documents: await loadSeoDocuments(),
      selfUrl: '/rss.xml',
      limit: settings.rssItemLimit,
    })

    return new Response(xml, {
      headers: {
        // `charset` is not optional: the feed carries Chinese titles, and a
        // reader that guesses Latin-1 renders them as mojibake.
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': CACHE_CONTROL,
      },
    })
  } catch (error) {
    // An empty feed would be a lie — "this site has published nothing" — and a
    // reader that receives one may well unsubscribe. A failure says so.
    console.error(
      '[rss] feed could not be generated:',
      error instanceof Error ? error.message : error,
    )
    return new Response('The feed could not be generated. See the server log.\n', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
