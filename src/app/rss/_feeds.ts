import {
  resolveTitle,
  siteIdentityFromSettings,
  type SeoDocument,
} from '@/lib/seo/metadata'
import { buildAtomFeed, buildRssFeed } from '@/lib/seo/rss'
import { getSettings, type Settings } from '@/lib/settings'

import { loadSeoDocuments } from '../sitemap'

/**
 * The half of a feed route that is not the address.
 *
 * Four feeds are served: `/rss.xml`, `/atom.xml`, and the two a topic is named
 * by — `/rss/<tag>.xml` and `/rss/category/<category>.xml`. Which documents are
 * candidates, whether the site serves feeds at all, how long a response may be
 * cached and what a failure looks like are decisions all four make, and this
 * module makes them once. The topic pair differ only in how they find their
 * topic; the flat pair only in the serialisation.
 *
 * ## Why this is not in `@/lib/seo`
 *
 * `@/lib/seo` holds pure functions over documents, which is what lets it be
 * tested without a database or a settings row. Everything below reaches for
 * both, so it lives on the routing side of that line, beside the URLs it
 * serves. The leading underscore is Next's convention for a file in the app
 * directory that is compiled and imported but never served as a route.
 *
 * ## What is deliberately not here
 *
 * The URL shape. Which segment names a tag and which names a category is a
 * property of the address rather than of the response, so each route reads its
 * own — and the page that links to a feed builds the same path it links to,
 * which is what keeps a link from pointing at something no route serves.
 */

/** One hour at the edge, matching the sitemap's policy in ARCHITECTURE.md. */
const CACHE_CONTROL = 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400'

/**
 * Content types, spelled out rather than derived from the format name.
 *
 * `application/rss+xml` is not `application/${format}+xml` by accident of
 * history — RSS 2.0's registered type is the one every reader expects, and a
 * format added later would not follow the same pattern.
 */
const CONTENT_TYPE: Record<FeedFormat, string> = {
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
}

/** The two serialisations of the same items. */
export type FeedFormat = 'rss' | 'atom'

export interface FeedRequest {
  format: FeedFormat
  /** Site-relative path this feed is served from, e.g. `/rss/linux.xml`. */
  selfUrl: string
  /**
   * Feed title, before the site's own suffix. Defaults to the site name.
   *
   * It is run through `resolveTitle`, so a topic feed reads as
   * `#linux · My Blog` — with whatever separator the site has configured — and
   * a subscriber looking at a list of feeds can tell whose a topic is.
   */
  title?: string
  /** Feed description. Defaults to the site's. */
  description?: string
  /**
   * Which of the site's documents this feed carries. Absent means all of them.
   *
   * Applied to the candidates *before* `feedItems` sorts and cuts them to the
   * item limit. That order is the whole point: filtering afterwards would take
   * the newest thirty documents on the site and then discard the ones outside
   * the topic, so a tag feed would be empty whenever the site published a busy
   * month — and empty for a reason nothing on the page could explain.
   */
  matches?: (doc: SeoDocument) => boolean
}

/** A feed addressed by topic: everything a feed request is except its format. */
export type TopicFeed = Omit<FeedRequest, 'format'>

/* -------------------------------------------------------------------------- */
/*  Addresses                                                                  */
/* -------------------------------------------------------------------------- */

const FEED_SUFFIX = '.xml'

/**
 * The topic a feed URL names: `linux.xml` → `linux`.
 *
 * `null` when the segment is not a feed address — no `.xml`, or nothing before
 * it — which callers answer as a 404 rather than as an empty feed. A URL that
 * is not a feed is not a topic with nothing in it, and a reader that is handed
 * an empty feed may well unsubscribe from a topic that never existed.
 *
 * The suffix is part of the address rather than an extension a client asks for,
 * and it is stated here because both topic routes have to agree on it: it is
 * why a category genuinely called `linux.xml` is served from
 * `/rss/category/linux.xml.xml`.
 */
export function feedSlug(segment: string): string | null {
  if (!segment.endsWith(FEED_SUFFIX)) return null
  const slug = segment.slice(0, -FEED_SUFFIX.length)
  return slug.length > 0 ? slug : null
}

/**
 * 404: there is no feed here.
 *
 * One answer for every reason a topic yields nothing — a segment that is not a
 * feed address, a tag with no published content behind it, a category no
 * document carries. The reader cannot act on the difference, and the honest
 * part of the answer is already in the status.
 */
export function feedNotFound(): Response {
  return textResponse('No feed is served at this address.', 404)
}

/** 404: the site has switched feeds off. See `SiteSettings.rssEnabled`. */
function feedsDisabled(): Response {
  return textResponse('Feeds are disabled on this site.', 404)
}

function textResponse(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Never cached: a 404 here is about the site's current state, and it is
      // exactly the answer that goes stale when an author publishes.
      'cache-control': 'no-store',
    },
  })
}

/* -------------------------------------------------------------------------- */
/*  Responses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Serve a site-wide feed: `/rss.xml` or `/atom.xml`.
 *
 * `selfUrl` is passed as a site-relative path and resolved to an absolute one
 * inside the feed, because `atom:link rel="self"` has to be absolute for an
 * aggregator that was handed the feed by a proxy — and `absoluteUrl` is what
 * guarantees it, rather than the request's own `Host`, which a proxy decides.
 */
export async function serveFeed(request: FeedRequest): Promise<Response> {
  const settings = await getSettings()
  if (!settings.rssEnabled) return feedsDisabled()

  return render(request, settings)
}

/**
 * Serve a feed addressed by topic, which the site may have nothing behind.
 *
 * `resolve` returns `null` when there is no such topic — a tag with nothing
 * published behind it, a category no visible document carries — and the answer
 * is then `feedNotFound()`: the topic does not exist, so neither does a feed
 * for it.
 *
 * The switch is asked *before* `resolve` is called. With feeds off, whether a
 * topic exists is not a question the answer depends on, and a site that has
 * turned its feeds off should not be telling a stranger — or a crawler walking
 * guessed URLs — which tags have published content behind them.
 */
export async function serveTopicFeed(
  resolve: () => Promise<TopicFeed | null>,
): Promise<Response> {
  const settings = await getSettings()
  if (!settings.rssEnabled) return feedsDisabled()

  const topic = await resolve()
  if (!topic) return feedNotFound()

  return render({ ...topic, format: 'rss' }, settings)
}

/**
 * The document itself.
 *
 * A failure is a 500 and never an empty feed. An empty feed is a statement —
 * "this site has published nothing", or "nothing is filed under this topic" —
 * and a reader that receives one may unsubscribe; a reader that gets an error
 * keeps what it has and tries again later. The cause goes to the log, because
 * the body of a public endpoint's error is not the place for it.
 */
async function render(request: FeedRequest, settings: Settings): Promise<Response> {
  const site = siteIdentityFromSettings(settings)

  try {
    const candidates = await loadSeoDocuments()
    const documents = request.matches
      ? candidates.filter(request.matches)
      : candidates

    const options = {
      site,
      documents,
      selfUrl: request.selfUrl,
      title: request.title ? resolveTitle(request.title, site) : undefined,
      description: request.description,
      limit: settings.rssItemLimit,
    }

    const xml =
      request.format === 'rss' ? buildRssFeed(options) : buildAtomFeed(options)

    return new Response(xml, {
      headers: {
        // `charset` is not optional: the feed carries Chinese titles, and a
        // reader that guesses Latin-1 renders them as mojibake.
        'content-type': `${CONTENT_TYPE[request.format]}; charset=utf-8`,
        'cache-control': CACHE_CONTROL,
      },
    })
  } catch (error) {
    console.error(
      `[${request.format}] feed could not be generated:`,
      error instanceof Error ? error.message : error,
    )
    return textResponse('The feed could not be generated. See the server log.', 500)
  }
}
