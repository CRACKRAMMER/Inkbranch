import { documentUrl } from '@/lib/content/paths'
import { type ContentDocument, readDocument, scanContentFiles } from '@/lib/content/reader'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { summarize } from '@/lib/utils/text'
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type MatchField,
  type ParsedQuery,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
  parseQuery,
} from './provider'
import { indexTerms, queryGroups, stem, tokenize } from './tokenize'

/**
 * Local full-text search.
 *
 * ## Where the index comes from
 *
 * **The Markdown files, not the database.** The article body is never stored in
 * Postgres — that is a hard rule of this project — so a database-backed search
 * would have to keep a copy of every article's text, which is the same rule
 * broken through a different door. The index is therefore built by reading the
 * files and lives in process memory.
 *
 * That is also why the index cannot be stale in a way that matters: there is no
 * second copy to fall out of sync. A file edited on disk is searchable on the
 * next rebuild, with no sync step in between.
 *
 * ## Cost
 *
 * Rebuilding reads every Markdown file. On a blog of a few hundred articles
 * that is a few megabytes and a few milliseconds, so it is done lazily and
 * cached against a cheap filesystem fingerprint — file count, total size, newest
 * mtime and a hash of the path set — with a short time-to-live so a burst of
 * requests walks the tree once rather than once per request.
 *
 * ## Ranking
 *
 * BM25F: BM25 with per-field term frequencies weighted *before* the saturation
 * term, so a term in the title counts for more than the same term buried in the
 * body, while repeated occurrences still saturate rather than dominating.
 *
 * This is deliberately the whole algorithm. Every extra ranking signal is a knob
 * whose effect has to be re-checked against real queries, and this project has
 * one author rather than a relevance team.
 */

/**
 * Field weights. Tuned by reading results, not by fitting to a corpus.
 *
 * `category` sits between `tags` and `description`: it is an editorial label
 * like a tag — the author wrote it to say what the document is about — but a
 * document has one of them rather than a handful, so it says less about a
 * specific question and more about the shelf the document is on.
 */
const FIELD_WEIGHTS = {
  title: 8,
  tags: 6,
  category: 5,
  description: 4,
  headings: 3,
  body: 1,
} as const satisfies Record<MatchField, number>

/** Fields in descending significance, for reporting which one matched. */
const FIELDS_BY_WEIGHT = Object.keys(FIELD_WEIGHTS) as MatchField[]

/** Standard BM25 saturation and length-normalisation constants. */
const K1 = 1.2
const B = 0.75

/** How long a built index is trusted before the tree is walked again. */
const FINGERPRINT_TTL_MS = 5_000

/** A title containing every query term is almost always the intended result. */
const TITLE_COVERAGE_BOOST = 1.4

/**
 * What one exact-phrase match is worth.
 *
 * A flat amount rather than a multiplier, so that a phrase-only query — `"index
 * scan"` with no bare terms — scores above zero instead of being filtered out as
 * a non-match. Comparable in size to one mid-frequency term's contribution, so a
 * phrase cannot on its own outrank a genuinely strong multi-term match.
 */
const PHRASE_WEIGHT = 1.0

/** Width in characters of a result excerpt. */
const EXCERPT_WIDTH = 220

interface IndexedDocument {
  type: ContentType
  slug: string
  url: string
  title: string
  description: string
  tags: string[]
  category: string | null
  headings: string[]
  body: string
  status: ContentStatus
  publishedAt: Date | null
  updatedAt: Date
  /** Weighted length, precomputed for BM25 length normalisation. */
  length: number
  /** Terms in this document, mapped to the fields they appear in. */
  terms: Map<string, MatchField[]>
}

interface Index {
  docs: IndexedDocument[]
  /** term → docId → weighted term frequency across all fields. */
  postings: Map<string, Map<number, number>>
  averageLength: number
  /** Files that could not be indexed, for the system page to report. */
  failures: { path: string; message: string }[]
}

/* -------------------------------------------------------------------------- */
/*  Cache                                                                      */
/* -------------------------------------------------------------------------- */

let cachedIndex: Index | null = null
let cachedFingerprint: string | null = null
let fingerprintCheckedAt = 0
let building: Promise<Index> | null = null

/**
 * A cheap signature of the content tree.
 *
 * Cheap on purpose: `stat` on every file, never a read of the contents. It has
 * to be stable when nothing changed, or the index thrashes, and different when
 * anything did.
 */
async function contentFingerprint(): Promise<string> {
  const files = await scanContentFiles()
  let totalSize = 0
  let newest = 0
  let pathHash = 0

  for (const file of files) {
    totalSize += file.size
    const mtime = file.mtime.getTime()
    if (mtime > newest) newest = mtime
    // Rolling hash over the path set, so a rename that keeps the file count and
    // total size identical still invalidates.
    for (let i = 0; i < file.relativePath.length; i += 1) {
      pathHash = (pathHash * 31 + file.relativePath.charCodeAt(i)) | 0
    }
  }

  return `${files.length}:${totalSize}:${newest}:${pathHash}`
}

/**
 * The current index, rebuilt when the content tree has changed.
 *
 * Concurrent callers share one build through the in-flight promise, so a search
 * page firing several queries at once reads the files once.
 */
async function getIndex(): Promise<Index> {
  const now = Date.now()

  if (cachedIndex && cachedFingerprint && now - fingerprintCheckedAt < FINGERPRINT_TTL_MS) {
    return cachedIndex
  }

  const fingerprint = await contentFingerprint()
  fingerprintCheckedAt = now

  if (cachedIndex && fingerprint === cachedFingerprint) return cachedIndex

  building ??= buildIndex()
    .then((index) => {
      cachedIndex = index
      cachedFingerprint = fingerprint
      return index
    })
    .finally(() => {
      building = null
    })

  return building
}

/** Drop the cached index. Used by the reindex script and by tests. */
export function invalidateSearchIndex(): void {
  cachedIndex = null
  cachedFingerprint = null
  fingerprintCheckedAt = 0
}

/* -------------------------------------------------------------------------- */
/*  Building                                                                   */
/* -------------------------------------------------------------------------- */

async function buildIndex(): Promise<Index> {
  const files = await scanContentFiles()
  const docs: IndexedDocument[] = []
  const failures: { path: string; message: string }[] = []

  for (const file of files) {
    try {
      const document = await readDocument(file.relativePath)
      if (document) docs.push(toIndexedDocument(document))
    } catch (error) {
      // One unreadable file must not take search down with it.
      failures.push({
        path: file.relativePath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const postings = new Map<string, Map<number, number>>()
  let totalLength = 0

  docs.forEach((doc, id) => {
    totalLength += doc.length

    for (const [term, fields] of doc.terms) {
      // Weight each occurrence by the strongest field it appeared in, rather
      // than summing across fields. Summing would let a term repeated in the
      // body eventually outweigh the same term in the title, which is the
      // opposite of what the weights are for.
      const weight = Math.max(...fields.map((field) => FIELD_WEIGHTS[field]))

      let posting = postings.get(term)
      if (!posting) {
        posting = new Map()
        postings.set(term, posting)
      }
      posting.set(id, weight)
    }
  })

  return {
    docs,
    postings,
    averageLength: docs.length > 0 ? totalLength / docs.length : 1,
    failures,
  }
}

function toIndexedDocument(document: ContentDocument): IndexedDocument {
  const tags = document.tags
  const category = document.category
  const headings = document.headings.map((heading) => heading.text)
  const description = document.description || summarize(document.plainText, 200)

  const fields: [MatchField, string][] = [
    ['title', document.title],
    ['description', description],
    ['tags', tags.join(' ')],
    ['headings', headings.join(' ')],
    ['body', document.plainText],
  ]

  // Added only when there is one, because an empty field is not free: the loop
  // below charges every field its weight for the length normalisation, so a
  // document with no category would be sized as though it carried a label of
  // weight 5 and no words — and every unfiled document would be charged it
  // equally, which is the sort of uniform distortion that quietly flattens
  // differences between documents rather than showing up as a wrong result.
  if (category) fields.push(['category', category])

  const terms = new Map<string, MatchField[]>()
  let length = 0

  for (const [field, text] of fields) {
    // Both the written form and its stem, so the stemmer can only ever widen a
    // match. See `indexTerms`.
    const found = indexTerms(text)
    length += FIELD_WEIGHTS[field] * Math.max(1, found.length)

    for (const term of found) {
      const seen = terms.get(term)
      if (seen) {
        if (!seen.includes(field)) seen.push(field)
      } else {
        terms.set(term, [field])
      }
    }
  }

  return {
    type: document.type,
    slug: document.slug,
    url: documentUrl(document.type, document.slug),
    title: document.title,
    description,
    tags,
    category,
    headings,
    body: document.plainText,
    status: document.status,
    publishedAt: document.publishedAt,
    updatedAt: document.updatedAt,
    length: Math.max(1, length),
    terms,
  }
}

/* -------------------------------------------------------------------------- */
/*  Searching                                                                  */
/* -------------------------------------------------------------------------- */

export const localSearchProvider: SearchProvider = {
  name: 'local',
  search: (query) => runSearch(query),
}

export async function runSearch(query: SearchQuery): Promise<SearchResult> {
  const started = Date.now()
  const index = await getIndex()

  const parsed = parseQuery(query.q, queryGroups)
  const limit = clampLimit(query.limit)
  const offset = Math.max(0, query.offset ?? 0)
  const notices: string[] = []

  if (parsed.unsupported.length > 0) notices.push(noticeFor(parsed))

  const statuses = new Set<ContentStatus>(query.statuses ?? ['published'])

  // Filters arrive from two places: the `tag:`/`type:` operators in the query
  // string, and the structured fields on the request. Both are honoured, and
  // they union rather than override — a `tag:` operator inside a request that
  // also carries a `tags` filter would otherwise be parsed and then ignored.
  const typeFilter = new Set([...(query.types ?? []), ...parsed.types])
  const tagFilter = new Set(
    [...(query.tags ?? []), ...parsed.tags].map((tag) => tag.toLowerCase()),
  )
  const categoryFilter = new Set(
    [...(query.categories ?? []), ...parsed.categories].map((category) =>
      category.toLowerCase(),
    ),
  )

  const types = typeFilter.size > 0 ? typeFilter : null
  const tags = tagFilter.size > 0 ? tagFilter : null
  const categories = categoryFilter.size > 0 ? categoryFilter : null

  const matchesFilters = (doc: IndexedDocument): boolean => {
    if (types && !types.has(doc.type)) return false
    if (tags && !doc.tags.some((tag) => tags.has(tag.toLowerCase()))) return false
    // Case-insensitive, and against the name as written rather than a slug,
    // because a category has no slug to normalise to — see `SearchQuery`.
    if (categories && !(doc.category && categories.has(doc.category.toLowerCase()))) {
      return false
    }
    return isVisible(doc, statuses)
  }

  // Nothing to search for and nothing to filter by. Answering this by listing
  // the whole archive would make an empty search box look like a browse page,
  // which is a different page's job.
  if (parsed.isEmpty) {
    notices.push('Type something to search for.')
    return finish([], 0, started, notices)
  }

  // A filters-only query — `tag:react`, or a search box driven by a tag chip.
  // There is nothing to rank, so list the matches newest first.
  if (parsed.terms.length === 0 && parsed.phrases.length === 0) {
    const filtered = index.docs.filter(matchesFilters)
    if (filtered.length === 0) {
      notices.push('No content matches those filters.')
      return finish([], 0, started, notices)
    }
    filtered.sort(compareRecency)
    return finish(
      filtered
        .slice(offset, offset + limit)
        .map((doc) => toHit(doc, 0, [], parsed)),
      filtered.length,
      started,
      notices,
    )
  }

  const candidates = collectCandidates(index, parsed)
  const scored: { doc: IndexedDocument; score: number; matched: MatchField[] }[] = []

  for (const id of candidates) {
    const doc = index.docs[id]
    if (!doc || !matchesFilters(doc)) continue

    // Groups are ANDed: a document missing one is not a weaker match, it is not
    // a match.
    if (!parsed.terms.every((group) => group.some((form) => doc.terms.has(form)))) {
      continue
    }
    if (!parsed.phrases.every((phrase) => containsPhrase(doc, phrase))) continue

    const score = bm25(index, doc, id, parsed)
    if (score <= 0) continue

    scored.push({ doc, score, matched: matchedFields(doc, parsed) })
  }

  // A word that appears in no indexed document at all — as itself or as a stem.
  // Worth saying out loud, because otherwise an empty page is indistinguishable
  // from a bug.
  for (const group of parsed.terms) {
    if (!group.some((form) => index.postings.has(form))) {
      notices.push(`Nothing in the archive contains “${group[0]}”.`)
      break
    }
  }

  scored.sort((a, b) => b.score - a.score || compareRecency(a.doc, b.doc))

  const page = scored.slice(offset, offset + limit)

  return finish(
    page.map((entry) => toHit(entry.doc, entry.score, entry.matched, parsed)),
    scored.length,
    started,
    notices,
  )
}

function finish(
  hits: SearchHit[],
  total: number,
  started: number,
  notices: string[],
): SearchResult {
  return {
    hits,
    total,
    took: Date.now() - started,
    provider: 'local',
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
  }
}

function noticeFor(parsed: ParsedQuery): string {
  const list = parsed.unsupported.join(', ')
  const verb = parsed.unsupported.length === 1 ? 'is' : 'are'
  return `${list} ${verb} not a filter this site supports.`
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * Documents that could possibly match.
 *
 * Seeded as the intersection of the postings for each *group*, since every group
 * must be satisfied. Intersecting rather than unioning keeps the scoring loop off
 * documents that are guaranteed to fail the AND check anyway — for a two-word
 * query that is usually most of the archive.
 *
 * A phrase-only query has no postings to start from, so it falls back to every
 * document; the phrase check is then a substring test rather than a token walk.
 */
function collectCandidates(index: Index, parsed: ParsedQuery): Set<number> {
  if (parsed.terms.length === 0) {
    return new Set(index.docs.map((_, id) => id))
  }

  let candidates: Set<number> | null = null

  for (const group of parsed.terms) {
    const forGroup = new Set<number>()
    for (const form of group) {
      for (const id of index.postings.get(form)?.keys() ?? []) forGroup.add(id)
    }
    // A group with no postings means no document can satisfy the query.
    if (forGroup.size === 0) return new Set()

    if (candidates === null) {
      candidates = forGroup
    } else {
      for (const id of candidates) if (!forGroup.has(id)) candidates.delete(id)
    }
  }

  return candidates ?? new Set()
}

/**
 * Whether a document is visible at all.
 *
 * Drafts are hidden unless the caller asked for them, which is how the admin
 * searches its own drafts while the public search never sees one.
 */
function isVisible(doc: IndexedDocument, statuses: Set<ContentStatus>): boolean {
  if (statuses.has(doc.status)) return true
  // A scheduled document becomes visible the moment its time arrives, without
  // waiting for a job to rewrite the row.
  if (
    statuses.has('published') &&
    doc.status === 'scheduled' &&
    doc.publishedAt !== null &&
    doc.publishedAt.getTime() <= Date.now()
  ) {
    return true
  }
  return false
}

function matchedFields(doc: IndexedDocument, parsed: ParsedQuery): MatchField[] {
  const found = new Set<MatchField>()

  for (const group of parsed.terms) {
    for (const form of group) {
      for (const field of doc.terms.get(form) ?? []) found.add(field)
    }
  }
  // A phrase is worth reporting even when its individual terms were dropped as
  // stop words during tokenisation.
  for (const phrase of parsed.phrases) {
    for (const field of FIELDS_BY_WEIGHT) {
      if (contains(FIELD_VALUE[field](doc), phrase)) found.add(field)
    }
  }

  return FIELDS_BY_WEIGHT.filter((field) => found.has(field))
}

const FIELD_VALUE: Record<MatchField, (doc: IndexedDocument) => string> = {
  title: (doc) => doc.title,
  description: (doc) => doc.description,
  tags: (doc) => doc.tags.join(' '),
  category: (doc) => doc.category ?? '',
  headings: (doc) => doc.headings.join(' '),
  body: (doc) => doc.body,
}

function containsPhrase(doc: IndexedDocument, phrase: string): boolean {
  return FIELDS_BY_WEIGHT.some((field) => contains(FIELD_VALUE[field](doc), phrase))
}

/**
 * The stems a query is looking for.
 *
 * Highlighting matches on **stem**, not on written form, which is what makes a
 * search for `render` mark the word `Rendering` in the result. It is the same
 * equivalence the index uses, so what gets marked is exactly what caused the
 * document to match — no more and no less.
 */
function queryStems(parsed: ParsedQuery): Set<string> {
  const stems = new Set<string>()
  for (const group of parsed.terms) for (const form of group) stems.add(stem(form))
  return stems
}

function contains(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase())
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

function bm25(
  index: Index,
  doc: IndexedDocument,
  docId: number,
  parsed: ParsedQuery,
): number {
  const total = index.docs.length
  const norm = K1 * (1 - B + (B * doc.length) / index.averageLength)
  let score = 0

  for (const group of parsed.terms) {
    // A group's term frequency is the strongest of its forms, not their sum.
    // Every document that contains `rendering` also contains the form `render`,
    // so summing would count one occurrence twice and inflate every stemmed
    // word relative to an unstemmed one.
    let tf = 0
    let df = 0

    for (const form of group) {
      const posting = index.postings.get(form)
      if (!posting) continue
      tf = Math.max(tf, posting.get(docId) ?? 0)
      // The *most common* form bounds the group's document frequency, because
      // every document matching a narrower form (`rendering`) also matches the
      // wider one it reduced to (`render`). Using the rarest form instead would
      // compute `rendering` a higher IDF than `render` for the same word.
      df = Math.max(df, posting.size)
    }

    if (tf === 0) continue

    // BM25's IDF with the +0.5 smoothing, floored so a term appearing in most
    // documents contributes a little rather than a negative amount.
    const idf = Math.max(0.05, Math.log(1 + (total - df + 0.5) / (df + 0.5)))
    score += idf * ((tf * (K1 + 1)) / (tf + norm))
  }

  // A phrase was already *required* as a filter by the caller. Scoring it here
  // is what keeps a phrase-only query from coming out at exactly zero and being
  // discarded as a non-match.
  score += parsed.phrases.length * PHRASE_WEIGHT

  if (score <= 0) return 0

  // Every query term in the title: almost certainly the intended result,
  // whatever the body happens to say.
  if (parsed.terms.length > 1 && titleCoversEveryTerm(doc, parsed.terms)) {
    score *= TITLE_COVERAGE_BOOST
  }

  return score
}

function titleCoversEveryTerm(doc: IndexedDocument, groups: string[][]): boolean {
  return groups.every((group) =>
    group.some((form) => doc.terms.get(form)?.includes('title') ?? false),
  )
}

/**
 * Two documents of equal relevance are ordered newest first.
 *
 * A strict ordering rather than a score adjustment: adding a recency term to
 * the score would let a fresh, weakly-matching document outrank a strong match,
 * which is not what "tie-break" is supposed to mean.
 */
function compareRecency(a: IndexedDocument, b: IndexedDocument): number {
  const at = (a.publishedAt ?? a.updatedAt).getTime()
  const bt = (b.publishedAt ?? b.updatedAt).getTime()
  if (at === bt) return a.title.localeCompare(b.title)
  return bt - at
}

/* -------------------------------------------------------------------------- */
/*  Highlights and snippets                                                    */
/* -------------------------------------------------------------------------- */

function toHit(
  doc: IndexedDocument,
  score: number,
  matched: MatchField[],
  parsed: ParsedQuery,
): SearchHit {
  return {
    type: doc.type,
    slug: doc.slug,
    url: doc.url,
    title: doc.title,
    titleHtml: highlight(doc.title, parsed),
    description: doc.description,
    tags: doc.tags,
    category: doc.category,
    publishedAt: doc.publishedAt,
    score,
    excerptHtml: buildExcerpt(doc.body, parsed),
    matched,
  }
}

/**
 * A window of body text around the densest cluster of matches.
 *
 * Chosen by density rather than by taking the first hit, so a page that mentions
 * the topic once in its opening paragraph and then discusses it for three
 * sections shows the discussion.
 */
function buildExcerpt(body: string, parsed: ParsedQuery): string {
  const wanted = queryStems(parsed)
  const offsets = tokenize(body)
    .filter((token) => wanted.has(token.stem))
    .map((token) => token.start)

  if (offsets.length === 0) return highlight(summarize(body, EXCERPT_WIDTH), parsed)

  // Two pointers: for each match, find the run of matches that fits inside one
  // window and keep the longest.
  let bestStart = offsets[0] as number
  let bestCount = 0
  let left = 0

  for (let right = 0; right < offsets.length; right += 1) {
    const rightOffset = offsets[right] as number
    while (rightOffset - (offsets[left] as number) > EXCERPT_WIDTH) left += 1

    const count = right - left + 1
    if (count > bestCount) {
      bestCount = count
      bestStart = offsets[left] as number
    }
  }

  const half = Math.floor(EXCERPT_WIDTH / 2)
  const from = Math.max(0, bestStart - half)
  const to = Math.min(body.length, from + EXCERPT_WIDTH)

  const slice = body.slice(from, to).replace(/\s+/g, ' ').trim()
  const prefix = from > 0 ? '… ' : ''
  const suffix = to < body.length ? ' …' : ''

  return `${prefix}${highlight(slice, parsed)}${suffix}`
}

/**
 * Wrap query matches in `<mark>`, returning escaped HTML.
 *
 * Works on token offsets against the original string, so the visible text is
 * never rewritten — `rendering` stays `rendering` in the output even though it
 * matched the stem `render`. Ranges are merged before marking, so overlapping
 * matches cannot produce nested or unbalanced tags.
 *
 * The result is safe to inject: everything outside the inserted `<mark>` tags
 * is escaped here. `titleHtml` and `excerptHtml` are the only fields in this
 * module that carry markup, and both come from this one function.
 */
export function highlight(text: string, parsed: ParsedQuery): string {
  const wanted = queryStems(parsed)
  const ranges = tokenize(text)
    .filter((token) => wanted.has(token.stem))
    .map((token) => ({ start: token.start, end: token.end }))

  for (const phrase of parsed.phrases) {
    ranges.push(...findRanges(text, phrase))
  }

  if (ranges.length === 0) return escapeHtml(text)

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  let out = ''
  let cursor = 0
  for (const range of merged) {
    out += escapeHtml(text.slice(cursor, range.start))
    out += `<mark>${escapeHtml(text.slice(range.start, range.end))}</mark>`
    cursor = range.end
  }
  return out + escapeHtml(text.slice(cursor))
}

function findRanges(text: string, phrase: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  if (!phrase) return ranges

  // Case-insensitive for Latin; CJK has no case, so this is correct for both.
  const haystack = text.toLowerCase()
  const needle = phrase.toLowerCase()
  let index = haystack.indexOf(needle)

  while (index !== -1) {
    ranges.push({ start: index, end: index + needle.length })
    index = haystack.indexOf(needle, index + needle.length)
  }
  return ranges
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] as string)
}
