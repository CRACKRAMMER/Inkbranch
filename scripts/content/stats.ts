import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'
import { heading, info, parseArgs, report, run, style, warn } from '../lib/cli'

/**
 * What is in the content tree, by the numbers.
 *
 * Every number here is read from the content index, not from the files: the
 * aggregate queries are the reason the index exists, and re-parsing a few
 * thousand Markdown files to count words would make this command too slow to
 * run. The index can therefore be behind the disk, which the report says out
 * loud rather than presenting the numbers as the truth about the files —
 * `pnpm content:sync` is the command that makes them agree.
 *
 * Orphans come from `getOrphans` rather than from a query, because "no links in
 * or out" is a property of the link graph the relations index already holds, and
 * a second definition of it here would be a second answer to the same question.
 */
const args = parseArgs(process.argv.slice(2))
const top = Number.parseInt(String(args.flags['top'] ?? '15'), 10)
const rowLimit = Number.isInteger(top) && top > 0 ? top : 15
const showAll = args.flags['all'] !== undefined

const loaded = loadEnvFiles()
if (loaded.length > 0) {
  info(`Loaded environment from ${loaded.join(', ')}`)
}

void run('content:stats', async () => {
  const { db } = await import('@/lib/db')
  const { contentIndex, contentLinks, contentTags, tags } = await import('@/lib/db/schema')
  const { and, count, eq, isNotNull, sum } = await import('drizzle-orm')
  const { getOrphans } = await import('@/lib/graph/graph')
  const { CONTENT_STATUSES } = await import('@/lib/content/schema')

  const totals = await db
    .select({
      type: contentIndex.type,
      status: contentIndex.status,
      documents: count(),
      words: sum(contentIndex.wordCount),
      readingTime: sum(contentIndex.readingTime),
    })
    .from(contentIndex)
    .groupBy(contentIndex.type, contentIndex.status)

  let documents = 0
  let words = 0
  let readingTime = 0
  const byType = new Map<string, { documents: number; words: number; readingTime: number; statuses: Map<string, number> }>()

  for (const row of totals) {
    const n = Number(row.documents)
    documents += n
    words += Number(row.words ?? 0)
    readingTime += Number(row.readingTime ?? 0)

    const entry = byType.get(row.type) ?? {
      documents: 0,
      words: 0,
      readingTime: 0,
      statuses: new Map<string, number>(),
    }
    entry.documents += n
    entry.words += Number(row.words ?? 0)
    entry.readingTime += Number(row.readingTime ?? 0)
    entry.statuses.set(row.status, (entry.statuses.get(row.status) ?? 0) + n)
    byType.set(row.type, entry)
  }

  heading('Documents')
  if (documents === 0) {
    warn('The index holds no documents. If the content tree is not empty, run `pnpm content:sync`.')
  }

  for (const [type, entry] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const statuses = [...entry.statuses]
      .map(([status, n]) => `${status} ${n}`)
      .join(', ')
    console.log(
      `  ${style.bold(type.padEnd(9))} ${String(entry.documents).padStart(5)}  ` +
        `${String(entry.words).padStart(8)} words  ${formatMinutes(entry.readingTime).padStart(8)}  ` +
        style.dim(statuses),
    )
  }

  report({
    Documents: documents,
    Words: words.toLocaleString('en-US'),
    'Reading time': formatMinutes(readingTime),
  })

  const tagRows = await db
    .select({ name: tags.name, slug: tags.slug, documents: count() })
    .from(contentTags)
    .innerJoin(tags, eq(tags.id, contentTags.tagId))
    .groupBy(tags.id, tags.name, tags.slug)

  const rankedTags = [...tagRows].sort(
    (a, b) => Number(b.documents) - Number(a.documents) || a.name.localeCompare(b.name),
  )
  const shownTags = showAll ? rankedTags : rankedTags.slice(0, rowLimit)

  heading(`Tags (${rankedTags.length})`)
  if (rankedTags.length === 0) {
    info(style.dim('No tags are in use.'))
  }
  for (const tag of shownTags) {
    console.log(`  ${String(tag.documents).padStart(4)}  ${tag.name}  ${style.dim(`/tags/${tag.slug}`)}`)
  }
  if (shownTags.length < rankedTags.length) {
    info(style.dim(`… ${rankedTags.length - shownTags.length} more (--all to show every tag)`))
  }

  const inbound = await db
    .select({
      path: contentIndex.path,
      title: contentIndex.title,
      type: contentIndex.type,
      inbound: count(),
    })
    .from(contentLinks)
    .innerJoin(contentIndex, eq(contentIndex.id, contentLinks.targetId))
    .where(and(isNotNull(contentLinks.targetId), eq(contentLinks.resolved, true)))
    .groupBy(contentIndex.path, contentIndex.title, contentIndex.type)

  const ranked = [...inbound].sort(
    (a, b) => Number(b.inbound) - Number(a.inbound) || a.path.localeCompare(b.path),
  )
  const shown = showAll ? ranked : ranked.slice(0, rowLimit)

  heading(`Most linked-to documents (${ranked.length} with inbound links)`)
  if (ranked.length === 0) {
    info(style.dim('Nothing links to anything yet.'))
  }
  for (const row of shown) {
    console.log(`  ${String(row.inbound).padStart(4)}  ${row.path}  ${style.dim(row.title)}`)
  }
  if (shown.length < ranked.length) {
    info(style.dim(`… ${ranked.length - shown.length} more (--all to show every document)`))
  }

  const broken = await db
    .select({ kind: contentLinks.kind, unresolved: count() })
    .from(contentLinks)
    .where(eq(contentLinks.resolved, false))
    .groupBy(contentLinks.kind)

  let brokenLinks = 0
  let brokenImages = 0
  let otherBroken = 0
  for (const row of broken) {
    const n = Number(row.unresolved)
    if (row.kind === 'image') brokenImages += n
    else if (row.kind === 'internal' || row.kind === 'wiki') brokenLinks += n
    else otherBroken += n
  }

  // Every status, not only the published ones: a draft with no links is still
  // writing that nothing points at, and hiding it would make the orphan count
  // disagree with the document count above.
  const orphans = await getOrphans({ statuses: CONTENT_STATUSES })
  const shownOrphans = showAll ? orphans : orphans.slice(0, rowLimit)

  heading(`Orphans (${orphans.length} with no links in or out)`)
  if (orphans.length === 0) {
    info(style.dim('Every document is connected to something.'))
  }
  for (const orphan of shownOrphans) {
    console.log(`  ${orphan.url}  ${style.dim(orphan.title)}`)
  }
  if (shownOrphans.length < orphans.length) {
    info(style.dim(`… ${orphans.length - shownOrphans.length} more (--all to show every document)`))
  }

  heading('Summary')
  report({
    Documents: documents,
    Words: words.toLocaleString('en-US'),
    'Reading time': formatMinutes(readingTime),
    Tags: rankedTags.length,
    'Broken links': brokenLinks,
    'Broken images': brokenImages,
    ...(otherBroken > 0 ? { 'Broken anchors': otherBroken } : {}),
    Orphans: orphans.length,
  })

  info(
    style.dim(
      'Counts come from the content index, not from the files. `pnpm content:sync` reconciles the two.',
    ),
  )

  if (brokenLinks > 0) {
    info(style.dim('`pnpm content:links` lists them by file and line.'))
    process.exitCode = 1
  }
})

/** `142` → `2h 22m`. Reading time is stored in minutes. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}
