import { countContent } from '@/lib/content/queries'

import { feedNotFound, feedSlug, serveTopicFeed } from '../../_feeds'

/**
 * The feed of one category: `/rss/category/linux.xml`.
 *
 * The segment is the category *as written on the document*, percent-encoded,
 * and not a slug: a category is a string in `content_index` rather than a row
 * of its own, so there is no slug to address it by (see `ListOptions.category`).
 * A category with a space in it is `/rss/category/Network%20Debugging.xml`, and
 * the match is exact and case-sensitive — a forgiving comparison would give one
 * category two feed URLs, and `atom:link rel="self"` could only name one of
 * them.
 *
 * `/rss/category` is a static segment beside `/rss/[tag]`, and Next prefers a
 * static segment, so this three-segment path is never read as a tag.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ category: string }> },
): Promise<Response> {
  const { category } = await context.params

  const name = feedSlug(category)
  if (name === null) return feedNotFound()

  return serveTopicFeed(async () => {
    /*
     * A category exists only because documents carry it, so the question "is
     * there a feed for this?" is a question about the index. Counted over the
     * visible documents — the same rule the tag lookup applies — so a category
     * that only a draft carries is not a topic, and its URL is a 404 rather
     * than an empty feed that tells a stranger which words are in an
     * unpublished draft.
     */
    if ((await countContent({ category: name })) === 0) return null

    return {
      selfUrl: `/rss/category/${encodeURIComponent(name)}.xml`,
      title: name,
      description: `Entries filed under “${name}”.`,
      // By the column, exactly as the count above counted it: the two cannot
      // disagree about which documents are in this category, because they are
      // the same comparison against the same value.
      matches: (doc) => doc.category === name,
    }
  })
}
