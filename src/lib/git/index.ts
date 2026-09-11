import 'server-only'

import { execFile } from 'node:child_process'

import { CONTENT_ROOT } from '@/lib/content/paths'
import { toPosix } from '@/lib/security/paths'
import {
  DEFAULT_COMMIT_TEMPLATE,
  renderCommitMessage,
  type GitAction,
  type GitCommitOutcome,
  type GitSkipReason,
} from './message'

export type {
  GitAction,
  GitCommitNote,
  GitCommitOutcome,
  GitCommitStatus,
  GitSkipReason,
} from './message'
export {
  DEFAULT_COMMIT_TEMPLATE,
  describeGitOutcome,
  renderCommitMessage,
} from './message'

/**
 * Committing the content directory.
 *
 * The feature is a convenience layered on top of files that are already saved,
 * and that shapes every decision here: **nothing in this module can fail a
 * save.** No repository, no identity, no `git` binary — each is a described
 * outcome that the caller logs and shows, never an error that travels back to a
 * write that already succeeded.
 *
 * Four properties are enforced rather than promised in a comment:
 *
 *   1. **No subcommand outside the allow-list can run.** `GIT_SUBCOMMANDS` is
 *      checked before every spawn, so `push` is not a code path this module
 *      has — not even one reached by a typo. Nothing here talks to a remote.
 *   2. **Only the named paths are staged or committed.** Every git command
 *      carries an explicit pathspec, so a change the operator is holding staged
 *      in the repository's index, or a stray file beside the documents, cannot
 *      ride along in a commit called `content: update "…"`.
 *   3. **No shell.** `execFile` takes an argument array, so a title containing
 *      `$(rm -rf …)` is a title.
 *   4. **One commit at a time, in this process.** Saves that overlap are
 *      chained instead of racing for `.git/index.lock`.
 */

/**
 * The only git subcommands this module can run.
 *
 * The list is the guarantee: adding to it is a deliberate act, and nothing that
 * rewrites history, discards work or reaches a remote is on it.
 */
export const GIT_SUBCOMMANDS = ['add', 'commit', 'rev-parse', 'status', 'var'] as const

export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number]

/** Bounded so a hung git cannot hold a save open past the browser's patience. */
export const GIT_TIMEOUT_MS = 5000

const MAX_OUTPUT_BYTES = 1024 * 1024

/** A bulk run or a tag rewrite names every file it touched; this is the ceiling. */
const MAX_PATHS = 1000

/* -------------------------------------------------------------------------- */
/*  Policy                                                                     */
/* -------------------------------------------------------------------------- */

export type GitDecision =
  | { commit: true }
  | { commit: false; because: 'not-asked' | 'deployment-disabled' }

/**
 * Whether a save should commit, from three separate yeses.
 *
 * `siteEnabled` and `autoCommit` are the admin settings: the site's switch and
 * its willingness to commit without being asked. `environmentEnabled` is
 * `GIT_INTEGRATION_ENABLED`, which only the operator who starts the process can
 * set — no admin screen can turn a deployment into one that writes to a
 * repository.
 *
 * The order matters for what the author is told. Settings off means the site
 * never asked for this, and there is nothing to say on every save. Settings on
 * and the deployment off is a configuration that will never do anything, and
 * that *is* worth saying, once per save, until it is fixed.
 */
export function gitCommitDecision(keys: {
  environmentEnabled: boolean
  siteEnabled: boolean
  autoCommit: boolean
}): GitDecision {
  if (!keys.siteEnabled || !keys.autoCommit) return { commit: false, because: 'not-asked' }
  if (!keys.environmentEnabled) return { commit: false, because: 'deployment-disabled' }
  return { commit: true }
}

/* -------------------------------------------------------------------------- */
/*  Running git                                                                */
/* -------------------------------------------------------------------------- */

interface GitRun {
  ok: boolean
  stdout: string
  stderr: string
  /** Non-null when git never produced an exit code. */
  spawn: 'git-unavailable' | 'timeout' | null
  /** A short description of what went wrong, for the server log. */
  problem: string
}

/**
 * Run one git subcommand in `directory`.
 *
 * Exported for the tests that hold the allow-list to its word; the only
 * production caller is `commitContentPaths` below.
 */
export async function runGit(
  subcommand: GitSubcommand,
  args: string[],
  directory: string = CONTENT_ROOT,
): Promise<GitRun> {
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(
      `Refusing to run \`git ${subcommand}\`: not in GIT_SUBCOMMANDS (${GIT_SUBCOMMANDS.join(', ')}).`,
    )
  }

  return new Promise<GitRun>((resolve) => {
    execFile(
      'git',
      [subcommand, ...args],
      {
        cwd: directory,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          // Nothing here talks to a remote, so a credential prompt could only be
          // a hang: the timeout would fire and the commit would be lost to a
          // question nobody can answer.
          GIT_TERMINAL_PROMPT: '0',
          // So that what lands in the log reads the same on every host.
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr, spawn: null, problem: '' })
          return
        }

        const code = (error as NodeJS.ErrnoException).code
        const killed = (error as { killed?: boolean }).killed === true
        const said = `${stderr}`.trim() || `${stdout}`.trim()

        if (killed) {
          resolve({
            ok: false,
            stdout,
            stderr,
            spawn: 'timeout',
            problem: `git ${subcommand} did not finish within ${GIT_TIMEOUT_MS} ms`,
          })
          return
        }

        if (typeof code === 'string') {
          resolve({
            ok: false,
            stdout,
            stderr,
            spawn: code === 'ENOENT' || code === 'EACCES' ? 'git-unavailable' : null,
            problem: `git ${subcommand} could not be started (${code})`,
          })
          return
        }

        resolve({
          ok: false,
          stdout,
          stderr,
          spawn: null,
          problem: `git ${subcommand} exited ${code}${said ? `: ${firstLine(said)}` : ''}`,
        })
      },
    )
  })
}

/* -------------------------------------------------------------------------- */
/*  Committing                                                                 */
/* -------------------------------------------------------------------------- */

export interface CommitContentInput {
  action: GitAction
  title: string
  /** Content-relative paths, as the index and the admin actions name them. */
  paths: string[]
  /** The settings template. Defaults to `DEFAULT_COMMIT_TEMPLATE`. */
  template?: string
  /**
   * The tree to commit in. Defaults to `CONTENT_ROOT`, and a production caller
   * should leave it out: the directory being committed has to be the one the
   * content engine writes to, and this option exists so that the tests can point
   * a repository — and the absence of one — at a directory of their own.
   */
  directory?: string
}

/**
 * Commit the given paths, and say what happened.
 *
 * Resolves for every outcome including failure: the caller is a save that has
 * already written its file, and there is nothing here worth failing it for.
 */
export async function commitContentPaths(input: CommitContentInput): Promise<GitCommitOutcome> {
  const message = renderCommitMessage(input.template ?? DEFAULT_COMMIT_TEMPLATE, input)

  // Chained rather than concurrent. Two commits landing together — a bulk
  // publish overlapping a manual save — would race for `.git/index.lock`, and
  // the loser's commit is lost to a lock error that sounds like a git problem
  // rather than a scheduling one. A commit is tens of milliseconds; the queue
  // costs nothing and removes the race. It cannot coordinate a second process
  // (`pnpm content:sync` in a terminal, a second replica), which is why a lock
  // error stays a logged failure rather than something a caller handles.
  return serialise(async () => {
    try {
      return await commit(input, message)
    } catch (error) {
      return failed(message, error instanceof Error ? error.message : String(error))
    }
  })
}

async function commit(input: CommitContentInput, message: string): Promise<GitCommitOutcome> {
  const directory = input.directory ?? CONTENT_ROOT

  let relativePaths: string[]
  try {
    relativePaths = contentPaths(input.paths)
  } catch (error) {
    return failed(message, error instanceof Error ? error.message : String(error))
  }
  if (relativePaths.length === 0) return skipped(message, 'no-paths')

  const root = await runGit('rev-parse', ['--is-inside-work-tree'], directory)
  // Git answers "is this a work tree" in two ways: `false` when it can see a
  // repository it will not treat as one, and a non-zero exit when it can see no
  // repository at all — which is the ordinary case. Both mean the same thing to
  // a caller and neither is an error worth reporting, so the exit code is not
  // treated as one. Whether git ran at all is the separate question, and a git
  // that never started is reported as exactly that.
  if (root.spawn) return unusable(message, root)
  if (!root.ok || root.stdout.trim() !== 'true') return skipped(message, 'not-a-repository')

  // Identity is checked before anything is staged, so a repository git cannot
  // sign for is left exactly as it was rather than with a half-filled index.
  const identity = await runGit('var', ['GIT_COMMITTER_IDENT'], directory)
  if (!identity.ok) {
    // Git says no for one reason worth distinguishing from the rest: a
    // container with no `user.name` is the ordinary way to arrive here.
    return identity.spawn ? unusable(message, identity) : skipped(message, 'no-identity')
  }

  const pathspecs = relativePaths.map((relative) => `:(literal)${relative}`)

  // Asked before staging, because "there is nothing to commit" is a fact about
  // the working tree and can be read without touching the index. `--porcelain`
  // prints paths relative to the repository root, which this module never
  // parses: the only question being asked is whether the output is empty.
  const status = await runGit('status', ['--porcelain', '--', ...pathspecs], directory)
  if (!status.ok) return unusable(message, status)
  if (status.stdout.trim() === '') return skipped(message, 'no-changes')

  const staged = await runGit('add', ['-A', '--', ...pathspecs], directory)
  if (!staged.ok) return unusable(message, staged)

  // `git commit -- <paths>` is a partial commit: it takes these paths from the
  // working tree and leaves the rest of the index alone. Without the pathspec a
  // commit would sweep in whatever the operator had staged themselves, under a
  // message that says it was one document.
  const committed = await runGit('commit', ['-m', message, '--', ...pathspecs], directory)
  if (!committed.ok) return unusable(message, committed)

  const sha = await runGit('rev-parse', ['--short', 'HEAD'], directory)

  return {
    status: 'committed',
    reason: null,
    message,
    sha: sha.ok ? sha.stdout.trim() || null : null,
    detail: null,
  }
}

/**
 * Validate and normalise the paths to commit.
 *
 * The admin's own schemas have already refused `..` and absolute paths, and this
 * refuses them again: the pathspec below reaches a process, and the check that
 * matters is the one next to the spawn. `:(literal)` neutralises globbing, not
 * traversal, so both are needed.
 */
function contentPaths(paths: string[]): string[] {
  const seen = new Set<string>()

  for (const raw of paths) {
    const value = toPosix(raw).replace(/^\.\//, '')
    const segments = value.split('/')

    if (
      value === '' ||
      value.startsWith('/') ||
      value.startsWith('-') ||
      segments.includes('..') ||
      value.includes(String.fromCharCode(0))
    ) {
      throw new Error(`Refusing to commit ${JSON.stringify(raw)}: not a content-relative path.`)
    }

    if (seen.size < MAX_PATHS) seen.add(value)
  }

  return [...seen]
}

/* -------------------------------------------------------------------------- */
/*  Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

function skipped(message: string, reason: GitSkipReason): GitCommitOutcome {
  return { status: 'skipped', reason, message, sha: null, detail: null }
}

function failed(message: string, detail: string): GitCommitOutcome {
  return { status: 'failed', reason: 'failed', message, sha: null, detail }
}

/** A command that could not complete: git missing, timed out, or refusing. */
function unusable(message: string, run: GitRun): GitCommitOutcome {
  if (run.spawn === 'git-unavailable') {
    return { status: 'failed', reason: 'git-unavailable', message, sha: null, detail: run.problem }
  }
  return failed(message, run.problem)
}

function firstLine(value: string): string {
  const [line = ''] = value.split('\n')
  return line.trim()
}

/* -------------------------------------------------------------------------- */
/*  Serialisation                                                              */
/* -------------------------------------------------------------------------- */

let tail: Promise<unknown> = Promise.resolve()

function serialise<T>(task: () => Promise<T>): Promise<T> {
  const next = tail.then(task, task)
  // The queue must survive a task that rejects, so the chain's own link is
  // settled either way — otherwise one failure would poison every later commit.
  tail = next.then(noop, noop)
  return next
}

function noop(): void {}
