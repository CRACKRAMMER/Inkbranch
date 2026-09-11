import { serveFeed } from '../rss/_feeds'

/**
 * RSS 2.0: everything the site publishes.
 *
 * The document — escaping, GUIDs, the item limit, `lastBuildDate` — comes from
 * `buildRssFeed`, which is where those rules are stated once and tested. The
 * response around it, and the choice of documents, comes from `./rss/_feeds`,
 * which is where the other three feeds get theirs. What is left here is the
 * address, so that this URL and the ones under `/rss/` cannot come to disagree
 * about what a feed is.
 */

/**
 * Rendered per request. A feed is a document that changes when content does —
 * caching it in the build output would freeze the archive at build time, and
 * the build has no database to read anyway.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return serveFeed({ format: 'rss', selfUrl: '/rss.xml' })
}
