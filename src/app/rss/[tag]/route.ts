import { getTag } from '@/lib/content/queries'
import { tagNames } from '@/lib/seo/metadata'

import { feedNotFound, feedSlug, serveTopicFeed } from '../_feeds'

/**
 * The feed of one tag: `/rss/linux.xml`.
 *
 * The segment is a *tag slug*, the same one `/tags/linux` is addressed by, so
 * the two URLs name the same thing and a reader who has the page open has the
 * feed's address. `getTag` is the lookup for both, which is also what makes
 * "there is a page but no feed" impossible: it returns only tags with published
 * content behind them, and a slug with nothing behind it 404s here for the same
 * reason it 404s there.
 *
 * The topic pair of routes is dynamic and this one is not — `/rss/category/…`
 * is a static segment beside it, so a two-segment path is always a tag.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ tag: string }> },
): Promise<Response> {
  const { tag } = await context.params

  const slug = feedSlug(tag)
  if (!slug) return feedNotFound()

  return serveTopicFeed(async () => {
    const found = await getTag(slug)
    if (!found) return null

    return {
      // Built from the tag's own slug rather than from the segment that was
      // asked for: a feed is one document, and `atom:link rel="self"` has to
      // name the address it is really served from. A slug the URL spelled
      // differently — upper case, say — is a slug this site does not store, so
      // one of the two would be wrong.
      selfUrl: `/rss/${encodeURIComponent(found.slug)}.xml`,
      title: `#${found.name}`,
      description: found.description || `Entries tagged “${found.name}”.`,
      /*
       * Matched by name, because the name is what a document carries:
       * `loadSeoDocuments` joins the tags table and hands out tag *names*,
       * which is all `feedItems` and the serialisers need.
       *
       * The tags table has no unique index on `name` — only on `slug` — so this
       * would be wrong if two rows could share one. They cannot: the sync
       * engine derives the slug from the name and upserts on the slug, and the
       * admin refuses a rename that would land on an existing slug (offering a
       * merge instead). A duplicate name would need a row created with a slug
       * its name does not produce, and no path creates one.
       */
      matches: (doc) => tagNames(doc.tags).includes(found.name),
    }
  })
}
