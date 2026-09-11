import { beforeAll, describe, expect, it } from 'vitest'
import { createDocument } from '@/lib/content/writer'
import { highlight, invalidateSearchIndex, runSearch } from '@/lib/search/local'
import { parseQuery } from '@/lib/search/provider'
import { hasCJK, indexTerms, queryGroups, stem, tokenize } from '@/lib/search/tokenize'

/**
 * Search.
 *
 * Two things are being tested and they fail differently. The tokenizer decides
 * whether Chinese is searchable at all — get bigrams wrong and every Chinese
 * query silently returns nothing. The provider decides whether the *right*
 * document comes first.
 *
 * Ranking assertions are written as relative orderings ("A before B") rather
 * than absolute scores. A score is an implementation detail that changes
 * whenever a constant is tuned; the ordering is the behaviour that is promised.
 */

interface SeedDoc {
  slug: string
  title: string
  body: string
  tags?: string[]
  category?: string
  type?: 'post' | 'note' | 'project'
  draft?: boolean
}

/**
 * Fixtures. Each declares its own `slug` so the expected URLs are readable and
 * do not depend on how `slugify` treats a title.
 */
const DOCS: SeedDoc[] = [
  {
    slug: 'rendering-markdown',
    title: 'Rendering Markdown on the server',
    body: 'A long walk through the unified pipeline and how rendering works when the processor runs on the server rather than in the browser.',
    tags: ['markdown', 'typescript'],
  },
  {
    slug: 'markdown-tables',
    title: 'Markdown tables and footnotes',
    body: 'How GFM tables, footnote references and definition lists are parsed, and where the remark plugins disagree.',
    tags: ['markdown'],
  },
  {
    slug: 'postgres-indexes',
    title: 'Postgres index strategies',
    body: 'Partial indexes, covering indexes, and when a sequential scan is genuinely faster than an index scan.',
    tags: ['postgres', 'performance'],
  },
  {
    slug: 'chinese-notes',
    title: '中文排版笔记',
    body: '这里讨论数据库索引与查询计划。数据库的查询计划决定了索引是否被使用，而索引的选择又反过来影响查询计划。',
    tags: ['中文', '数据库'],
  },
  {
    slug: 'react-notes',
    title: 'React 组件设计',
    body: 'React 组件的设计原则，以及何时应该拆分组件。组件越小越容易测试。',
    tags: ['react'],
    type: 'note',
  },
  {
    slug: 'draft-post',
    title: 'Rendering drafts privately',
    body: 'A draft about rendering that must not appear in public search results.',
    draft: true,
  },
  /*
   * The category fixtures. Each carries a word that appears nowhere else in the
   * corpus — `Observability`, `Networking`, `Backpressure` — so a query for one
   * of them can only have been answered from the category field, and a test that
   * passed because the word was also in a body would be a test of nothing.
   */
  {
    slug: 'ebpf-tracing',
    title: 'Tracing syscalls with eBPF',
    body: 'Attaching a probe to a syscall and reading the ring buffer back without stopping the process.',
    category: 'Observability',
    tags: ['ebpf'],
  },
  {
    slug: 'cilium-policy',
    title: 'Cilium policy basics',
    body: 'How an identity based rule differs from an address based one, and why that matters once pods move.',
    category: 'Networking',
    type: 'note',
  },
  {
    slug: 'queue-depths',
    title: 'Measuring queue depths',
    body: 'What a rising queue depth means for a worker pool, and when adding consumers stops helping.',
    category: 'Backpressure',
  },
  {
    slug: 'flow-control',
    title: 'Notes on flow control',
    body: 'Backpressure as a design question rather than a library feature — the choice belongs to the producer.',
  },
]

beforeAll(async () => {
  for (const doc of DOCS) {
    await createDocument({
      type: doc.type ?? 'post',
      slug: doc.slug,
      data: {
        title: doc.title,
        slug: doc.slug,
        description: `About ${doc.title}`,
        tags: doc.tags ?? [],
        ...(doc.category ? { category: doc.category } : {}),
        ...(doc.draft ? { status: 'draft' } : { date: '2024-06-01' }),
      },
      body: doc.body,
    })
  }
  // The index is cached against a filesystem fingerprint with a short TTL.
  // These tests write files and search immediately, so the cache is dropped by
  // hand rather than waited out.
  invalidateSearchIndex()
})

function slugsOf(hits: { slug: string }[]): string[] {
  return hits.map((hit) => hit.slug)
}

describe('tokenize', () => {
  it('cuts Chinese into overlapping bigrams', () => {
    // `数据` finds 数据库 and `据库` finds it too, which is the whole reason for
    // bigrams rather than whole-run tokens.
    expect(tokenize('数据库').map((t) => t.term)).toEqual(['数据', '据库'])
    expect(tokenize('查询计划').map((t) => t.term)).toEqual(['查询', '询计', '计划'])
  })

  it('keeps Latin and Chinese in one pass', () => {
    const terms = tokenize('React 组件设计').map((token) => token.term)
    expect(terms).toContain('react')
    expect(terms).toContain('组件')
    expect(terms).toContain('设计')
  })

  it('reports offsets into the original text', () => {
    const tokens = tokenize('See rendering now')
    const rendering = tokens.find((token) => token.term === 'rendering')
    expect(rendering).toBeDefined()
    expect('See rendering now'.slice(rendering?.start, rendering?.end)).toBe('rendering')
  })

  it('drops stop words in both languages', () => {
    expect(tokenize('the and of')).toEqual([])
    expect(tokenize('的 了 是')).toEqual([])
    // A word that merely contains a stop word is kept.
    expect(tokenize('theremin').map((t) => t.term)).toContain('theremin')
  })

  it('skips bare numbers but keeps identifiers', () => {
    expect(tokenize('2024')).toEqual([])
    expect(indexTerms('sha256')).toContain('sha256')
  })

  it('detects CJK', () => {
    expect(hasCJK('中文')).toBe(true)
    expect(hasCJK('plain latin')).toBe(false)
  })

  it('maps plurals and gerunds onto one stem', () => {
    expect(stem('libraries')).toBe('library')
    expect(stem('queries')).toBe('query')
    expect(stem('classes')).toBe('class')
    expect(stem('matches')).toBe('match')
    expect(stem('boxes')).toBe('box')
    expect(stem('posts')).toBe('post')
    expect(stem('rendering')).toBe('render')
    expect(stem('logging')).toBe('log')
    expect(stem('stopped')).toBe('stop')
  })

  it('leaves words alone that a rule would mangle', () => {
    // `-ly` words are words in their own right, not adverbs.
    for (const word of ['only', 'early', 'family', 'apply', 'assembly', 'daily']) {
      expect(stem(word), word).toBe(word)
    }
    // Singular nouns that end in `s`.
    for (const word of ['analysis', 'basis', 'status', 'process', 'access', 'series', 'css']) {
      expect(stem(word), word).toBe(word)
    }
  })

  it('files a word under both its written form and its stem', () => {
    // The property that makes the stemmer safe: over-reducing `postgres` to
    // `postgre` costs nothing, because `postgres` is indexed as itself too.
    const forms = indexTerms('postgres rendering')
    expect(forms).toContain('postgres')
    expect(forms).toContain('rendering')
    expect(forms).toContain('render')
  })

  it('groups a query word with its alternate forms', () => {
    expect(queryGroups('rendering')).toEqual([['rendering', 'render']])
    // `postgres` over-reduces to `postgre`; the group carries both spellings, so
    // whichever one the author typed, the document is found.
    expect(queryGroups('postgres')).toEqual([['postgres', 'postgre']])
    expect(queryGroups('数据库')).toEqual([['数据'], ['据库']])
  })
})

describe('parseQuery', () => {
  it('extracts terms, phrases and filters', () => {
    const parsed = parseQuery('postgres "index scan" tag:performance type:post', queryGroups)
    expect(parsed.terms).toEqual([['postgres', 'postgre']])
    expect(parsed.phrases).toEqual(['index scan'])
    expect(parsed.tags).toEqual(['performance'])
    expect(parsed.types).toEqual(['post'])
    expect(parsed.unsupported).toEqual([])
  })

  it('reports operators it cannot honour instead of searching for them', () => {
    const parsed = parseQuery('author:me postgres', queryGroups)
    expect(parsed.unsupported).toEqual(['author:me'])
    expect(parsed.terms).toEqual([['postgres', 'postgre']])
  })

  it('treats a URL or a time as a term, not an operator', () => {
    const parsed = parseQuery('https://example.com 12:30', queryGroups)
    expect(parsed.unsupported).toEqual([])
    const forms = parsed.terms.flat()
    expect(forms).toContain('example')
    expect(forms).toContain('com')
  })

  it('merges duplicate terms into one group', () => {
    // `render` and `rendering` are the same question asked twice.
    const parsed = parseQuery('render rendering', queryGroups)
    expect(parsed.terms).toHaveLength(1)
  })

  it('reports an empty query', () => {
    expect(parseQuery('   ', queryGroups).isEmpty).toBe(true)
    expect(parseQuery('the and', queryGroups).isEmpty).toBe(true)
  })

  it('does not call a filters-only query empty', () => {
    const parsed = parseQuery('tag:react', queryGroups)
    expect(parsed.isEmpty).toBe(false)
    expect(parsed.hasFilters).toBe(true)
  })

  it('extracts a category filter, and files it lowercased', () => {
    const parsed = parseQuery('category:Networking policy', queryGroups)
    // Filed lowercased because the *filter* is compared case-insensitively —
    // the category as written on the document is not touched.
    expect(parsed.categories).toEqual(['networking'])
    expect(parsed.hasFilters).toBe(true)
    expect(parsed.isEmpty).toBe(false)
  })

  it('accepts the plural spelling, as it does for tags', () => {
    expect(parseQuery('categories:linux', queryGroups).categories).toEqual(['linux'])
  })
})

describe('runSearch', () => {
  it('finds a document by a body term', async () => {
    const result = await runSearch({ q: 'sequential' })
    expect(slugsOf(result.hits)).toEqual(['postgres-indexes'])
  })

  it('ranks a title match above a body match', async () => {
    const result = await runSearch({ q: 'rendering' })
    // Both `rendering-markdown` and `draft-post` mention rendering, but only the
    // first has it in the title. The draft is hidden, so it is not a candidate.
    expect(slugsOf(result.hits)[0]).toBe('rendering-markdown')
  })

  it('matches a document that uses a different inflection', async () => {
    // The document says `rendering`; the query says `render`. Both are filed
    // under `render`, so this is the whole point of the stemmer.
    const result = await runSearch({ q: 'render' })
    expect(slugsOf(result.hits)).toContain('rendering-markdown')
  })

  it('still matches the exact word when it is also stemmed', async () => {
    // `postgres` over-reduces to `postgre`; because the written form is indexed
    // as well, neither spelling loses the document.
    for (const query of ['postgres', 'postgre']) {
      const result = await runSearch({ q: query })
      expect(slugsOf(result.hits), query).toContain('postgres-indexes')
    }
  })

  it('finds Chinese text', async () => {
    const result = await runSearch({ q: '数据库索引' })
    expect(slugsOf(result.hits)).toContain('chinese-notes')
  })

  it('finds Chinese text from a mid-word substring', async () => {
    // `询计` only exists as a bigram; no word segmentation would produce it.
    const result = await runSearch({ q: '询计' })
    expect(slugsOf(result.hits)).toContain('chinese-notes')
  })

  it('finds a mixed Latin and Chinese query', async () => {
    const result = await runSearch({ q: 'React 组件' })
    expect(slugsOf(result.hits)).toEqual(['react-notes'])
  })

  it('requires every term to be present', async () => {
    const both = await runSearch({ q: 'postgres index' })
    expect(slugsOf(both.hits)).toEqual(['postgres-indexes'])

    // `postgres` alone matches, `kubernetes` matches nothing, so the pair must
    // match nothing. Weakening this to OR would make every query return
    // everything.
    const neither = await runSearch({ q: 'postgres kubernetes' })
    expect(neither.total).toBe(0)
  })

  it('honours a quoted phrase', async () => {
    const exact = await runSearch({ q: '"index scan"' })
    expect(slugsOf(exact.hits)).toContain('postgres-indexes')

    // The same two words appear, but never as a run.
    const apart = await runSearch({ q: '"scan index"' })
    expect(apart.total).toBe(0)
  })

  it('filters by tag', async () => {
    const result = await runSearch({ q: 'tag:postgres' })
    expect(slugsOf(result.hits)).toEqual(['postgres-indexes'])
  })

  it('filters by type', async () => {
    const notes = await runSearch({ q: 'react', types: ['note'] })
    expect(slugsOf(notes.hits)).toEqual(['react-notes'])

    const posts = await runSearch({ q: 'react', types: ['post'] })
    expect(posts.total).toBe(0)

    // The `type:` operator in the query string is the same filter.
    expect(slugsOf((await runSearch({ q: 'react type:note' })).hits)).toEqual(['react-notes'])
  })

  it('finds a document by its category', async () => {
    const result = await runSearch({ q: 'observability' })
    expect(slugsOf(result.hits)).toEqual(['ebpf-tracing'])
    // The word is in none of the other fields, so this is also the assertion
    // that the category was indexed rather than looked up after the fact.
    expect(result.hits[0]?.matched).toContain('category')
  })

  it('ranks a category match above the same word in a body', async () => {
    // Both documents are about it; only one is filed under it. `queue-depths`
    // carries the word in its category and `flow-control` in its body, and the
    // label the author chose is the stronger signal.
    const result = await runSearch({ q: 'backpressure' })
    expect(slugsOf(result.hits)).toEqual(['queue-depths', 'flow-control'])
  })

  it('filters by category, whatever case either side is written in', async () => {
    // As the author wrote it, as a reader would type it, and through the
    // structured filter the API takes.
    for (const query of ['category:networking', 'category:NETWORKING', 'category:Networking']) {
      expect(slugsOf((await runSearch({ q: query })).hits), query).toEqual(['cilium-policy'])
    }

    const structured = await runSearch({ q: 'policy', categories: ['Networking'] })
    expect(slugsOf(structured.hits)).toEqual(['cilium-policy'])
  })

  it('answers a category that nothing is filed under with nothing', async () => {
    const result = await runSearch({ q: 'category:Infrastructure' })
    expect(result.total).toBe(0)
    expect(result.notice).toMatch(/No content matches/)
  })

  it('reports the category a result is filed under, and null when it has none', async () => {
    expect((await runSearch({ q: 'probe' })).hits[0]?.category).toBe('Observability')
    expect((await runSearch({ q: 'sequential' })).hits[0]?.category).toBeNull()
  })

  it('hides drafts unless they are asked for', async () => {
    const publicSearch = await runSearch({ q: 'privately' })
    expect(publicSearch.total).toBe(0)

    const adminSearch = await runSearch({
      q: 'privately',
      statuses: ['draft', 'published'],
    })
    expect(slugsOf(adminSearch.hits)).toEqual(['draft-post'])
  })

  it('explains a term that appears nowhere', async () => {
    const result = await runSearch({ q: 'kubernetes' })
    expect(result.total).toBe(0)
    expect(result.notice).toMatch(/contains/)
  })

  it('reports unsupported operators alongside results', async () => {
    const result = await runSearch({ q: 'author:me postgres' })
    expect(result.notice).toMatch(/not a filter/)
    expect(slugsOf(result.hits)).toContain('postgres-indexes')
  })

  it('asks for input rather than listing the archive', async () => {
    const result = await runSearch({ q: '' })
    expect(result.hits).toEqual([])
    expect(result.total).toBe(0)
    expect(result.notice).toMatch(/Type something/)
  })

  it('says which field matched', async () => {
    const byTitle = await runSearch({ q: 'strategies' })
    expect(byTitle.hits[0]?.matched).toContain('title')

    const byBody = await runSearch({ q: 'sequential' })
    expect(byBody.hits[0]?.matched).toContain('body')
  })

  it('paginates and reports the full match count', async () => {
    const all = await runSearch({ q: 'markdown' })
    expect(all.total).toBe(2)

    const firstPage = await runSearch({ q: 'markdown', limit: 1 })
    expect(firstPage.hits).toHaveLength(1)
    // `total` is the full match count, not the size of the page.
    expect(firstPage.total).toBe(2)

    const secondPage = await runSearch({ q: 'markdown', limit: 1, offset: 1 })
    expect(secondPage.hits).toHaveLength(1)
    expect(secondPage.hits[0]?.slug).not.toBe(firstPage.hits[0]?.slug)

    const past = await runSearch({ q: 'markdown', limit: 1, offset: 5 })
    expect(past.hits).toEqual([])
    expect(past.total).toBe(2)
  })

  it('builds an excerpt around the matches', async () => {
    const result = await runSearch({ q: 'sequential' })
    expect(result.hits[0]?.excerptHtml).toContain('<mark>sequential</mark>')
  })
})

describe('highlight', () => {
  const parsed = (q: string) => parseQuery(q, queryGroups)

  it('marks the text as written, not the stem', () => {
    // The query stemmed to `render`, and the document says `Rendering`. The
    // marker has to sit around the word the reader can actually see.
    expect(highlight('Rendering is hard', parsed('render'))).toBe(
      '<mark>Rendering</mark> is hard',
    )
  })

  it('escapes everything it does not mark', () => {
    const output = highlight('<script>alert("x")</script> render', parsed('render'))
    expect(output).not.toContain('<script>')
    expect(output).toContain('&lt;script&gt;')
    expect(output).toContain('<mark>render</mark>')
  })

  it('escapes a query term that is itself markup', () => {
    const output = highlight('a<b and a<b', parsed('a<b'))
    expect(output).not.toContain('<b and')
    expect(output.match(/&lt;/g)).toHaveLength(2)
  })

  it('merges overlapping matches rather than nesting them', () => {
    // `数据` and `据库` overlap in `数据库`, so the marks must not nest.
    const output = highlight('数据库', parsed('数据库'))
    expect(output).toBe('<mark>数据库</mark>')
    expect(output.match(/<mark>/g)).toHaveLength(1)
  })

  it('marks phrases as well as terms', () => {
    expect(highlight('a partial index scan is used', parsed('"index scan"'))).toContain(
      '<mark>index scan</mark>',
    )
  })

  it('returns escaped text unchanged when nothing matches', () => {
    expect(highlight('a & b', parsed('kubernetes'))).toBe('a &amp; b')
  })
})
