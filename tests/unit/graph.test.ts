import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { documentUrl } from '@/lib/content/paths'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import {
  contentIndex,
  contentLinks,
  contentTags,
  tags as tagsTable,
} from '@/lib/db/schema'
import { collectBacklinks, getBacklinks, type BacklinkRow } from '@/lib/graph/backlinks'
import { getKnowledgeGraph, getOrphans } from '@/lib/graph/graph'
import {
  buildAdjacency,
  clampLimit,
  compareStable,
  degreeOf,
  edgePairsOf,
  findOrphans,
  indexEdges,
  isVisible,
  linkAffinity,
  rankRelated,
  scoreRelated,
  selectGraphNodes,
  sortTagsByRarity,
  tagAffinity,
  tagLayerOf,
  tagNodeId,
  tagWeight,
  termOverlap,
  type EdgePair,
  type RelationNode,
} from '@/lib/graph/model'
import {
  getRelatedPosts,
  invalidateRelatedIndex,
} from '@/lib/graph/related'
import { hasTestDatabase } from '../setup'

/**
 * The knowledge graph, backlinks and related posts.
 *
 * The scoring and selection rules are pure functions in `@/lib/graph/model`, and
 * they are tested unconditionally — those are the parts with rules that can be
 * wrong while every page still renders something. Ranking assertions are written
 * as orderings ("rare before common") rather than as exact scores, the way the
 * search tests are: a score changes whenever a constant is tuned, the ordering is
 * what the feature promises.
 *
 * The suite at the bottom talks to Postgres and skips when there is no test
 * database, so it never runs against whatever `DATABASE_URL` happens to be.
 */

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z')

function node(overrides: Partial<RelationNode> & { id: string }): RelationNode {
  const id = overrides.id
  return {
    type: 'post',
    slug: id,
    title: `Title of ${id}`,
    url: `/posts/${id}`,
    description: '',
    status: 'published',
    category: null,
    scheduledAt: null,
    series: null,
    publishedAt: PUBLISHED_AT,
    updatedAt: PUBLISHED_AT,
    headings: [],
    tags: [],
    outgoing: [],
    incoming: [],
    ...overrides,
  }
}

/** A corpus of `documentCount` documents, of which the map says how many carry each tag. */
function context(
  tagDocumentCount: Record<string, number>,
  documentCount = 100,
): { documentCount: number; tagDocumentCount: Map<string, number> } {
  return {
    documentCount,
    tagDocumentCount: new Map(Object.entries(tagDocumentCount)),
  }
}

/* -------------------------------------------------------------------------- */
/*  Rarity weighting                                                           */
/* -------------------------------------------------------------------------- */

describe('tag rarity', () => {
  it('weights a tag by how few documents carry it', () => {
    expect(tagWeight(100, 1)).toBeGreaterThan(tagWeight(100, 20))
    expect(tagWeight(100, 20)).toBeGreaterThan(tagWeight(100, 90))
  })

  it('keeps a tag that is on nearly everything at a nonzero floor', () => {
    // Zero would make a tag used everywhere indistinguishable from a tag that
    // is not on the document at all.
    expect(tagWeight(100, 100)).toBeGreaterThan(0)
  })

  it('does not invent a huge weight for a tag with no documents', () => {
    // `df` is clamped, so a missing frequency lookup cannot outscore a tag that
    // really is unique to one document.
    expect(tagWeight(100, 0)).toBeLessThanOrEqual(tagWeight(100, 1))
  })

  it('returns nothing for an empty corpus', () => {
    expect(tagWeight(0, 0)).toBe(0)
  })
})

describe('tag affinity', () => {
  const rarity = context({ rare: 1, common: 90, notes: 50, tools: 50 }, 100)

  it('values a rare shared tag above a common one', () => {
    const subject = node({ id: 'subject', tags: ['rare', 'notes', 'tools'] })
    const rare = tagAffinity(
      subject.tags,
      ['rare', 'notes', 'tools'],
      rarity,
    )
    const common = tagAffinity(
      subject.tags,
      ['common', 'notes', 'tools'],
      rarity,
    )

    expect(rare).toBeGreaterThan(common)
    // Two orders of magnitude apart is the point of the weighting; equal sets
    // score 1 and a tag on 90% of the corpus barely moves the ratio.
    expect(rare).toBeCloseTo(1, 5)
    expect(common).toBeLessThan(0.5)
  })

  it('cannot be increased by adding unrelated tags', () => {
    const shared = tagAffinity(['rare', 'notes'], ['rare', 'notes'], rarity)
    const padded = tagAffinity(
      ['rare', 'notes'],
      ['rare', 'notes', 'tools', 'common'],
      rarity,
    )
    expect(padded).toBeLessThan(shared)
  })

  it('is symmetric and bounded', () => {
    const a = ['rare', 'notes']
    const b = ['notes', 'tools']
    expect(tagAffinity(a, b, rarity)).toBeCloseTo(tagAffinity(b, a, rarity), 10)
    expect(tagAffinity(a, b, rarity)).toBeLessThanOrEqual(1)
  })

  it('is zero when either document has no tags', () => {
    expect(tagAffinity([], ['rare'], rarity)).toBe(0)
    expect(tagAffinity(['rare'], [], rarity)).toBe(0)
  })

  it('ignores a repeated tag rather than counting it twice', () => {
    const once = tagAffinity(['rare'], ['rare'], rarity)
    const twice = tagAffinity(['rare', 'rare'], ['rare'], rarity)
    expect(twice).toBeCloseTo(once, 10)
  })
})

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

describe('related scoring', () => {
  const rarity = context({ rare: 1, common: 90 }, 100)

  it('ranks a rare shared tag above a common one', () => {
    const subject = node({ id: 'subject', tags: ['rare', 'notes', 'tools'] })
    const candidates = [
      node({ id: 'common-doc', tags: ['common', 'notes', 'tools'] }),
      node({ id: 'rare-doc', tags: ['rare', 'notes', 'tools'] }),
    ]

    const ranked = rankRelated(subject, candidates, rarity)
    expect(ranked.map((entry) => entry.node.id)).toEqual(['rare-doc', 'common-doc'])
  })

  it('treats a direct link as a relationship in both directions', () => {
    const source = node({ id: 'source', tags: ['one'], outgoing: ['target'] })
    const target = node({ id: 'target', tags: ['two'] })

    const forward = scoreRelated(source, target, rarity)
    const backward = scoreRelated(target, source, rarity)

    expect(forward.total).toBeGreaterThan(0)
    expect(forward.total).toBeCloseTo(backward.total, 10)
    expect(forward.signals.backlink).toBe(1)
    expect(forward.signals.tags).toBe(0)
  })

  it('finds a linked document related even with no shared tags', () => {
    const subject = node({ id: 'subject', tags: ['one'], outgoing: ['linked'] })
    const linked = node({ id: 'linked', tags: ['unrelated-tag'] })

    const ranked = rankRelated(subject, [linked], rarity)
    expect(ranked.map((entry) => entry.node.id)).toEqual(['linked'])
  })

  it('drops candidates with nothing in common', () => {
    const subject = node({ id: 'subject', tags: ['one'] })
    const stranger = node({ id: 'stranger', tags: ['two'] })
    expect(rankRelated(subject, [stranger], rarity)).toEqual([])
  })

  it('never scores a document above its own duplicate', () => {
    const subject = node({ id: 'subject', tags: ['rare'], outgoing: ['a'] })
    const twin = node({ id: 'twin', tags: ['rare'], outgoing: ['a'] })
    expect(scoreRelated(subject, twin, rarity).total).toBeLessThanOrEqual(1)
  })

  it('relates a shared category without requiring a shared series or tag', () => {
    const subject = node({ id: 'subject', category: 'Databases' })
    const matching = node({ id: 'matching', category: 'Databases' })
    const stranger = node({ id: 'stranger', category: 'Frontend' })
    const ranked = rankRelated(subject, [stranger, matching], rarity)
    expect(ranked.map((entry) => entry.node.id)).toEqual(['matching'])
    expect(ranked[0]?.score.signals.category).toBe(1)
  })

  it('does not grow the score with the number of tags', () => {
    const subject = node({ id: 'subject', tags: ['rare'] })
    const focused = scoreRelated(subject, node({ id: 'a', tags: ['rare'] }), rarity)
    const padded = scoreRelated(
      subject,
      node({ id: 'b', tags: ['rare', 'common', 'notes', 'tools'] }),
      rarity,
    )
    expect(padded.total).toBeLessThan(focused.total)
  })

  it('scores a shared series and shared sources', () => {
    const scored = scoreRelated(
      node({ id: 'subject', tags: ['rare'], outgoing: ['x', 'y'] }),
      node({
        id: 'same',
        tags: ['common'],
        series: 'kubernetes',
        outgoing: ['x', 'z'],
      }),
      rarity,
    )

    expect(scored.signals.series).toBe(0)
    expect(
      scoreRelated(
        node({ id: 'subject', series: 'kubernetes', outgoing: ['x', 'y'] }),
        node({ id: 'same', series: 'kubernetes', outgoing: ['x', 'z'] }),
        rarity,
      ).signals.series,
    ).toBe(1)
    expect(scored.signals.links).toBeCloseTo(1 / 3, 10)
  })
})

describe('link and term overlap', () => {
  it('measures shared outbound targets as Jaccard', () => {
    expect(linkAffinity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 10)
    expect(linkAffinity(['a'], ['a'])).toBe(1)
    expect(linkAffinity(['a'], ['b'])).toBe(0)
    expect(linkAffinity([], ['b'])).toBe(0)
  })

  it('reads headings and description, not the body', () => {
    const a = { description: 'Postgres index strategies', headings: ['Partial indexes'] }
    const b = { description: 'Postgres index strategies', headings: ['Partial indexes'] }
    const c = { description: 'React component design', headings: ['Splitting components'] }

    expect(termOverlap(a, b)).toBe(1)
    expect(termOverlap(a, c)).toBe(0)
  })

  it('matches a heading against the same words in a description', () => {
    const heading = { description: '', headings: ['indexes'] }
    const description = { description: 'index', headings: [] }
    // Stems, so the plural in one and the singular in the other are one term.
    expect(termOverlap(heading, description)).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/*  Ordering                                                                   */
/* -------------------------------------------------------------------------- */

describe('deterministic ordering', () => {
  const rarity = context({ shared: 10 }, 100)

  it('breaks a score tie by published date, newest first', () => {
    const subject = node({ id: 'subject', tags: ['shared'] })
    const older = node({
      id: 'older',
      tags: ['shared'],
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const newer = node({
      id: 'newer',
      tags: ['shared'],
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    })

    const ranked = rankRelated(subject, [older, newer], rarity)
    expect(ranked.map((entry) => entry.node.id)).toEqual(['newer', 'older'])
  })

  it('falls back to the slug, then the id, so the order is total', () => {
    expect(
      compareStable(
        { id: 'a', slug: 'beta', publishedAt: PUBLISHED_AT, updatedAt: PUBLISHED_AT },
        { id: 'b', slug: 'alpha', publishedAt: PUBLISHED_AT, updatedAt: PUBLISHED_AT },
      ),
    ).toBeGreaterThan(0)

    expect(
      compareStable(
        { id: 'id-1', slug: 'same', publishedAt: PUBLISHED_AT, updatedAt: PUBLISHED_AT },
        { id: 'id-2', slug: 'same', publishedAt: PUBLISHED_AT, updatedAt: PUBLISHED_AT },
      ),
    ).toBeLessThan(0)
  })

  it('returns the same order however the candidates arrive', () => {
    const subject = node({ id: 'subject', tags: ['shared'] })
    const candidates = [
      node({ id: 'c', tags: ['shared'] }),
      node({ id: 'a', tags: ['shared'] }),
      node({ id: 'b', tags: ['shared'] }),
    ]

    const forward = rankRelated(subject, candidates, rarity)
    const reversed = rankRelated(subject, [...candidates].reverse(), rarity)

    expect(forward.map((entry) => entry.node.id)).toEqual(['a', 'b', 'c'])
    expect(reversed.map((entry) => entry.node.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts a node its most distinctive tag first', () => {
    const rarityMap = context({ rare: 1, common: 90 }, 100)
    expect(sortTagsByRarity(['common', 'rare'], rarityMap)).toEqual(['rare', 'common'])
    // Equal rarity falls back to the slug, not to frontmatter order.
    expect(sortTagsByRarity(['zebra', 'apple'], rarityMap)).toEqual([
      'apple',
      'zebra',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*  Visibility and limits                                                      */
/* -------------------------------------------------------------------------- */

describe('visibility', () => {
  const published = new Set<ContentStatus>(['published'])

  it('hides drafts from a published view', () => {
    const draft: Pick<RelationNode, 'status' | 'scheduledAt'> = {
      status: 'draft',
      scheduledAt: null,
    }
    expect(isVisible(draft, published)).toBe(false)
    expect(isVisible(draft, new Set<ContentStatus>(['published', 'draft']))).toBe(true)
  })

  it('shows a scheduled document once its time has passed', () => {
    const due: Pick<RelationNode, 'status' | 'scheduledAt'> = {
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 60_000),
    }
    const future: Pick<RelationNode, 'status' | 'scheduledAt'> = {
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 86_400_000),
    }

    expect(isVisible(due, published)).toBe(true)
    expect(isVisible(future, published)).toBe(false)
    expect(isVisible({ status: 'scheduled', scheduledAt: null }, published)).toBe(false)
  })
})

describe('limits', () => {
  it('clamps a caller-supplied limit', () => {
    expect(clampLimit(undefined, 5, 20)).toBe(5)
    expect(clampLimit(0, 5, 20)).toBe(1)
    expect(clampLimit(-3, 5, 20)).toBe(1)
    expect(clampLimit(500, 5, 20)).toBe(20)
    expect(clampLimit(Number.NaN, 5, 20)).toBe(5)
    expect(clampLimit(7.8, 5, 20)).toBe(7)
  })
})

/* -------------------------------------------------------------------------- */
/*  Graph selection                                                            */
/* -------------------------------------------------------------------------- */

/** a → b → c, with d unconnected. */
const CHAIN = [node({ id: 'a', outgoing: ['b'] }), node({ id: 'b', outgoing: ['c'] }), node({ id: 'c' }), node({ id: 'd' })]
const CHAIN_EDGES = edgePairsOf(CHAIN)
const CHAIN_ADJACENCY = buildAdjacency(CHAIN_EDGES)

describe('adjacency', () => {
  it('is undirected, so a one-way link connects both documents', () => {
    expect(degreeOf(CHAIN_ADJACENCY, 'a')).toBe(1)
    expect(degreeOf(CHAIN_ADJACENCY, 'c')).toBe(1)
    expect(degreeOf(CHAIN_ADJACENCY, 'b')).toBe(2)
    expect(degreeOf(CHAIN_ADJACENCY, 'd')).toBe(0)
  })

  it('drops self-references and keeps one edge per pair', () => {
    const pairs = edgePairsOf([
      node({ id: 'a', outgoing: ['a', 'b'] }),
      node({ id: 'b', outgoing: ['a'] }),
    ])
    expect(pairs).toEqual([{ source: 'a', target: 'b' }])
  })

  it('is empty for an empty corpus', () => {
    expect(buildAdjacency([]).size).toBe(0)
    expect(edgePairsOf([])).toEqual([])
  })
})

describe('degree filtering', () => {
  it('keeps connected documents by default and drops the rest', () => {
    const selected = selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 10, minDegree: 1 })
    // Best-connected first, then the deterministic tie-break.
    expect(selected.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
    expect(selected.find((entry) => entry.id === 'b')?.degree).toBe(2)
  })

  it('narrows to the core at a higher minimum', () => {
    const selected = selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 10, minDegree: 2 })
    expect(selected.map((entry) => entry.id)).toEqual(['b'])
  })

  it('includes unconnected documents when asked for them', () => {
    const selected = selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 10, minDegree: 0 })
    expect(selected.map((entry) => entry.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('honours the limit', () => {
    expect(
      selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 1, minDegree: 0 }).map((n) => n.id),
    ).toEqual(['b'])
    expect(selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 100, minDegree: 1 })).toHaveLength(3)
  })

  it('selects from exactly the nodes it is handed', () => {
    // Type and status filtering is the caller's, so that the node list, the
    // edges and the reported total always describe the same set.
    const notesOnly = CHAIN.filter((entry) => entry.type === 'note')
    const edges = edgePairsOf(CHAIN)
    expect(selectGraphNodes(notesOnly, buildAdjacency(edges), { limit: 10, minDegree: 0 })).toEqual([])
  })

  it('carries no prose into the payload', () => {
    const [first] = selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 1, minDegree: 0 })
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'degree',
      'id',
      'slug',
      'tags',
      'title',
      'type',
      'url',
    ])
  })
})

describe('edge indexing', () => {
  it('drops edges that reach outside the selection', () => {
    const selected = [node({ id: 'a' }), node({ id: 'b' })]
    const edges: EdgePair[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    expect(indexEdges(selected, edges)).toEqual([{ source: 0, target: 1 }])
  })

  it('keeps every index inside the node list', () => {
    const selected = selectGraphNodes(CHAIN, CHAIN_ADJACENCY, { limit: 2, minDegree: 0 })
    const edges = indexEdges(selected, CHAIN_EDGES)
    for (const edge of edges) {
      expect(edge.source).toBeLessThan(selected.length)
      expect(edge.target).toBeLessThan(selected.length)
    }
    // The chain a→b→c loses its b→c edge when c is cut by the limit.
    expect(edges).toEqual([{ source: 1, target: 0 }])
  })
})

/* -------------------------------------------------------------------------- */
/*  The tag layer                                                              */
/* -------------------------------------------------------------------------- */

describe('tag layer', () => {
  /** Names as the tag table holds them: a display name, not the slug. */
  const NAMES: Record<string, string> = { alpha: 'Alpha', beta: 'Beta' }
  const nameOf = (slug: string) => NAMES[slug] ?? ''

  /** Three documents, all carrying `alpha`, one of them also `beta`. */
  const CORPUS = [
    node({ id: 'a', tags: ['alpha', 'beta'] }),
    node({ id: 'b', tags: ['alpha'] }),
    node({ id: 'c', tags: ['alpha'] }),
  ]

  function layer(
    documents: readonly RelationNode[],
    options: { minDegree?: number; limit?: number } = {},
  ) {
    return tagLayerOf(documents, {
      nameOf,
      minDegree: options.minDegree ?? 0,
      limit: options.limit ?? 10,
    })
  }

  it('sizes a tag by how many of the documents carry it, biggest first', () => {
    const result = layer(CORPUS)

    expect(result.nodes.map((entry) => [entry.slug, entry.degree])).toEqual([
      ['alpha', 3],
      ['beta', 1],
    ])
    expect(result.total).toBe(2)
    expect(result.nodes.every((entry) => entry.type === 'tag')).toBe(true)
  })

  it('leaves out a tag below the minimum it was given', () => {
    const result = layer(CORPUS, { minDegree: 2 })

    expect(result.nodes.map((entry) => entry.slug)).toEqual(['alpha'])
    // The total is what the cap left, not what the threshold did: a tag dropped
    // for being on one document is not a tag the caller is failing to show.
    expect(result.total).toBe(1)
  })

  it('caps the list, and says how many there were', () => {
    const result = layer(CORPUS, { limit: 1 })

    expect(result.nodes.map((entry) => entry.slug)).toEqual(['alpha'])
    // So a caller can say "1 of 2 tags" rather than showing the largest one
    // under a label that implies it is the only one.
    expect(result.total).toBe(2)
  })

  it('draws an edge from every document carrying a tag that was kept', () => {
    const result = layer(CORPUS)

    expect(result.edges).toEqual([
      { source: 'a', target: tagNodeId('alpha') },
      { source: 'a', target: tagNodeId('beta') },
      { source: 'b', target: tagNodeId('alpha') },
      { source: 'c', target: tagNodeId('alpha') },
    ])
  })

  it('drops the edges to a tag the cap removed', () => {
    // An edge to a node that is not in the payload is an index into the wrong
    // node once the client walks the array.
    const result = layer(CORPUS, { limit: 1 })

    expect(result.edges.map((edge) => edge.target)).not.toContain(tagNodeId('beta'))
    expect(result.edges).toEqual([
      { source: 'a', target: tagNodeId('alpha') },
      { source: 'b', target: tagNodeId('alpha') },
      { source: 'c', target: tagNodeId('alpha') },
    ])
  })

  it('does not draw one document to one tag twice', () => {
    // `content_tags` is unique on (content, tag), so this arrives from a caller
    // that built its own nodes. Two identical edges are invisible in the payload
    // and visible in the drawing as a doubled spring.
    const result = layer([node({ id: 'a', tags: ['alpha', 'alpha'] })])

    expect(result.edges).toHaveLength(1)
    expect(result.nodes[0]?.degree).toBe(1)
  })

  it('gives a tag node an id that cannot belong to a document', () => {
    const [first] = layer(CORPUS).nodes
    expect(first?.id).toBe('tag:alpha')
    expect(CORPUS.map((entry) => entry.id)).not.toContain(first?.id)
  })

  it('labels a tag with its name, and links to its page', () => {
    const [first] = layer(CORPUS).nodes

    expect(first?.title).toBe('Alpha')
    expect(first?.url).toBe('/tags/alpha')
    // The slug travels beside the name, because it is what the URL and the
    // client's own filters are keyed by.
    expect(first?.slug).toBe('alpha')
    expect(first?.tags).toEqual(['alpha'])
  })

  it('falls back to the slug for a tag with no name, and encodes the URL', () => {
    const [first] = layer([node({ id: 'a', tags: ['release notes'] })]).nodes

    expect(first?.title).toBe('release notes')
    expect(first?.url).toBe('/tags/release%20notes')
  })

  it('is empty for an empty selection rather than throwing', () => {
    expect(layer([])).toEqual({ nodes: [], edges: [], total: 0 })
  })
})

describe('orphans', () => {
  it('finds documents with no links in or out', () => {
    const orphans = findOrphans(CHAIN, CHAIN_ADJACENCY)
    expect(orphans.map((entry) => entry.id)).toEqual(['d'])
    expect(orphans[0]?.url).toBe('/posts/d')
  })

  it('finds every document in a corpus where nothing is linked', () => {
    const loose = [node({ id: 'one' }), node({ id: 'two' })]
    const orphans = findOrphans(loose, buildAdjacency(edgePairsOf(loose)))
    expect(orphans.map((entry) => entry.id)).toEqual(['one', 'two'])
  })

  it('is empty for an empty corpus rather than throwing', () => {
    expect(findOrphans([], new Map())).toEqual([])
    expect(selectGraphNodes([], new Map(), { limit: 10, minDegree: 0 })).toEqual([])
    expect(indexEdges([], [])).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  Backlink grouping                                                          */
/* -------------------------------------------------------------------------- */

function backlinkRow(overrides: Partial<BacklinkRow> & { sourceId: string }): BacklinkRow {
  return {
    kind: 'internal',
    href: '/posts/target',
    label: null,
    type: 'post',
    slug: `slug-${overrides.sourceId}`,
    title: `Title ${overrides.sourceId}`,
    status: 'published',
    scheduledAt: null,
    publishedAt: PUBLISHED_AT,
    updatedAt: PUBLISHED_AT,
    ...overrides,
  }
}

describe('backlink grouping', () => {
  const published = new Set<ContentStatus>(['published'])

  it('collapses several references from one document into one entry', () => {
    const links = collectBacklinks(
      [
        backlinkRow({ sourceId: 's1', href: '/posts/target' }),
        backlinkRow({ sourceId: 's1', kind: 'wiki', href: 'target' }),
        backlinkRow({ sourceId: 's2', href: '/posts/target', label: 'the target' }),
      ],
      published,
    )

    expect(links.map((entry) => entry.id)).toEqual(['s1', 's2'])
    expect(links[0]?.references).toEqual([
      { kind: 'internal', href: '/posts/target', label: null },
      { kind: 'wiki', href: 'target', label: null },
    ])
    expect(links[1]?.references[0]?.label).toBe('the target')
  })

  it('orders entries newest first, whatever order the rows arrive in', () => {
    const older = backlinkRow({
      sourceId: 'older',
      publishedAt: new Date('2025-01-01T00:00:00.000Z'),
    })
    const newer = backlinkRow({
      sourceId: 'newer',
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    })

    expect(collectBacklinks([older, newer], published).map((e) => e.id)).toEqual([
      'newer',
      'older',
    ])
    expect(collectBacklinks([newer, older], published).map((e) => e.id)).toEqual([
      'newer',
      'older',
    ])
  })

  it('leaves out a source the reader cannot see', () => {
    const links = collectBacklinks(
      [
        backlinkRow({ sourceId: 'published' }),
        backlinkRow({ sourceId: 'draft', status: 'draft' }),
        backlinkRow({
          sourceId: 'scheduled',
          status: 'scheduled',
          publishedAt: new Date('2020-01-01'),
          scheduledAt: new Date(Date.now() + 86_400_000),
        }),
      ],
      published,
    )

    expect(links.map((entry) => entry.id)).toEqual(['published'])
  })
})

/* -------------------------------------------------------------------------- */
/*  Database-backed                                                            */
/* -------------------------------------------------------------------------- */

/**
 * These run only when `TEST_DATABASE_URL` is set, because the point of the guard
 * is that a test run can never be pointed at the development database by
 * accident. Fixtures are written with a unique slug prefix and removed again, so
 * the assertions ask about the documents this file created rather than about the
 * contents of the database as a whole.
 */
describe.skipIf(!hasTestDatabase)('graph against a database', () => {
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
  const RUN = `graphtest-${Date.now().toString(36)}`
  const contentIds: string[] = []
  const tagIds: string[] = []

  async function insertDoc(input: {
    slug: string
    title?: string
    type?: ContentType
    status?: ContentStatus
    publishedAt?: Date
    tags?: string[]
    category?: string
    scheduledAt?: Date
  }): Promise<string> {
    const [row] = await db
      .insert(contentIndex)
      .values({
        type: input.type ?? 'post',
        slug: input.slug,
        path: `posts/${input.slug}.md`,
        title: input.title ?? `Title of ${input.slug}`,
        status: input.status ?? 'published',
        publishedAt: input.publishedAt ?? PUBLISHED_AT,
        checksum: `${RUN}-${input.slug}`.padEnd(64, '0').slice(0, 64),
        description: null,
        category: input.category ?? null,
        scheduledAt: input.scheduledAt ?? null,
      })
      .returning({ id: contentIndex.id })

    if (!row) throw new Error(`Could not insert fixture ${input.slug}`)
    contentIds.push(row.id)

    for (const name of input.tags ?? []) {
      const slug = `${RUN}-${name}`.slice(0, 100)
      const [tag] = await db
        .insert(tagsTable)
        .values({ slug, name })
        .onConflictDoNothing({ target: tagsTable.slug })
        .returning({ id: tagsTable.id })

      const tagId =
        tag?.id ??
        (
          await db
            .select({ id: tagsTable.id })
            .from(tagsTable)
            .where(inArray(tagsTable.slug, [slug]))
        )[0]?.id
      if (!tagId) throw new Error(`Could not insert tag ${slug}`)
      tagIds.push(tagId)
      await db
        .insert(contentTags)
        .values({ contentId: row.id, tagId })
        .onConflictDoNothing()
    }

    return row.id
  }

  async function insertLink(input: {
    sourceId: string
    targetId: string | null
    href: string
    label?: string | null
    resolved?: boolean
  }): Promise<void> {
    await db.insert(contentLinks).values({
      sourceId: input.sourceId,
      kind: 'internal',
      href: input.href,
      targetKey: input.href,
      targetId: input.targetId,
      label: input.label ?? null,
      resolved: input.resolved ?? input.targetId !== null,
    })
  }

  afterAll(async () => {
    invalidateRelatedIndex()
    if (contentIds.length > 0) {
      await db.delete(contentIndex).where(inArray(contentIndex.id, contentIds))
    }
    if (tagIds.length > 0) {
      await db.delete(tagsTable).where(inArray(tagsTable.id, tagIds))
    }
  })

  it('returns nothing for a document that does not exist', async () => {
    invalidateRelatedIndex()
    const missing = '00000000-0000-0000-0000-000000000000'
    expect(await getBacklinks(missing)).toEqual([])
    expect(await getRelatedPosts(missing)).toEqual([])
  })

  it('groups backlinks by source and ignores an unresolved row', async () => {
    const target = await insertDoc({ slug: `${RUN}-target`, title: 'Target' })
    const source = await insertDoc({ slug: `${RUN}-source`, title: 'Source' })

    await insertLink({ sourceId: source, targetId: target, href: '/posts/target' })
    // The shape a wiki link that found no target leaves behind: it is not a
    // backlink, and `resolved` alone does not say so.
    await insertLink({
      sourceId: source,
      targetId: null,
      href: 'missing-note',
      resolved: true,
    })

    invalidateRelatedIndex()
    const links = await getBacklinks(target)

    const entry = links.find((backlink) => backlink.id === source)
    expect(entry?.title).toBe('Source')
    expect(entry?.url).toBe(documentUrl('post', `${RUN}-source`))
    expect(entry?.references).toEqual([
      { kind: 'internal', href: '/posts/target', label: null },
    ])
    // The unresolved row belongs to the same source, so it must not have added
    // a reference to the entry above.
    expect(entry?.references).toHaveLength(1)
  })

  it('hides a draft that links to a published document', async () => {
    const target = await insertDoc({ slug: `${RUN}-draft-target` })
    const draft = await insertDoc({ slug: `${RUN}-draft-source`, status: 'draft' })
    await insertLink({ sourceId: draft, targetId: target, href: '/posts/draft-target' })

    invalidateRelatedIndex()
    const links = await getBacklinks(target)
    expect(links.some((backlink) => backlink.id === draft)).toBe(false)
  })

  it('relates two documents that link without sharing a tag', async () => {
    const a = await insertDoc({ slug: `${RUN}-linked-a`, tags: ['alpha'] })
    const b = await insertDoc({ slug: `${RUN}-linked-b`, tags: ['beta'] })
    await insertLink({ sourceId: a, targetId: b, href: '/posts/linked-b' })

    invalidateRelatedIndex()
    const related = await getRelatedPosts(a)

    const found = related.find((post) => post.id === b)
    expect(found).toBeDefined()
    expect(found?.signals.backlink).toBe(1)
    expect(found?.signals.tags).toBe(0)
    expect(found?.reason).toBe('linked document')
  })

  it('reads category membership from the index and explains the actual shared category', async () => {
    const category = `${RUN}-database-category`
    const subject = await insertDoc({ slug: `${RUN}-category-subject`, category })
    const candidate = await insertDoc({ slug: `${RUN}-category-candidate`, category, tags: ['unshared'] })
    invalidateRelatedIndex()
    const found = (await getRelatedPosts(subject)).find((post) => post.id === candidate)
    expect(found?.signals.category).toBe(1)
    expect(found?.reason).toBe(category)
  })

  it('keeps future scheduled titles out of backlinks, related content and the graph', async () => {
    const subject = await insertDoc({ slug: `${RUN}-schedule-target`, tags: ['schedule'] })
    const candidate = await insertDoc({
      slug: `${RUN}-schedule-hidden`, status: 'scheduled',
      publishedAt: new Date('2020-01-01'), scheduledAt: new Date(Date.now() + 86_400_000),
      tags: ['schedule'],
    })
    await insertLink({ sourceId: candidate, targetId: subject, href: `/posts/${RUN}-schedule-target` })
    invalidateRelatedIndex()
    expect((await getBacklinks(subject)).some((entry) => entry.id === candidate)).toBe(false)
    expect((await getRelatedPosts(subject)).some((entry) => entry.id === candidate)).toBe(false)
    expect((await getKnowledgeGraph()).nodes.some((entry) => entry.id === candidate)).toBe(false)
  })

  it('answers the same order twice', async () => {
    const subject = await insertDoc({
      slug: `${RUN}-stable-subject`,
      tags: ['shared'],
    })
    await insertDoc({ slug: `${RUN}-stable-a`, tags: ['shared'] })
    await insertDoc({ slug: `${RUN}-stable-b`, tags: ['shared'] })

    invalidateRelatedIndex()
    const first = await getRelatedPosts(subject, { limit: 20 })
    const second = await getRelatedPosts(subject, { limit: 20 })

    expect(first.map((post) => post.id)).toEqual(second.map((post) => post.id))
    expect(first.length).toBeGreaterThan(1)
  })

  it('respects minDegree when it builds the graph', async () => {
    const hub = await insertDoc({ slug: `${RUN}-hub` })
    const leafA = await insertDoc({ slug: `${RUN}-leaf-a` })
    const leafB = await insertDoc({ slug: `${RUN}-leaf-b` })
    const lonely = await insertDoc({ slug: `${RUN}-lonely` })

    await insertLink({ sourceId: leafA, targetId: hub, href: '/posts/hub' })
    await insertLink({ sourceId: leafB, targetId: hub, href: '/posts/hub' })

    invalidateRelatedIndex()
    const graph = await getKnowledgeGraph({ limit: 5_000, minDegree: 1 })
    const ids = new Set(graph.nodes.map((entry) => entry.id))

    expect(ids.has(hub)).toBe(true)
    expect(ids.has(leafA)).toBe(true)
    expect(ids.has(lonely)).toBe(false)
    expect(graph.nodes.find((entry) => entry.id === hub)?.degree).toBe(2)
    expect(graph.truncated).toBe(false)

    // Every edge it ships points at a node in the same payload.
    for (const edge of graph.edges) {
      expect(graph.nodes[edge.source]).toBeDefined()
      expect(graph.nodes[edge.target]).toBeDefined()
    }
  })

  it('leaves out the types the caller did not ask for', async () => {
    const post = await insertDoc({ slug: `${RUN}-typed-post` })
    const note = await insertDoc({ slug: `${RUN}-typed-note`, type: 'note' })
    await insertLink({ sourceId: note, targetId: post, href: '/posts/typed-post' })

    invalidateRelatedIndex()
    const posts = await getKnowledgeGraph({ limit: 5_000, types: ['post'], minDegree: 1 })

    // The note is not in this view, and neither is the post — the only thing the
    // post was connected to is the document the caller filtered away, so in this
    // graph it has nothing to connect to.
    expect(posts.nodes.some((entry) => entry.id === note)).toBe(false)
    expect(posts.nodes.some((entry) => entry.id === post)).toBe(false)

    const everything = await getKnowledgeGraph({ limit: 5_000, types: ['post'], minDegree: 0 })
    expect(everything.nodes.find((entry) => entry.id === post)?.degree).toBe(0)
  })

  it('draws a tag node for the tags its documents carry', async () => {
    const one = await insertDoc({ slug: `${RUN}-tag-one`, tags: ['Scope'] })
    const two = await insertDoc({ slug: `${RUN}-tag-two`, tags: ['Scope'] })
    await insertLink({ sourceId: one, targetId: two, href: '/posts/tag-two' })

    invalidateRelatedIndex()
    const graph = await getKnowledgeGraph({ limit: 5_000, minDegree: 1 })

    const index = graph.nodes.findIndex(
      (entry) => entry.type === 'tag' && entry.slug === `${RUN}-Scope`,
    )
    expect(index).toBeGreaterThanOrEqual(0)

    const tag = graph.nodes[index]
    // The name, not the slug the node is keyed by: the graph is a reading
    // surface, and the tag page it links to is headed with the name.
    expect(tag?.title).toBe('Scope')
    expect(tag?.url).toBe(`/tags/${encodeURIComponent(`${RUN}-Scope`)}`)
    expect(tag?.degree).toBe(2)

    // Two documents, two lines, and both lines reach one of them. The count on a
    // node is the figure a reader can check by counting.
    const touching = graph.edges.filter(
      (edge) => edge.source === index || edge.target === index,
    )
    expect(touching).toHaveLength(2)
    expect(
      touching
        .map((edge) => graph.nodes[edge.source === index ? edge.target : edge.source]?.id)
        .sort(),
    ).toEqual([one, two].sort())

    // The reported total is the tags these documents carry, no more and no
    // fewer: it is what a client reads to say how many tags it is not showing.
    const carried = new Set(
      graph.nodes.filter((entry) => entry.type !== 'tag').flatMap((entry) => entry.tags),
    )
    expect(graph.tagTotal).toBe(carried.size)
  })

  it('counts a tag against the documents on screen, not the whole corpus', async () => {
    const post = await insertDoc({ slug: `${RUN}-scope-post`, tags: ['Scoped'] })
    const note = await insertDoc({
      slug: `${RUN}-scope-note`,
      type: 'note',
      tags: ['Scoped'],
    })
    await insertLink({ sourceId: post, targetId: note, href: '/posts/scope-note' })

    invalidateRelatedIndex()
    const slug = `${RUN}-Scoped`

    const both = await getKnowledgeGraph({
      limit: 5_000,
      minDegree: 0,
      types: ['post', 'note'],
    })
    expect(both.nodes.find((entry) => entry.slug === slug)?.degree).toBe(2)

    /*
     * The note is not in this view. A tag node sized by its size in the corpus
     * would still say 2 here — a hub of two with one line drawn to it, which is
     * the kind of figure a reader has no way to check.
     */
    const postsOnly = await getKnowledgeGraph({
      limit: 5_000,
      minDegree: 0,
      types: ['post'],
    })
    expect(postsOnly.nodes.find((entry) => entry.slug === slug)?.degree).toBe(1)
  })

  it('counts a tag against the documents that survived the limit', async () => {
    /*
     * Three notes in a triangle, so each has two neighbours and nothing else in
     * the corpus comes near: `minDegree` and `types` together select exactly
     * these three, which is what makes the limit below the only thing deciding
     * how many of them are drawn.
     */
    const a = await insertDoc({ slug: `${RUN}-limit-a`, type: 'note', tags: ['Limited'] })
    const b = await insertDoc({ slug: `${RUN}-limit-b`, type: 'note', tags: ['Limited'] })
    const c = await insertDoc({ slug: `${RUN}-limit-c`, type: 'note', tags: ['Limited'] })
    await insertLink({ sourceId: a, targetId: b, href: '/notes/limit-b' })
    await insertLink({ sourceId: b, targetId: c, href: '/notes/limit-c' })
    await insertLink({ sourceId: c, targetId: a, href: '/notes/limit-a' })

    invalidateRelatedIndex()
    const slug = `${RUN}-Limited`

    const whole = await getKnowledgeGraph({
      limit: 5_000,
      minDegree: 2,
      types: ['note'],
    })
    expect(whole.nodes.find((entry) => entry.slug === slug)?.degree).toBe(3)

    // One note short of the corpus, and the tag says so. A tag layer built from
    // the documents the filters admitted rather than the ones the limit left
    // would still say 3 here, beside a picture holding two of them.
    const capped = await getKnowledgeGraph({ limit: 2, minDegree: 2, types: ['note'] })
    expect(capped.nodes.filter((entry) => entry.type !== 'tag')).toHaveLength(2)
    expect(capped.nodes.find((entry) => entry.slug === slug)?.degree).toBe(2)
    expect(capped.tagTotal).toBe(1)
  })

  it('leaves the tag layer out when asked for the document graph alone', async () => {
    const source = await insertDoc({ slug: `${RUN}-notags-source`, tags: ['Notags'] })
    const target = await insertDoc({ slug: `${RUN}-notags-target` })
    await insertLink({ sourceId: source, targetId: target, href: '/posts/notags-target' })

    invalidateRelatedIndex()
    const graph = await getKnowledgeGraph({ limit: 5_000, minDegree: 1, includeTags: false })

    expect(graph.nodes.some((entry) => entry.type === 'tag')).toBe(false)
    expect(graph.tagTotal).toBe(0)

    // And no edge is left pointing at one: the document edges are the ones the
    // graph was built from, resolved against the array that shipped.
    for (const edge of graph.edges) {
      expect(graph.nodes[edge.source]?.type).not.toBe('tag')
      expect(graph.nodes[edge.target]?.type).not.toBe('tag')
    }
  })

  it('reports an orphan, and an empty graph when nothing qualifies', async () => {
    const lonely = await insertDoc({ slug: `${RUN}-orphan` })
    invalidateRelatedIndex()

    const orphans = await getOrphans()
    expect(orphans.some((entry) => entry.id === lonely)).toBe(true)

    // Nothing in the corpus has a thousand neighbours, so the filters admit
    // nothing and the payload is empty rather than absent.
    const empty = await getKnowledgeGraph({ minDegree: 1_000 })
    expect(empty.nodes).toEqual([])
    expect(empty.edges).toEqual([])
  })

  it('sees a new document once the index is invalidated', async () => {
    const subject = await insertDoc({ slug: `${RUN}-refresh-subject` })
    invalidateRelatedIndex()
    expect(await getRelatedPosts(subject)).toEqual([])

    const fresh = await insertDoc({
      slug: `${RUN}-refresh-partner`,
      tags: ['shared-refresh'],
    })
    // The subject has no tag to share, so give the subject one through a link
    // instead: a link made after the index was built must show up.
    await insertLink({
      sourceId: subject,
      targetId: fresh,
      href: '/posts/refresh-partner',
    })

    invalidateRelatedIndex()
    const related = await getRelatedPosts(subject)
    expect(related.map((post) => post.id)).toContain(fresh)
  })
})
