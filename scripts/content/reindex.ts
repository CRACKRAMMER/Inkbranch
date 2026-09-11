import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { flagBool, flagInt, heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * Rebuild the search index.
 *
 * A row is stale when its `search_index_version` is behind `SEARCH_INDEX_VERSION`
 * — the constant that gets bumped when a search document gains a field, so that
 * the change has a work list instead of silently costing recall. The background
 * job does the same thing on a schedule; this is the command for the operator who
 * does not want to wait for it, and for a deploy that bumped the version.
 *
 * What "rebuild" means here depends on the provider, and the script says which
 * one it ran. `local` reads the Markdown files at query time and keeps nothing in
 * the database to push, so the work is: re-parse each document's file and rewrite
 * its row in the current shape, then stamp it. A remote provider would push each
 * document between those two steps; there is no such provider yet, and the
 * reindex job refuses to stamp rows for one rather than claiming a push that
 * never happened. This script does not stamp anything it did not rewrite either.
 *
 * `--force` rebuilds every indexed row rather than only the stale ones. That is
 * O(n²) in documents — `syncOneDocument` rescans the content tree per document —
 * so it is for the case that needs it (a version bump made without the stamp, a
 * row edited by hand) and not for routine use.
 */
const args = parseArgs(process.argv.slice(2))
const force = flagBool(args, 'force')
const limit = flagInt(args, 'limit', 0)

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:reindex', async () => {
  const { env } = await import('@/env')
  const { SEARCH_INDEX_VERSION } = await import('@/lib/search/provider')
  const { findStaleSearchRows, syncOneDocument } = await import('@/lib/content/sync')

  heading('Search reindex')
  info(`Provider: ${style.bold(env.SEARCH_PROVIDER)}`)
  info(`Document shape version: ${SEARCH_INDEX_VERSION}`)
  if (env.SEARCH_PROVIDER === 'local') {
    info(
      style.dim(
        'local: the searchable text lives in the Markdown files and is indexed in process. ' +
          'This rewrites and stamps the database rows; there is no external index to push to.',
      ),
    )
  }

  const stale = await findStaleSearchRows()

  let targets = stale
  if (force) {
    const { db } = await import('@/lib/db')
    const { contentIndex } = await import('@/lib/db/schema')
    targets = await db
      .select({
        id: contentIndex.id,
        type: contentIndex.type,
        slug: contentIndex.slug,
        path: contentIndex.path,
        searchIndexVersion: contentIndex.searchIndexVersion,
      })
      .from(contentIndex)
      .orderBy(contentIndex.path)
    info(
      `--force: rebuilding all ${targets.length} indexed rows, not only the ${stale.length} behind version ${SEARCH_INDEX_VERSION}`,
    )
  }

  if (targets.length === 0) {
    heading('Summary')
    report({
      'Rows behind the current version': 0,
      Rebuilt: 0,
      Removed: 0,
      Failed: 0,
      'Still behind': 0,
    })
    info(style.green('Nothing to rebuild; every row is indexed under the current shape.'))
    return
  }

  const requested = limit > 0 ? targets.slice(0, limit) : targets
  if (requested.length < targets.length) {
    info(`--limit ${limit}: rebuilding ${requested.length} of ${targets.length} rows`)
  }

  heading('Rebuilding')

  let rebuilt = 0
  let removed = 0
  const failures: { path: string; message: string }[] = []

  for (const row of requested) {
    try {
      const result = await syncOneDocument(row.path)
      if (result) {
        rebuilt += 1
        info(`${style.green('✓')} ${row.path}  ${style.dim(result.document.title)}`)
      } else {
        // The file is gone; `syncOneDocument` drops the row rather than writing
        // a stale one. Counting that as a rebuild would be the exact lie this
        // script exists to avoid.
        removed += 1
        info(`${style.red('-')} ${row.path}  ${style.dim('file is gone; its row was removed')}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ path: row.path, message })
      warn(`${row.path}: ${message}`)
    }
  }

  // Asked again rather than assumed: `syncOneDocument` stamps what it writes,
  // and this is the check that says whether that is what happened.
  const remaining = await findStaleSearchRows()

  heading('Summary')
  report({
    'Rows behind the current version': stale.length,
    Requested: requested.length,
    Rebuilt: rebuilt,
    Removed: removed,
    Failed: failures.length,
    'Still behind': remaining.length,
    ...(limit > 0 ? { 'Not attempted (--limit)': targets.length - requested.length } : {}),
  })

  if (remaining.length > 0) {
    warn(
      `${remaining.length} row${remaining.length === 1 ? ' is' : 's are'} still indexed under an older ` +
        'shape. Re-run to pick them up, or investigate why they were not written.',
    )
    process.exitCode = 1
  }

  if (failures.length > 0) {
    warn(`${failures.length} document${failures.length === 1 ? '' : 's'} could not be rebuilt.`)
    process.exitCode = 1
  }

  if (remaining.length === 0 && failures.length === 0) {
    info(style.green(`Rebuilt ${rebuilt} row${rebuilt === 1 ? '' : 's'}; nothing is behind.`))
  }
})
