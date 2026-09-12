import { CONTENT_TYPES, type ContentType } from '@/lib/content/kinds'
import { TYPE_GROUP_LABELS } from '@/lib/content/labels'

/**
 * Search results, gathered under the kind of thing they are.
 *
 * ## Why this is a module and not four lines inside the palette
 *
 * It is the one piece of the palette's behaviour that is a rule rather than a
 * rendering: which groups exist, in what order, and what a hit that belongs to
 * none of them does. Written inline it could only be checked by driving a dialog
 * in a browser, and it would be written a second time the moment another surface
 * wants its results grouped — which is exactly what the search page is one
 * change away from.
 *
 * ## The order
 *
 * Groups come in `CONTENT_TYPES` order and hits keep the order the provider
 * returned them in, so the ranking is preserved *within* a group while the
 * groups themselves are the site's own order rather than the ranking's. That is
 * the trade the grouping makes: a note that outranked every article is still
 * under Notes. It is the right trade for a palette, where the reader is looking
 * for a *kind* of thing as much as for a particular document, and it is the
 * reason the headings exist at all.
 */

export interface HitGroup<T> {
  type: ContentType
  /** The heading, e.g. `Articles`. See `TYPE_GROUP_LABELS`. */
  label: string
  hits: T[]
}

/**
 * Gather hits by type, dropping the groups nothing landed in.
 *
 * An empty group is not rendered as an empty heading. In a launcher with a
 * fixed result budget, "Projects" over nothing is a row of the reader's
 * attention spent on saying that projects exist.
 *
 * Generic over the row rather than typed to `SearchHit`, because the rule uses
 * one field of it. A caller with its own narrower row — the palette renders four
 * fields of a hit and declares those four — should not have to widen its type to
 * ask a question about `type`, and taking the whole `SearchHit` would mean every
 * future field of a search result being a compile error in a component that
 * never looks at it.
 */
export function groupHits<T extends { type: ContentType }>(hits: readonly T[]): HitGroup<T>[] {
  const groups: HitGroup<T>[] = []

  for (const type of CONTENT_TYPES) {
    const inGroup = hits.filter((hit) => hit.type === type)
    if (inGroup.length === 0) continue
    groups.push({ type, label: TYPE_GROUP_LABELS[type], hits: inGroup })
  }

  return groups
}
