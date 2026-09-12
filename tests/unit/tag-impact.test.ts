import { describe, expect, it } from 'vitest'

import {
  currentImpact,
  destinationFor,
  mergeConsequence,
  type ImpactState,
  type TagRunOutcome,
  type TagTally,
} from '@/lib/admin/tag-impact'

/**
 * The sentence a merge dialog shows before the button is pressed.
 *
 * The merge action rewrites the frontmatter of every document carrying a tag,
 * which makes it the most destructive thing on the tags page and the one place
 * where a wrong number is worse than no number. Two of the sentence's branches
 * exist precisely because the obvious sentence is wrong in them:
 *
 *   - A tag nothing carries rewrites no file, so naming where the destination
 *     ends up would be true and would leave the operator expecting writes.
 *   - A document carrying both tags already does not have its tag replaced; it
 *     has one removed. That is the difference between a merge and a rename.
 *
 * Neither situation can be produced through the admin UI without deliberately
 * building it first, and the fallback sentences only appear when the database
 * is unreachable — so these are pinned here rather than in the browser suite.
 */

const SOURCE: TagTally = { name: 'Kernel', contentCount: 4 }
const TARGET: TagTally = { name: 'Linux', contentCount: 3 }

function counted(impact: { documents: number; carrying: number; overlapping: number }): ImpactState {
  return { status: 'counted', into: 'linux', impact }
}

describe('merge consequence', () => {
  it('says it is counting rather than showing a number it does not have', () => {
    expect(mergeConsequence(SOURCE, TARGET, { status: 'counting' })).toBe(
      'Counting the documents this would touch…',
    )
  })

  it('falls back to the bound the page allows when the count cannot be had', () => {
    const sentence = mergeConsequence(SOURCE, TARGET, { status: 'failed', into: 'linux' })

    // "up to", because the sum counts a document carrying both tags twice.
    expect(sentence).toBe('Linux will end up on up to 7 documents.')
  })

  it('names no destination when the source tag is carried by nothing', () => {
    const sentence = mergeConsequence(
      { name: 'Kernel', contentCount: 0 },
      TARGET,
      counted({ documents: 3, carrying: 0, overlapping: 0 }),
    )

    expect(sentence).toBe(
      'No document carries “Kernel”, so this rewrites nothing — it only removes the tag.',
    )
    // The destination's count is not the answer to "what will this touch".
    expect(sentence).not.toContain('will end up on')
  })

  it('counts the union of the two tags, so a document carrying both is named once', () => {
    const sentence = mergeConsequence(
      SOURCE,
      TARGET,
      counted({ documents: 5, carrying: 4, overlapping: 2 }),
    )

    expect(sentence).toBe(
      'Linux will end up on 5 documents — 2 of them already carry “Linux”, so for those this drops “Kernel” rather than replacing it.',
    )
  })

  it('distinguishes one document from several, and one carrier from many', () => {
    expect(
      mergeConsequence(SOURCE, TARGET, counted({ documents: 1, carrying: 1, overlapping: 0 })),
    ).toBe('Linux will end up on 1 document.')

    expect(
      mergeConsequence(SOURCE, TARGET, counted({ documents: 2, carrying: 2, overlapping: 1 })),
    ).toContain('— 1 of them already carries “Linux”')

    expect(
      mergeConsequence(SOURCE, TARGET, counted({ documents: 3, carrying: 3, overlapping: 3 })),
    ).toContain('— 3 of them already carry “Linux”')
  })
})

describe('a count only describes the tag it was asked about', () => {
  const answer = counted({ documents: 5, carrying: 4, overlapping: 2 })

  it('reads an answer for the selected destination as the answer', () => {
    expect(currentImpact(answer, 'linux')).toBe(answer)
  })

  it('reads an answer for another destination as still counting', () => {
    // Otherwise the dialog would keep the old number while the new one is in
    // flight, and the operator would decide about a tag they did not pick.
    expect(currentImpact(answer, 'systems')).toEqual({ status: 'counting' })
  })

  it('reads a failure for another destination as still counting', () => {
    // The failure belongs to the request that failed, not to the selection.
    expect(currentImpact({ status: 'failed', into: 'linux' }, 'systems')).toEqual({
      status: 'counting',
    })
  })
})

describe('where a finished run leaves the operator', () => {
  const run = (overrides: Partial<TagRunOutcome> = {}): TagRunOutcome => ({
    mode: 'merge',
    failed: 0,
    synced: true,
    toSlug: 'linux',
    ...overrides,
  })

  it('goes to the tag that survived a merge', () => {
    expect(destinationFor(run())).toBe('/admin/tags/linux')
  })

  it('goes to the new slug after a rename', () => {
    expect(destinationFor(run({ mode: 'rename', toSlug: 'gnu-linux' }))).toBe(
      '/admin/tags/gnu-linux',
    )
  })

  it('goes to the list after a delete, because the tag has no page left', () => {
    expect(destinationFor(run({ mode: 'delete', toSlug: null }))).toBe('/admin/tags')
  })

  it('stays where it is when a document could not be written', () => {
    // The page is still there — the document that failed still names the tag —
    // and the report says which document it was. Navigating would discard it.
    expect(destinationFor(run({ failed: 1 }))).toBeNull()
  })

  it('stays where it is when the index was not reconciled', () => {
    // The files are right and the index still describes the old tags; the
    // report's warning and its link to System are the point.
    expect(destinationFor(run({ synced: false }))).toBeNull()
  })

  it('falls back to the list rather than a URL with no slug in it', () => {
    // Unreachable through the actions, which refuse a rename or a merge without
    // a destination. The list is what a navigation that has no slug to offer
    // should do, and `/admin/tags/null` is not.
    expect(destinationFor(run({ toSlug: null }))).toBe('/admin/tags')
  })
})
