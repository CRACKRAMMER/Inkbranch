/**
 * The words git integration speaks.
 *
 * Kept apart from the module that runs `git`, and pure of everything else, for
 * one reason: the template rules, the sanitising and the phrases an operator
 * reads are the parts most likely to be got subtly wrong, and they are exactly
 * the parts that can be tested without a repository, a process or a database.
 */

/**
 * What the settings default ships, and what an empty template falls back to.
 *
 * The settings schema re-uses this constant rather than repeating the string, so
 * an operator who has never touched the field and one who has are looking at the
 * same sentence.
 */
export const DEFAULT_COMMIT_TEMPLATE = 'content: {action} "{title}"'

/**
 * Every action word a commit message can be built from.
 *
 * A closed union rather than a string, because `{action}` lands in `git log`,
 * where a free-form value eventually becomes a pasted paragraph. The set is the
 * vocabulary of what this admin does to a file.
 */
export type GitAction =
  | 'create'
  | 'update'
  | 'publish'
  | 'unpublish'
  | 'delete'
  | 'restore'
  | 'tag'

export type GitCommitStatus = 'committed' | 'skipped' | 'failed'

/** Why nothing was committed. Machine-readable; the phrases live below. */
export type GitSkipReason =
  /** The caller named no paths, so there was nothing to commit. */
  | 'no-paths'
  /** The content directory is not inside a git work tree. */
  | 'not-a-repository'
  /** `git` is not installed, or not on the PATH of the server process. */
  | 'git-unavailable'
  /** Git has no `user.name` / `user.email` to sign a commit with. */
  | 'no-identity'
  /** The named paths are already identical to the last commit. */
  | 'no-changes'
  /** The settings ask for a commit and the deployment does not permit one. */
  | 'deployment-disabled'
  /** Git ran and refused. What it said is in the server log. */
  | 'failed'

export interface GitCommitOutcome {
  status: GitCommitStatus
  /** Set unless the commit happened. */
  reason: GitSkipReason | null
  /** The message that was rendered, whether or not the commit happened. */
  message: string
  /** Short sha of the new commit; null unless `status` is `committed`. */
  sha: string | null
  /**
   * Git's own words, for the server log. Never sent to a browser: it is
   * unclassified output from a process, and this deployment's rule is that the
   * client is told a name and a sentence, not a transcript.
   */
  detail: string | null
}

/** One line of a commit subject, not an essay. */
const MAX_TITLE_LENGTH = 100

/**
 * C0 controls, DEL, and the line breaks among them.
 *
 * Assembled from character codes rather than written as a regex literal with
 * escapes, so that this source file holds no control characters of its own: a
 * literal NUL inside a pattern works, but it makes the file binary to every tool
 * that reads it — including the ones that search it.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]+`,
  'g',
)

/**
 * Strip everything a commit subject cannot hold, and collapse the whitespace.
 *
 * The newline is the interesting case: a title carrying one would turn the
 * message into a subject plus a body, which is not what the template promised.
 * Only ASCII spacing is collapsed, so a title that legitimately contains a
 * full-width space keeps it.
 */
export function flatten(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/ {2,}/g, ' ').trim()
}

/** `flatten`, capped to a length a subject line can afford. */
export function singleLine(value: string, max = MAX_TITLE_LENGTH): string {
  const flattened = flatten(value)
  // Counted in code points, not UTF-16 units: slicing a surrogate pair in half
  // would put an unpaired half character into the commit message.
  const points = [...flattened]
  if (points.length <= max) return flattened
  return `${points.slice(0, max - 3).join('').trimEnd()}...`
}

/**
 * Render the settings template for one change.
 *
 * `{action}` and `{title}` are the documented placeholders. Anything else in
 * braces is left exactly as typed: a message the operator wrote is theirs, and
 * deleting part of it because this module did not recognise it would be worse
 * than showing a placeholder that does nothing.
 */
export function renderCommitMessage(
  template: string,
  change: { action: GitAction; title: string },
): string {
  const title = singleLine(change.title)
  return (
    fill(template, change.action, title) ||
    fill(DEFAULT_COMMIT_TEMPLATE, change.action, title) ||
    `content: ${change.action}`
  )
}

function fill(template: string, action: GitAction, title: string): string {
  // Not `singleLine`: the template is the operator's, capped by the settings
  // schema at 200 characters, and truncating it here would silently drop the end
  // of a message they wrote. Only its line structure is ours to police.
  const source = flatten(template)
  if (!source) return ''
  return source.replaceAll('{action}', action).replaceAll('{title}', title).trim()
}

export interface GitCommitNote {
  /** A phrase for the editor's status line. */
  text: string
  /** True when the operator should look at it. */
  attention: boolean
}

/**
 * What to tell the author about a commit attempt.
 *
 * `attention` is not "something went wrong" but "something is not doing what you
 * asked": a content directory that is not a repository and a deployment switch
 * that is off are both silent no-ops otherwise, and a setting that quietly does
 * nothing is the failure mode this feature exists to avoid.
 */
export function describeGitOutcome(outcome: GitCommitOutcome): GitCommitNote {
  if (outcome.status === 'committed') {
    return { text: outcome.sha ? `committed ${outcome.sha}` : 'committed', attention: false }
  }

  switch (outcome.reason) {
    case 'no-changes':
      return { text: 'no file changes to commit', attention: false }
    case 'no-paths':
      return { text: 'nothing to commit', attention: false }
    case 'not-a-repository':
      return { text: 'the content directory is not a git repository', attention: true }
    case 'no-identity':
      return { text: 'git has no user.name and user.email to commit with', attention: true }
    case 'git-unavailable':
      return { text: 'git is not installed on the server', attention: true }
    case 'deployment-disabled':
      return {
        text: 'auto-commit is off for this deployment (GIT_INTEGRATION_ENABLED=0)',
        attention: true,
      }
    default:
      return { text: 'the commit failed — see the server log', attention: true }
  }
}
