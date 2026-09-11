import 'server-only'

import {
  commitContentPaths,
  gitCommitDecision,
  type GitAction,
  type GitCommitOutcome,
} from '@/lib/git'
import { getSettings } from '@/lib/settings'
import { env } from '@/env'

/**
 * The admin side of git auto-commit: one call per write, after the write.
 *
 * Two questions, in this order. Did anyone ask for a commit — the `gitEnabled`
 * and `gitAutoCommit` settings. And is this deployment allowed to make one —
 * `GIT_INTEGRATION_ENABLED`, which the operator sets where the process starts
 * and which no admin screen can flip. Only when both answers are yes does a git
 * process exist at all.
 *
 * Three rules this module exists to hold, because breaking any of them is how an
 * optional convenience becomes a way to lose work:
 *
 *   1. **It never fails the caller.** Every path returns an outcome or null, and
 *      the file it describes was written before this ran. A save that already
 *      succeeded must not be reported as failed because a commit did not.
 *   2. **The browser is told a reason, not a transcript.** Git's stderr goes to
 *      the server log; the outcome carries a classification the UI turns into a
 *      sentence.
 *   3. **Off by default, all the way down.** The settings default to false and
 *      the environment flag defaults to `0`, so a deployment that has changed
 *      nothing runs no git process at all.
 */

export interface CommitContentChangeInput {
  action: GitAction
  /** Human title for `{title}`; the caller falls back to the slug or path. */
  title: string
  /** Content-relative paths this write changed. */
  paths: string[]
}

/**
 * Commit one admin change, if this site and this deployment both want it.
 *
 * Returns null when the site has not asked for commits — the ordinary case, and
 * one the UI says nothing about. When the site *has* asked and the deployment
 * refuses, the returned outcome is a `deployment-disabled` note: a switch that
 * does nothing without saying so is the failure this whole feature has to avoid.
 */
export async function commitContentChange(
  input: CommitContentChangeInput,
): Promise<GitCommitOutcome | null> {
  try {
    const settings = await getSettings()

    const decision = gitCommitDecision({
      environmentEnabled: env.GIT_INTEGRATION_ENABLED,
      siteEnabled: settings.gitEnabled,
      autoCommit: settings.gitAutoCommit,
    })

    if (!decision.commit) {
      if (decision.because === 'not-asked') return null

      // No git process, and no message to render: there is nothing to commit
      // under, and the phrase the UI shows comes from the reason.
      return {
        status: 'skipped',
        reason: 'deployment-disabled',
        message: '',
        sha: null,
        detail: null,
      }
    }

    const outcome = await commitContentPaths({
      action: input.action,
      title: input.title,
      paths: input.paths,
      template: settings.gitCommitTemplate,
    })

    if (outcome.status === 'failed') {
      console.warn(
        `[git] ${input.action} "${input.title}" was not committed: ${outcome.detail ?? 'unknown error'}`,
      )
    }

    return outcome
  } catch (error) {
    // `getSettings` reads the database, and the settings row being unreadable is
    // a problem for the settings page to report — not a reason to tell an
    // author their save failed when it did not.
    console.warn(
      '[git] content commit skipped:',
      error instanceof Error ? (error.stack ?? error.message) : error,
    )
    return null
  }
}

/**
 * The title to commit under, from frontmatter that may not carry one.
 *
 * A document's frontmatter is validated before it is written, so this is a
 * fallback for the paths that have no frontmatter to read — a delete, whose row
 * may already be gone — rather than a case that normally happens.
 */
export function commitTitle(data: Record<string, unknown>, fallback: string): string {
  const title = data.title
  return typeof title === 'string' && title.trim() !== '' ? title : fallback
}
