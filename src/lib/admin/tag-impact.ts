/**
 * What a tag change touches, what to say about it, and where it leaves you.
 *
 * Merging, renaming and deleting a tag are all multi-file edits — a tag lives
 * in the frontmatter of every document carrying it — so the number of files is
 * part of the question being asked, not a detail of the answer. `tagChangeImpact`
 * in `./tags` produces that number; this module holds its shape, the words the
 * dialog puts around it, and the one decision that has to be made once the run
 * is over.
 *
 * It has no imports, for the same reason `result.ts` has none: the dialog is a
 * client component, and the rule "one implementation, one answer" applies to the
 * sentence as much as to the query. The branches below are the interesting part
 * of the feature — a merge of a tag nothing carries, a document that already
 * carries both, a run that half-finished — and none of them can be reached by
 * hand on a real site without deliberately building the situation first.
 */

export interface TagChangeImpact {
  /** Documents carrying the source or the destination: what the change touches. */
  documents: number
  /**
   * Documents carrying the source tag itself. Zero is a distinct case and not a
   * small one: a merge of a tag nothing carries rewrites no file at all, and a
   * screen that reported only the destination's count would say otherwise.
   */
  carrying: number
  /**
   * How many of those carry both already. For them a merge removes a tag rather
   * than changing one, which is the difference between a merge and a rename.
   */
  overlapping: number
}

/** A tag as the operations page lists it: the name, and the count beside it. */
export interface TagTally {
  name: string
  /** Documents carrying the tag, at any status. */
  contentCount: number
}

/**
 * What the dialog knows about the consequence of the merge it is offering.
 *
 * Three states rather than a nullable number with a loading flag: "no answer
 * yet" and "the answer could not be had" are different sentences.
 *
 * Both answers carry the destination they describe, which is what keeps a count
 * from outliving the selection it was about. The alternative — clearing the
 * state wherever the selection changes — is the same rule written at every such
 * place, and one of them will eventually be forgotten; here a count for a tag
 * that is no longer selected is not an answer.
 */
export type ImpactState =
  | { status: 'counting' }
  | { status: 'counted'; into: string; impact: TagChangeImpact }
  | { status: 'failed'; into: string }

/** An answer about some other tag is not an answer about this one. */
export function currentImpact(state: ImpactState, into: string): ImpactState {
  return state.status !== 'counting' && state.into === into ? state : { status: 'counting' }
}

/**
 * The consequence of merging `source` into `target`, in the words the operator
 * is deciding about.
 *
 * Until the count arrives — and if it cannot be had — the sentence falls back to
 * the upper bound the two figures on the page allow: a sum counts a document
 * carrying both tags twice, which is why it is stated as a bound, and why the
 * exact number is worth asking the database for.
 */
export function mergeConsequence(
  source: TagTally,
  target: TagTally,
  impact: ImpactState,
): string {
  if (impact.status === 'counting') return 'Counting the documents this would touch…'

  if (impact.status === 'failed') {
    return `${target.name} will end up on up to ${
      target.contentCount + source.contentCount
    } documents.`
  }

  const { documents, carrying, overlapping } = impact.impact

  // A merge of a tag nothing carries rewrites no file. Saying where the
  // destination ends up would be true and would leave the operator expecting
  // files to change.
  if (carrying === 0) {
    return `No document carries “${source.name}”, so this rewrites nothing — it only removes the tag.`
  }

  const clause = `${target.name} will end up on ${documents} document${
    documents === 1 ? '' : 's'
  }`

  if (overlapping === 0) return `${clause}.`

  return `${clause} — ${overlapping} of them already carr${
    overlapping === 1 ? 'ies' : 'y'
  } “${target.name}”, so for those this drops “${source.name}” rather than replacing it.`
}

/** A finished run, as much of it as decides where the operator goes next. */
export interface TagRunOutcome {
  mode: 'rename' | 'merge' | 'delete'
  /** Documents the run could not rewrite, so the corpus is half-changed. */
  failed: number
  /** Whether the index was reconciled after the writes. */
  synced: boolean
  /** The destination tag's slug, for a rename or a merge. */
  toSlug: string | null
}

/**
 * Where the operator should be standing once a run has finished, or null to
 * stay where they are.
 *
 * The tag page is the only place these operations are offered, and every one of
 * them can remove the tag that page is about — so re-rendering it afterwards is
 * a request for a 404, and a plain refresh replaces the report with "Not found".
 * Both things have to hold at once: the operator ends up somewhere that exists,
 * and the report is on screen whenever there is one to read.
 *
 * A run that did not finish keeps them where they are, and the tags module is
 * what makes that safe: a document that could not be written still names the tag
 * in its frontmatter, so the row survives the prune and the page still resolves.
 * That is the case the report exists for — which files are now inconsistent, and
 * the retry that leaves the finished ones alone.
 *
 * A run that finished leaves them on the tag that survived it: the destination
 * of a rename or a merge, and the list when a tag was deleted.
 *
 * A failed sync is the one case where staying can still land on the page this
 * rule avoids: the index may have been reconciled for the documents that *were*
 * written, and the tag row dropped with them. It stays anyway — the warning is
 * worth more than the avoidance, and the caller repeats it in the toast, which
 * survives the navigation this rule refuses to make.
 */
export function destinationFor(run: TagRunOutcome): string | null {
  if (run.failed > 0 || !run.synced) return null
  if (run.mode === 'delete') return '/admin/tags'

  return run.toSlug ? `/admin/tags/${run.toSlug}` : '/admin/tags'
}
