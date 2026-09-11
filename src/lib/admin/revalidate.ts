import { revalidatePath } from 'next/cache'

import type { ContentType } from '@/lib/content/schema'
import { documentUrl } from '@/lib/content/paths'
import { invalidateSearchIndex } from '@/lib/search/local'
import { segmentForType } from './routes'

/**
 * Invalidate everything a content change could have altered.
 *
 * ## Why this is one function and not three lines in each caller
 *
 * It was three lines in each caller, and the two callers disagreed. Saving a
 * document invalidated its page and its admin list; restoring a revision did
 * the same; and neither invalidated the pages that *aggregate* documents — the
 * home page's Featured and Recent Writing blocks, the archive, each tag
 * listing, the series, the graph. It was not a decision anyone made. It was
 * what happens when the set of pages a change affects is re-derived at every
 * call site, and the consequence is invisible, because a stale cache looks
 * exactly like a site nobody has updated.
 *
 * So the set is derived once, here, and derived pessimistically: the whole
 * public tree is invalidated rather than a list. A list would be correct on the
 * day it was written and wrong the moment a page was added — and this site adds
 * pages (an author's post appears on the home page, in the archive, under four
 * tags, in a series, in the graph, and as a backlink on everything it links to).
 *
 * Discarding the tree is affordable precisely because this runs when an author
 * presses publish, not per request. Changes that arrive any other way — a file
 * dropped into `content/`, a `content:sync`, the worker flipping a scheduled
 * post to published — are covered by nothing here, because they do not run in
 * this process; they are why the public tree renders on demand rather than
 * against a timer.
 *
 * Callers add their own admin paths on top; this covers the public side and the
 * document's own list.
 *
 * ## Two caches, not one
 *
 * `revalidatePath` handles Next's cache. The second cache is the search index,
 * which the local provider builds by reading the content files and holds in
 * memory, keyed on a fingerprint of the tree with a five-second time to live.
 *
 * Nothing invalidated it, so a post published from the admin was invisible to
 * search for up to five seconds — and, because the cached index outlives any
 * single request, a search that ran *before* the change could keep answering
 * from the old tree for a further five. That window is not visible in the
 * admin: the document saves, the page renders, and only search disagrees.
 *
 * Calling this here rather than at each write site is the same argument as
 * above: every caller that should invalidate one cache should invalidate both,
 * and a function that fixes only the one it was written for is how the two come
 * apart again.
 */
export function revalidateContentChange(type: ContentType, slug: string): void {
  revalidatePath(documentUrl(type, slug))
  revalidatePath(`/admin/${segmentForType(type)}`)
  revalidatePath('/', 'layout')
  invalidateSearchIndex()
}
