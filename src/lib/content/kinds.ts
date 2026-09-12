/**
 * The closed sets of values a document can take, and the types that name them.
 *
 * These used to be declared in `schema.ts`, which was fine while only the server
 * asked for them. It stopped being fine when a *client* component needed one:
 * `schema.ts` imports Zod and builds every frontmatter validator as it loads, and
 * a module is imported whole — a bundler cannot take the three string tuples and
 * leave the validator behind. So `lib/search/group.ts`, which wants nothing but
 * the list of content types so it can label a group of search hits, was pulling
 * Zod into the browser by way of `content/schema`, and every reader of the public
 * site downloaded it: a 354 KB chunk, for the word "Article".
 *
 * Nothing here has any imports, and that is the whole point of the file — it is
 * the part of the content vocabulary that is safe to reach from a client
 * component. `schema.ts` derives its validators from these rather than declaring
 * its own, so there is still exactly one list of each; this one is it.
 *
 * The rule that falls out of that, and the one worth keeping: **client code
 * imports its vocabulary from here, never from `schema.ts`.** Server code may
 * use either, since it is already paying for Zod or has no reason to care.
 */

export const CONTENT_TYPES = ['post', 'note', 'project'] as const
export const CONTENT_STATUSES = [
  'draft',
  'scheduled',
  'published',
  'archived',
] as const
export const PROJECT_STATUSES = [
  'active',
  'maintained',
  'experiment',
  'archived',
] as const

export type ContentType = (typeof CONTENT_TYPES)[number]
export type ContentStatus = (typeof CONTENT_STATUSES)[number]
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
