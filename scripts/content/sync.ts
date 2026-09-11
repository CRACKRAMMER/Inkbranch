import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { flagBool, heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * Reconcile the content index with the files on disk.
 *
 * This is the command to run after the files change outside the admin — a
 * `git pull`, an SSH edit, a restore from backup. The application reconciles at
 * boot and after every admin save, so this exists for the cases where neither
 * happened: a deployment that does not restart, a CI step that wants the index
 * verified, a person who wants to see what changed.
 *
 * `--check` answers "is the index out of sync?" without writing. It uses the
 * same cheap check the app runs at boot — file count plus size and mtime — and
 * says so, because that comparison is a pre-filter rather than a proof: a file
 * edited to the same length within the same mtime granularity would pass it and
 * still differ. Use it as a gate, not as a guarantee.
 *
 * `--hash-all` ignores the mtime pre-filter and re-hashes every file. Slower,
 * and the only mode that can find a change the pre-filter missed.
 */
const args = parseArgs(process.argv.slice(2))
const checkOnly = flagBool(args, 'check')
const hashAll = flagBool(args, 'hash-all')

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:sync', async () => {
  // Dynamic for the same reason as `scripts/db/migrate.ts`: a static import is
  // hoisted and would read `process.env` before `loadEnvFiles()` ran, throwing
  // on a missing DATABASE_URL before the first line of this file executes.
  const { syncContent, checkContentDrift } = await import('@/lib/content/sync')

  if (checkOnly) {
    heading('Checking content drift')

    const result = await checkContentDrift()
    report({
      'Files on disk': result.scanned,
      'Rows in index': result.indexed,
      Drift: result.drift,
    })

    if (result.drift) {
      warn('The index and the filesystem disagree. Run `pnpm content:sync` to reconcile.')
      process.exitCode = 1
    } else {
      info(style.green('In sync.'))
    }
    return
  }

  const { invalidateRelationsIndex } = await import('@/lib/graph/relations')

  heading('Scanning content')

  const result = await syncContent({
    ...(hashAll ? { hashAll: true } : {}),
    onEvent: (event) => {
      switch (event.kind) {
        case 'added':
          info(`${style.green('+')} ${event.path}  ${style.dim(event.title)}`)
          break
        case 'updated':
          info(`${style.cyan('~')} ${event.path}  ${style.dim(event.title)}`)
          break
        case 'deleted':
          info(`${style.red('-')} ${event.path}`)
          break
        case 'error':
          warn(`${event.path}: ${event.message}`)
          break
        case 'skipped':
          break
      }
    },
  })

  heading('Summary')
  report({
    Scanned: result.scanned,
    Added: result.added,
    Updated: result.updated,
    Deleted: result.deleted,
    Unchanged: result.unchanged,
    'Tags created': result.tagsCreated,
    'Links resolved': result.linksResolved,
    'Links broken': result.linksBroken,
    Errors: result.errors.length,
    Duration: `${result.durationMs}ms`,
  })

  for (const error of result.errors) {
    warn(`${error.path}: ${error.message}`)
  }

  // The relations index is an in-process cache of the backlink graph, built
  // from `content_index`. It has no way to know the index moved underneath it,
  // so a long-running server would keep serving stale backlinks after a sync.
  // In a CLI this drops a cache in a process that is about to exit, which is
  // harmless — it is here so the two paths cannot drift apart.
  invalidateRelationsIndex()

  if (result.truncated) {
    // Loud, because the consequence is not just an incomplete report: files
    // past the cap look absent to the reconciler, and absent files are removed
    // from the index. Silent truncation is data loss with extra steps.
    warn(
      `The scan stopped at ${result.scanned} files (CONTENT_MAX_FILES). ` +
        'Files beyond the limit were not seen and their index rows may have been removed. ' +
        'Raise CONTENT_MAX_FILES and re-run.',
    )
  }

  if (result.errors.length > 0) {
    process.exitCode = 1
  }
})
