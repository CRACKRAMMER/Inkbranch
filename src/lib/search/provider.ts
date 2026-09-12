import type { ContentStatus, ContentType } from '@/lib/content/kinds'

/**
 * The search boundary.
 *
 * Everything above this line — the search page, the command palette, the
 * `/api/search` route — talks to `SearchProvider` and knows nothing about how
 * ranking happens. The local provider built on this repository's own index is
 * the default; a Meilisearch-backed provider implements the same interface, so
 * switching is a change to `getSearchProvider()` and an environment variable,
 * not a rewrite of the UI.
 *
 * Deliberately *not* in this interface: anything that assumes a local store.
 * No `rebuild()`, no file paths, no per-document CRUD. A remote provider may
 * need all of those, but it would drive them from its own admin path, and
 * putting them here would force the local shapes onto a remote implementation.
 */

/** One indexed document, as much of it as search needs. */
export interface SearchDocument {
  type: ContentType
  slug: string
  url: string
  title: string
  description: string
  /** Space-joined tag names. */
  tags: string[]
  headings: string[]
  /** Plain text of the body, with Markdown removed. */
  body: string
  status: ContentStatus
  publishedAt: Date | null
  updatedAt: Date
  category: string | null
  featured: boolean
}

export interface SearchQuery {
  /** The raw query string, exactly as the user typed it. */
  q: string
  /** Restrict to these content types. Empty or absent means all of them. */
  types?: readonly ContentType[]
  /** Restrict to documents carrying at least one of these tags. */
  tags?: readonly string[]
  /**
   * Restrict to these categories, compared case-insensitively.
   *
   * A category is a string on the document rather than a row with a slug, so
   * there is nothing to normalise it against — but a *filter* is not a URL and
   * two spellings of one category do not have to be two different things to a
   * query the way they would to two feed addresses.
   */
  categories?: readonly string[]
  /** Statuses to include. Defaults to published content only. */
  statuses?: readonly ContentStatus[]
  limit?: number
  offset?: number
}

/** Which field a match was found in. Used to explain a result's relevance. */
export type MatchField =
  | 'title'
  | 'tags'
  | 'category'
  | 'description'
  | 'headings'
  | 'body'

export interface SearchHit {
  type: ContentType
  slug: string
  url: string
  /** Plain text. Never rendered as HTML. */
  title: string
  /**
   * The title with matched terms wrapped in `<mark>`, HTML-escaped throughout.
   * Safe to inject; see `highlight()` in `./local`.
   */
  titleHtml: string
  description: string
  tags: string[]
  /** The section the document was filed under, as written. Null when unfiled. */
  category: string | null
  publishedAt: Date | null
  score: number
  /**
   * A window of body text around the densest cluster of matches, with `<mark>`
   * around matched terms and everything else escaped.
   */
  excerptHtml: string
  /** Fields the query matched in, most significant first. */
  matched: MatchField[]
}

export interface SearchResult {
  hits: SearchHit[]
  /** Total matches before `limit` was applied. */
  total: number
  /** Milliseconds spent ranking. */
  took: number
  /** Identifier of the provider that answered, e.g. `local`. */
  provider: string
  /**
   * Set when the query could not be answered as written and was answered with
   * something else — a typo corrected, or an operator the provider ignored.
   * The UI shows this rather than silently returning different results.
   */
  notice?: string
}

export interface SearchProvider {
  readonly name: string
  search(query: SearchQuery): Promise<SearchResult>
}

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 50

/**
 * Version of the document shape above.
 *
 * Stamped onto every row the sync engine indexes. **Bump this whenever a field
 * is added to `SearchDocument`, or whenever the meaning of an existing field
 * changes** — a row indexed under an older version is missing whatever the new
 * field carries, and nothing else in the system can tell that apart from a
 * document that genuinely has nothing to put there. `findStaleSearchRows` in
 * the sync engine is what turns a bump into a work list.
 *
 * The local provider rebuilds from the files and so never needs this. It exists
 * for the provider that has to be *told* what changed.
 */
export const SEARCH_INDEX_VERSION = 1

/* -------------------------------------------------------------------------- */
/*  Query parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A parsed query.
 *
 * `terms` are **groups**, and the two levels mean different things:
 *
 * - The groups are ANDed. Every one must be satisfied.
 * - The forms inside a group are ORed. They are alternate spellings of one
 *   word — `rendering` and `render` — and a document matching any of them has
 *   matched that word.
 *
 * A flat term list cannot express this, and flattening it either way is wrong:
 * ANDing the forms would make a search for `rendering` miss a document that
 * says `render`, and ORing them would make `rendering pipeline` return
 * everything mentioning a pipeline.
 *
 * `phrases` are also required, matched as a consecutive run. `tags`,
 * `categories` and `types` are filters rather than ranking signals, so a filter
 * matching nothing yields nothing rather than being quietly dropped.
 */
export interface ParsedQuery {
  terms: string[][]
  phrases: string[]
  tags: string[]
  categories: string[]
  types: ContentType[]
  /** True when the query carried no searchable content and no filters. */
  isEmpty: boolean
  /** True when the query carried any filter, even with no searchable terms. */
  hasFilters: boolean
  /** Operators that were recognised but cannot be honoured. */
  unsupported: string[]
}

const TYPE_OPERATORS: Record<string, ContentType> = {
  type: 'post',
  post: 'post',
  posts: 'post',
  note: 'note',
  notes: 'note',
  project: 'project',
  projects: 'project',
}

/** A plausible filter name: lowercase, hyphenated, starting with a letter. */
const OPERATOR_NAME = /^[a-z][a-z-]*$/

/**
 * Parse a query string.
 *
 * Supported: `"exact phrase"`, `tag:react`, `category:linux`, `type:post`, and
 * bare terms. An unrecognised `operator:value` is reported in `unsupported`
 * rather than silently searched for as literal text — someone who typed
 * `author:me` wants a filter, and returning articles that happen to contain the
 * word "author" would be worse than saying the filter does not exist.
 *
 * Filters are collected lowercased, and the fields they are compared against
 * are lowercased at the comparison. A filter is a value a reader types from
 * memory; the tag and category names it has to match were chosen by an author
 * who may well have capitalised them.
 */
export function parseQuery(
  input: string,
  toGroups: (text: string) => string[][],
): ParsedQuery {
  const bareTerms: string[] = []
  const phrases: string[] = []
  const tags: string[] = []
  const categories: string[] = []
  const types: ContentType[] = []
  const unsupported: string[] = []

  // Quoted segments come out first, so their contents are never mistaken for
  // operators and a phrase containing a colon survives intact.
  const withoutPhrases = input.replace(/"([^"]*)"/g, (_, phrase: string) => {
    const trimmed = phrase.trim()
    if (trimmed) phrases.push(trimmed)
    return ' '
  })

  for (const raw of withoutPhrases.split(/\s+/)) {
    if (!raw) continue
    const separator = raw.indexOf(':')

    // A value containing `/` is a URL or a path, not a filter argument — which
    // is what stops `https://example.com` from being read as a `https:` filter
    // and reported as unsupported. `12:30` is excluded by the name pattern,
    // since a name has to start with a letter.
    if (separator > 0 && !raw.slice(separator + 1).includes('/')) {
      const operator = raw.slice(0, separator).toLowerCase()
      const value = raw.slice(separator + 1)
      const known = OPERATOR_NAME.test(operator)

      const type = TYPE_OPERATORS[operator]
      if (type) {
        const normalised = value ? TYPE_OPERATORS[value.toLowerCase()] : type
        if (normalised) types.push(normalised)
        continue
      }

      if (operator === 'tag' || operator === 'tags') {
        if (value) tags.push(value.toLowerCase())
        continue
      }

      if (operator === 'category' || operator === 'categories') {
        if (value) categories.push(value.toLowerCase())
        continue
      }

      if (known) {
        unsupported.push(raw)
        continue
      }
    }

    bareTerms.push(raw)
  }

  // Merged first, because emptiness is a property of the *groups*: `the and`
  // tokenises to nothing, and answering it with a full archive listing would be
  // as wrong as answering an empty box that way.
  const groups = mergeGroups(bareTerms.flatMap((term) => toGroups(term)))
  const hasFilters = tags.length > 0 || categories.length > 0 || types.length > 0

  return {
    terms: groups,
    phrases,
    tags,
    categories,
    types,
    hasFilters,
    isEmpty: groups.length === 0 && phrases.length === 0 && !hasFilters,
    unsupported,
  }
}

/**
 * Collapse groups that share a form.
 *
 * `render` and `rendering` produce `['render']` and `['rendering', 'render']`.
 * Two groups that overlap are the same word asked twice, and leaving them apart
 * both adds a redundant AND constraint and lets one word contribute to the score
 * twice. The union is the honest single question.
 *
 * Groups that do not overlap are left alone: `data` and `database` are different
 * words, and a document about one is not a document about the other.
 */
function mergeGroups(groups: string[][]): string[][] {
  const merged: string[][] = []

  for (const group of groups) {
    const overlapping = merged.filter((existing) =>
      group.some((form) => existing.includes(form)),
    )

    if (overlapping.length === 0) {
      merged.push([...new Set(group)])
      continue
    }

    // Fold every overlapping group — and this one — into the first.
    const target = overlapping[0] as string[]
    for (const form of group) if (!target.includes(form)) target.push(form)

    for (const other of overlapping.slice(1)) {
      for (const form of other) if (!target.includes(form)) target.push(form)
      merged.splice(merged.indexOf(other), 1)
    }
  }

  return merged
}
