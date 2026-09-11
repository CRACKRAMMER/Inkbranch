/**
 * Text → indexable terms.
 *
 * Two scripts, two strategies, and the split between them is the whole point of
 * this module:
 *
 * - **Latin** text is split on non-word characters and each token is reduced to
 *   a conservative stem, so `render`, `renders` and `rendering` are one term.
 * - **CJK** text has no spaces, so it is cut into overlapping bigrams. `数据库`
 *   becomes `数据` + `据库`, and searching for either finds it. A unigram index
 *   would match far too much (`的`, `是`, `了` appear in nearly every document),
 *   and word segmentation would mean shipping a dictionary that is wrong for
 *   proper nouns — which is most of what a technical blog is about.
 *
 * A term's position is recorded so a snippet can be cut from the *original*
 * text rather than from the token stream.
 */

/** Ranges covering CJK ideographs, kana and hangul. */
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g
const LATIN_RUN = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g

/**
 * Terms carrying no information, in both languages.
 *
 * Deliberately short. An aggressive stop list does more harm than good on a
 * technical corpus — `back`, `find`, `top`, `line` and `set` are all ordinary
 * English words and all of them are also things this blog is about.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'had',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'so', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up',
  'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
  'you', 'your',
  // Chinese function words, which bigrams would otherwise turn into noise.
  '的', '了', '是', '在', '和', '就', '都', '而', '及', '与', '着', '或',
  '一个', '我们', '可以', '这个', '因为', '所以', '如果', '但是', '而且',
])

export interface Token {
  /**
   * The word as written, lower-cased: the term a reader can see. This is what
   * `highlight` marks, so it must never be a stem.
   */
  term: string
  /** The reduced lookup key. Equal to `term` when there is nothing to reduce. */
  stem: string
  /** Offset in the source string where the match starts. */
  start: number
  /** Offset one past the end of the match. */
  end: number
}

/**
 * Split text into terms with their positions.
 *
 * Latin runs and CJK runs are extracted in one left-to-right pass so that a
 * mixed string like `React 组件` yields both `react` and `组件` in the right
 * order, and so a token's offsets always point back at the original text.
 *
 * Both the written form and the stem are reported, because the index stores
 * both. See `indexTerms` for why.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []

  for (const match of text.matchAll(LATIN_RUN)) {
    const start = match.index
    const raw = match[0]
    // A bare number is not worth indexing. A number inside an identifier
    // (`sha256`, `utf8`) is, and arrives here as part of a longer token.
    if (/^\d+$/.test(raw)) continue

    const term = raw.toLowerCase()
    const reduced = stem(term)
    if (term.length < 2 || STOP_WORDS.has(term)) continue
    tokens.push({ term, stem: reduced, start, end: start + raw.length })
  }

  for (const match of text.matchAll(CJK_RUN)) {
    const start = match.index
    const run = match[0]

    if (run.length === 1) {
      if (!STOP_WORDS.has(run)) {
        tokens.push({ term: run, stem: run, start, end: start + 1 })
      }
      continue
    }

    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (STOP_WORDS.has(bigram)) continue
      // CJK is not inflected, so the written form is already the lookup key.
      tokens.push({ term: bigram, stem: bigram, start: start + i, end: start + i + 2 })
    }
  }

  // Position order matters for snippet selection and for the phrase check.
  tokens.sort((a, b) => a.start - b.start)
  return tokens
}

/**
 * Every lookup key a piece of text contributes to the index.
 *
 * **Both the written form and its stem**, and that is the load-bearing decision
 * in this module. Indexing only the stem makes the stemmer a liability: it has
 * to be *right*, because a wrongly reduced key is a document that can no longer
 * be found. `postgres` → `postgre` and `rails` → `rail` are both over-reductions
 * that no rule can rule out without a dictionary.
 *
 * Indexing both turns the stemmer into a pure recall win. `rendering` is filed
 * under `rendering` *and* `render`, so the exact word still matches exactly, and
 * a query for `render` finds it as well. A stem that is wrong costs nothing;
 * a stem that is right adds a match.
 */
export function indexTerms(text: string): string[] {
  const forms = new Set<string>()
  for (const token of tokenize(text)) {
    forms.add(token.term)
    forms.add(token.stem)
  }
  return [...forms]
}

/**
 * Split a query into groups of interchangeable forms.
 *
 * One group per query token, each group holding the forms that token could have
 * been indexed under. Groups are ANDed; the forms inside a group are ORed. So
 * `rendering pipeline` requires a document to mention `rendering` (in any of its
 * spellings) *and* `pipeline`, which is what the person typing it meant.
 */
export function queryGroups(text: string): string[][] {
  return tokenize(text).map((token) =>
    token.term === token.stem ? [token.term] : [token.term, token.stem],
  )
}

/** True when the string contains any CJK character. */
export function hasCJK(text: string): boolean {
  return CJK_CHAR.test(text)
}

/* -------------------------------------------------------------------------- */
/*  Stemming                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Singular nouns ending in `s` that a plural rule would mangle.
 *
 * Short because it only needs to cover words that are common enough to be worth
 * searching for and that no rule can recognise on shape alone.
 */
const S_ENDING_SINGULARS = new Set(['series', 'species', 'news', 'aws', 'css', 'js'])

/**
 * `-ies` spellings that are not plurals, so the `ies` -> `y` rule must skip
 * them. Without this, `series` becomes `sery`.
 */
const IES_NOT_PLURAL = new Set(['series', 'species', 'movies', 'cookies', 'zombies'])

/**
 * A conservative suffix stripper for English.
 *
 * This is not a Porter stemmer and is not trying to be. Porter's rules produce
 * stems like `relat` and `argum`, which are unreadable in a debugger and, worse,
 * collapse distinct technical terms together. The rules here only strip endings
 * that are unambiguous, and every one of them leaves enough of a stem behind
 * that the result is still a word-shaped key.
 *
 * What is deliberately *not* here: `-ly`. `only`, `early`, `family`, `apply`
 * and `assembly` are all common in technical prose and all of them would come
 * out mangled, while the adverbs it would help with are rare in a search box.
 *
 * Known and accepted: `ran` does not match `run`, and `code` does not match
 * `coded` (the `-ed` rule needs three characters of stem left, or `red` becomes
 * `r`). Irregular and short forms need a dictionary, and a dictionary is exactly
 * the dependency this file exists to avoid. Both forms are always stemmed the
 * same way, so a search for either finds every occurrence of it.
 */
export function stem(word: string): string {
  if (word.length < 4) return word
  if (S_ENDING_SINGULARS.has(word)) return word

  // `ies` -> `y`: libraries -> library, queries -> query.
  if (word.endsWith('ies') && word.length > 4 && !IES_NOT_PLURAL.has(word)) {
    return `${word.slice(0, -3)}y`
  }

  // `sses` -> `ss`: classes -> class.
  if (word.endsWith('sses')) return word.slice(0, -2)

  // `es` after a sibilant: matches -> match, boxes -> box. Only after a
  // sibilant, so `does` -> `doe` and `goes` -> `goe` cannot happen.
  if (/(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2)

  // A plain plural `s` — but never `ss`, and never the `-us` or `-sis` endings
  // that carry the singular (status, analysis, basis).
  if (
    word.endsWith('s') &&
    !word.endsWith('ss') &&
    !word.endsWith('us') &&
    !word.endsWith('sis')
  ) {
    return word.slice(0, -1)
  }

  // `ing` and `ed`, but only when a stem of at least three characters remains.
  // Without that guard, `ring` -> `r` and `red` -> `r`.
  for (const suffix of ['ing', 'ed'] as const) {
    if (!word.endsWith(suffix)) continue
    const base = word.slice(0, -suffix.length)
    if (base.length < 3) return word
    // Restore a doubled final consonant: `logging` -> `log`, not `logg`.
    if (/([bdfglmnprt])\1$/.test(base)) return base.slice(0, -1)
    return base
  }

  return word
}
