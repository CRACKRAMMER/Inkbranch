/**
 * What the editor says when the content index and the file on disk disagree.
 *
 * The index is a projection of the Markdown, so the two fall out of step in two
 * ways, and they are told apart here because the operator's situation differs:
 * a file with no row at all is one the site is not serving, while a row built
 * from an earlier version of the file is one the site is serving wrongly. The
 * fix is the same in both — open the document and save it, which rewrites the
 * file and re-indexes it — which is why both are the editor's business and why
 * the sentence can say what saving does.
 *
 * A module with no imports, for the same reason `result.ts` and `tag-impact.ts`
 * have none: the banner is a client component, the wording is the part worth
 * testing, and the states are ones a real site cannot be put into by hand
 * without arranging the filesystem first. `./documents` computes the state, from
 * the row and the file's checksum; this module holds the shape and the words.
 */

/** How the index disagrees with the file, or `null` when it does not. */
export type IndexDrift = 'unindexed' | 'stale'

/**
 * The notice above the editor for a drifted document, or null when there is
 * nothing to say.
 *
 * Both sentences name the site as the thing that is wrong, because that is the
 * consequence the author cannot see from the editor — and the two states are
 * wrong in opposite directions, which is why one sentence cannot serve for both.
 * Neither claims more than is true: a post's prose is read from the file on
 * every render, so a stale row is a title, description and tag list that are
 * behind, not an article that is.
 */
export function indexDriftNotice(drift: IndexDrift | null): string | null {
  switch (drift) {
    case 'unindexed':
      return 'This file is not in the content index, so the site is not serving it — it was added, renamed or copied in outside the admin. Saving here writes the file and indexes it.'

    case 'stale':
      return 'The content index was built from an earlier version of this file, which was changed outside the admin, so the site is still rendering this document’s title, description and tags from the index while the prose comes from the file. Saving here rewrites the file and re-indexes it.'

    case null:
      return null
  }
}
