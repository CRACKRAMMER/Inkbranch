/**
 * Read helpers shared by the integration tests.
 *
 * They query the database directly rather than through `src/lib/graph` or
 * `src/lib/content/queries`, deliberately. An integration test asserting that
 * the write path stored the right rows should not depend on the read path
 * agreeing with it — if both went through the same module, a systematic
 * misunderstanding of the schema would satisfy both and the test would pass
 * while the site was broken.
 */

export interface LinkRow {
  sourcePath: string
  targetPath: string | null
  kind: string
  href: string
  resolved: boolean
}

/** Every `content_links` row, joined to the path of the document it points at. */
export async function getContentLinks(): Promise<LinkRow[]> {
  const { db } = await import('@/lib/db')
  const { contentIndex, contentLinks } = await import('@/lib/db/schema')
  const { aliasedTable, eq } = await import('drizzle-orm')

  const target = aliasedTable(contentIndex, 'target')

  const rows = await db
    .select({
      sourcePath: contentIndex.path,
      targetPath: target.path,
      kind: contentLinks.kind,
      href: contentLinks.href,
      resolved: contentLinks.resolved,
    })
    .from(contentLinks)
    .innerJoin(contentIndex, eq(contentIndex.id, contentLinks.sourceId))
    .leftJoin(target, eq(target.id, contentLinks.targetId))

  return rows
}
