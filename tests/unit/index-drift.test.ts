import { describe, expect, it } from 'vitest'

import { indexDriftNotice } from '@/lib/admin/index-drift'

/**
 * The two notices, and the silence between them.
 *
 * The state is computed in `@/lib/admin/documents` (it needs a row and the
 * file's checksum) and rendered by the editor, which is a client component —
 * so the sentence is the part that can be read here, and the part worth pinning
 * down, because both of these describe a document the author cannot see from
 * the page itself: the site renders the index, never the file.
 */

describe('what the editor says about a drifted document', () => {
  it('says nothing when the index agrees with the file', () => {
    expect(indexDriftNotice(null)).toBeNull()
  })

  it('says a file with no row is not being served, and what a save does', () => {
    const notice = indexDriftNotice('unindexed')

    expect(notice).toContain('not in the content index')
    // The consequence, in the direction that is true for this state: the site
    // has nothing to render, rather than something wrong.
    expect(notice).toContain('the site is not serving it')
    // And the remedy, which has to be the one the autosave refusal names when it
    // turns the same document away: save once, and the row is built from it.
    expect(notice).toContain('Saving here writes the file and indexes it.')
  })

  it('says a stale row is what the site is rendering, and what a save does', () => {
    const notice = indexDriftNotice('stale')

    expect(notice).toContain('built from an earlier version of this file')
    expect(notice).toContain('the site is still rendering this document’s title')
    expect(notice).toContain('Saving here rewrites the file and re-indexes it.')
  })

  it('claims only the fields the index actually carries', () => {
    // A post's prose is read from the file on every render — the index has never
    // held it — so a stale row is not a stale article, and a notice that said
    // the site was showing the old *document* would be describing a bug that
    // does not exist. What is behind is the frontmatter the row caches.
    const notice = indexDriftNotice('stale') ?? ''

    expect(notice).toContain('description and tags from the index')
    expect(notice).toContain('the prose comes from the file')
  })

  it('does not let one sentence stand in for both states', () => {
    const unindexed = indexDriftNotice('unindexed')
    const stale = indexDriftNotice('stale')

    expect(unindexed).not.toBe(stale)

    // The two states make opposite claims about the site — one document it does
    // not have, one it has wrongly — and a branch that collapsed would leave one
    // of them telling the author something untrue about their own site.
    expect(stale).not.toContain('not serving it')
    expect(unindexed).not.toContain('still rendering')
  })
})
