import { describe, expect, it } from 'vitest'

import type { ContentType } from '@/lib/content/schema'
import { groupHits } from '@/lib/search/group'

/**
 * Grouping search results by the kind of thing they are.
 *
 * Small enough to look obvious, which is why it is worth pinning: the two rules
 * that are easy to get backwards are the *group* order — the site's own order,
 * not the ranking's — and the order *within* a group, which is the ranking and
 * must survive the regrouping.
 */

const hit = (slug: string, type: ContentType) => ({ slug, type })

describe('groupHits', () => {
  it('puts the groups in the site’s order, not the order the hits arrived in', () => {
    const groups = groupHits([
      hit('a-note', 'note'),
      hit('a-project', 'project'),
      hit('an-article', 'post'),
    ])

    expect(groups.map((group) => group.type)).toEqual(['post', 'note', 'project'])
  })

  it('keeps the ranking inside a group', () => {
    const groups = groupHits([
      hit('best-article', 'post'),
      hit('a-note', 'note'),
      hit('second-article', 'post'),
    ])

    // Regrouping is not re-ranking: the provider said `best-article` first and
    // the grouping is not allowed to have an opinion about that.
    expect(groups[0]?.hits.map((entry) => entry.slug)).toEqual(['best-article', 'second-article'])
    expect(groups[1]?.hits.map((entry) => entry.slug)).toEqual(['a-note'])
  })

  it('drops a group nothing landed in', () => {
    const groups = groupHits([hit('a-note', 'note')])

    // A heading over no results is a row of the reader's attention spent on
    // saying that a kind of thing exists.
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('Notes')
  })

  it('names the groups the way the site names several of them', () => {
    const groups = groupHits([
      hit('an-article', 'post'),
      hit('a-note', 'note'),
      hit('a-project', 'project'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Articles', 'Notes', 'Projects'])
  })

  it('returns nothing for no hits', () => {
    expect(groupHits([])).toEqual([])
  })

  it('groups a row that is not a search hit at all', () => {
    // The rule is about `type` and nothing else, which is what lets a caller
    // with its own narrower row — the palette renders four fields of a hit —
    // ask the question without widening its type to the whole payload.
    const groups = groupHits([{ type: 'post' as const, anything: 'else' }])

    expect(groups[0]?.hits[0]).toEqual({ type: 'post', anything: 'else' })
  })
})
