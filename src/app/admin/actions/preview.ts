'use server'

import { z } from 'zod'

import { indexSlugKeys } from '@/lib/admin/queries'
import { renderDocument } from '@/lib/content/render'
import { actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardRead, parseActionInput } from '@/lib/admin/guard'

/**
 * Render a buffer for the editor's preview pane.
 *
 * The same pipeline the site uses, not a second implementation: a preview that
 * renders differently from the published page is a preview that lies, and the
 * difference would be discovered after publishing.
 *
 * No CSRF check, because nothing is written and the cost of the check is paid on
 * every keystroke pause. Authentication is still required — this executes a
 * Markdown parser with syntax highlighting on behalf of the caller.
 */

const previewSchema = z.object({
  body: z.string().max(2_000_000),
  /** Frontmatter title, so the renderer can resolve self-references. */
  title: z.string().trim().max(300).optional(),
})

export type PreviewInput = z.output<typeof previewSchema>

export interface PreviewResult {
  html: string
  /**
   * Internal targets the buffer links to that do not exist, as `type/slug`.
   *
   * The renderer marks these `md-link--broken` when it is given the set of known
   * slugs, so the editor can warn before publishing rather than after.
   */
  broken: string[]
}

export async function previewMarkdownAction(
  input: PreviewInput,
): Promise<ActionResult<PreviewResult>> {
  try {
    await guardRead()
    const parsed = parseActionInput(previewSchema, input)
    if (!parsed.ok) return parsed

    const known = await knownSlugSet()
    const { html } = await renderDocument(parsed.value.body, { knownSlugs: known })

    return actionOk({ html, broken: collectBrokenTargets(html) })
  } catch (error) {
    return describeActionError(error)
  }
}

/**
 * The renderer annotates a broken internal link with `data-broken-target`, which
 * is the only place the missing slug appears — the anchor text is whatever the
 * author wrote.
 */
function collectBrokenTargets(html: string): string[] {
  const found = new Set<string>()
  const pattern = /data-broken-target="([^"]+)"/g
  let match = pattern.exec(html)
  while (match) {
    if (match[1]) found.add(match[1])
    match = pattern.exec(html)
  }
  return [...found]
}

/** Every `type/slug` in the index, the form the renderer compares against. */
async function knownSlugSet(): Promise<ReadonlySet<string>> {
  const rows = await indexSlugKeys()
  return new Set(rows)
}
