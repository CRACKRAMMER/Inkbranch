import { serveFeed } from '../rss/_feeds'

/**
 * Atom 1.0: the same items as `/rss.xml`, from the same list and the same
 * `feedItems`, so the two formats cannot disagree about what the site
 * published — which is the only reason both exist rather than one. The
 * differences are the serialisation and the word `alternate` in a rel
 * attribute, and both are decided by `format`.
 */

/** See the RSS handler: rendered per request, cached by shared caches. */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return serveFeed({ format: 'atom', selfUrl: '/atom.xml' })
}
