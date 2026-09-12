import type { ContentType } from '@/lib/content/kinds'

/**
 * How a content type is named in front of a reader.
 *
 * The site spells the three types three ways, and the differences are not
 * accidents: `post` in a URL, `Post` in the admin — where the reader is the
 * author and the jargon is theirs — and `Article` on the public site, because
 * "posts" is a word about a CMS rather than about writing. Only this last one is
 * shared, and it has to be: a tag page, a search result and the about page all
 * list several types together and all have to say which one a row is.
 *
 * It lives here rather than in each page because two copies of it had already
 * drifted into `tags/[tag]` and `search` as `Record<string, string>` — untyped,
 * which is what let the drift happen: a `Record<string, string>` cannot notice a
 * type being renamed.
 */
export const TYPE_LABELS: Record<ContentType, string> = {
  post: 'Article',
  note: 'Note',
  project: 'Project',
}

/**
 * The same three types, naming *several* of them.
 *
 * A search that groups its results by type puts one of these above each group,
 * and a group heading that read "Article" over three articles would be a
 * mislabel rather than a style. Written out rather than derived by appending an
 * `s`, because the next type to be added is exactly the one where that rule
 * produces a word nobody wrote.
 */
export const TYPE_GROUP_LABELS: Record<ContentType, string> = {
  post: 'Articles',
  note: 'Notes',
  project: 'Projects',
}
