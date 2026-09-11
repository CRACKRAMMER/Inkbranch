import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { flagBool, heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * Report on the links between documents.
 *
 * A wiki-style site accumulates broken links quietly: a note is renamed and
 * every `[[Old Name]]` pointing at it becomes a dead end that renders as plain
 * text. The sync pass counts them but does not say which, and "1 broken link"
 * is not something anybody can act on.
 *
 * This walks the link table and prints the ones that need fixing, grouped by
 * the document that contains them, so the fix is a file and a line rather than
 * a search.
 */
const args = parseArgs(process.argv.slice(2))
const showAll = flagBool(args, 'all')
const onlyBroken = flagBool(args, 'broken') || !showAll

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:links', async () => {
  const { db } = await import('@/lib/db')
  const { contentLinks, contentIndex } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')

  heading('Link report')

  // One query, joined to the source document so the output can name a file
  // rather than a UUID. A row exists for every link found, resolved or not,
  // which is what makes the broken ones discoverable at all — a link that
  // failed to resolve could otherwise only be found by re-parsing every file.
  const rows = await db
    .select({
      sourcePath: contentIndex.path,
      sourceTitle: contentIndex.title,
      kind: contentLinks.kind,
      targetKey: contentLinks.targetKey,
      href: contentLinks.href,
      resolved: contentLinks.resolved,
    })
    .from(contentLinks)
    .innerJoin(contentIndex, eq(contentIndex.id, contentLinks.sourceId))
    .orderBy(contentIndex.path, contentLinks.targetKey)

  const broken = rows.filter((row) => !row.resolved)
  const internal = rows.filter((row) => row.kind === 'internal' || row.kind === 'wiki')

  report({
    'Total links': rows.length,
    Internal: internal.length,
    Resolved: rows.length - broken.length,
    Broken: broken.length,
  })

  if (broken.length > 0) {
    heading('Broken links')

    // Grouped by source: the fix is per-file, and a list sorted by target would
    // send the reader to the same file five times.
    const bySource = new Map<string, typeof broken>()
    for (const row of broken) {
      const list = bySource.get(row.sourcePath)
      if (list) list.push(row)
      else bySource.set(row.sourcePath, [row])
    }

    for (const [path, items] of bySource) {
      console.log(`\n  ${style.bold(path)}`)
      for (const item of items) {
        console.log(`    ${style.red('✗')} ${item.href}`)
        console.log(`      ${style.dim(`looked for target: ${item.targetKey}`)}`)
      }
    }
    console.log('')
  }

  if (showAll && !onlyBroken) {
    heading('All links')
    for (const row of rows) {
      const mark = row.resolved ? style.green('✓') : style.red('✗')
      console.log(`  ${mark} ${row.sourcePath} → ${row.href}`)
    }
  }

  if (broken.length > 0) {
    warn('A broken wiki link renders as plain text. Rename the target back, or update the link.')
    process.exitCode = 1
  } else {
    info(style.green('No broken links.'))
  }
})
