'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getAdminTag } from '@/lib/admin/queries'
import { actionFailure, actionOk, type ActionResult } from '@/lib/admin/result'
import { describeActionError, guardAction, parseActionInput } from '@/lib/admin/guard'
import { commitContentChange } from '@/lib/admin/git'
import { carryTagAppearance, rewriteTag, type TagRewriteReport } from '@/lib/admin/tags'
import type { GitCommitOutcome } from '@/lib/git'
import { tagSlug } from '@/lib/utils/slug'

/**
 * Renaming, merging and deleting tags.
 *
 * All three are the same operation with a different replacement, which is why
 * they share one implementation and differ only in what the destination is:
 * a new name, another tag's name, or nothing.
 *
 * The result is a report rather than a boolean. A tag lives in the frontmatter
 * of every document that carries it, so these actions are multi-file edits, and
 * a run where nine files were rewritten and one was locked is a real outcome
 * that the operator has to see — reporting it as failure would invite a rerun
 * that duplicates the work, and reporting it as success would hide a corpus that
 * is half-renamed.
 */

const slugField = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u, 'Not a tag slug')

const nameField = z.string().trim().min(1, 'A tag needs a name').max(80)

const renameSchema = z.object({
  slug: slugField,
  name: nameField,
})

const mergeSchema = z.object({
  slug: slugField,
  into: slugField,
})

const deleteSchema = z.object({
  slug: slugField,
})

export type RenameTagInput = z.output<typeof renameSchema>
export type MergeTagInput = z.output<typeof mergeSchema>
export type DeleteTagInput = z.output<typeof deleteSchema>

export interface TagActionResult extends TagRewriteReport {
  /** Public paths whose tag listing changed, so the UI can be specific. */
  affectedPaths: string[]
  /** The one commit the rewrite produced, when the site asks for commits. */
  git: GitCommitOutcome | null
}

/**
 * The commit a tag rewrite leaves behind.
 *
 * These actions rewrite a corpus — a tag lives in the frontmatter of every
 * document carrying it — so this is deliberately one commit for the run: forty
 * entries in the log for one rename is noise, and the forty files are the same
 * decision. `written` is what the rewrite actually changed, so a document that
 * already said the new name is not named.
 *
 * A run that wrote nothing commits nothing, and the caller gets null.
 */
async function commitTagRewrite(report: TagRewriteReport): Promise<GitCommitOutcome | null> {
  if (report.written.length === 0) return null

  return commitContentChange({
    action: 'tag',
    title:
      report.mode === 'delete'
        ? `${report.from.name} removed`
        : `${report.from.name} → ${report.to?.name ?? ''}`,
    paths: report.written.map((entry) => entry.path),
  })
}

function revalidateTagPages(slugs: (string | null)[]): string[] {
  const paths = ['/tags', '/admin/tags']
  for (const slug of slugs) {
    if (slug) paths.push(`/tags/${slug}`)
  }
  for (const path of paths) revalidatePath(path)
  return paths
}

export async function renameTagAction(
  input: RenameTagInput,
): Promise<ActionResult<TagActionResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(renameSchema, input)
    if (!parsed.ok) return parsed

    const { slug, name } = parsed.value
    const nextSlug = tagSlug(name)

    const tag = await getAdminTag(slug)
    if (!tag) {
      return actionFailure(`No tag is stored under “${slug}”. The list may be out of date.`)
    }

    // Renaming to a name that slugifies onto an existing tag would leave two
    // rows wanting the same slug — the unique index would reject the second
    // insert, and the documents would point at a tag whose row never appeared.
    if (nextSlug !== slug) {
      const collision = await getAdminTag(nextSlug)
      if (collision) {
        return actionFailure(
          `“${name}” is the same tag as “${collision.name}”. Renaming would merge them — use Merge instead.`,
        )
      }
    }

    const report = await rewriteTag({
      mode: 'rename',
      from: { slug, name: tag.name },
      to: { slug: nextSlug, name },
      actorId: context.user.id,
    })

    // Only meaningful once the sync has rebuilt the row under its new slug.
    if (report.sync.ok && nextSlug !== slug) {
      await carryTagAppearance(slug, nextSlug)
    }

    const git = await commitTagRewrite(report)

    return actionOk({
      ...report,
      affectedPaths: revalidateTagPages([slug, nextSlug]),
      git,
    })
  } catch (error) {
    return describeActionError(error)
  }
}

export async function mergeTagAction(
  input: MergeTagInput,
): Promise<ActionResult<TagActionResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(mergeSchema, input)
    if (!parsed.ok) return parsed

    const { slug, into } = parsed.value
    if (slug === into) {
      return actionFailure('A tag cannot be merged into itself.')
    }

    const [source, target] = await Promise.all([getAdminTag(slug), getAdminTag(into)])
    if (!source) {
      return actionFailure(`No tag is stored under “${slug}”. The list may be out of date.`)
    }
    if (!target) {
      return actionFailure(`No tag is stored under “${into}”. The list may be out of date.`)
    }

    const report = await rewriteTag({
      mode: 'merge',
      from: { slug, name: source.name },
      to: { slug, name: target.name },
      actorId: context.user.id,
    })

    const git = await commitTagRewrite(report)

    return actionOk({
      ...report,
      affectedPaths: revalidateTagPages([slug, into]),
      git,
    })
  } catch (error) {
    return describeActionError(error)
  }
}

export async function deleteTagAction(
  input: DeleteTagInput,
): Promise<ActionResult<TagActionResult>> {
  try {
    const context = await guardAction()
    const parsed = parseActionInput(deleteSchema, input)
    if (!parsed.ok) return parsed

    const { slug } = parsed.value
    const tag = await getAdminTag(slug)
    if (!tag) {
      return actionFailure(`No tag is stored under “${slug}”. The list may be out of date.`)
    }

    const report = await rewriteTag({
      mode: 'delete',
      from: { slug, name: tag.name },
      actorId: context.user.id,
    })

    const git = await commitTagRewrite(report)

    return actionOk({
      ...report,
      affectedPaths: revalidateTagPages([slug]),
      git,
    })
  } catch (error) {
    return describeActionError(error)
  }
}
