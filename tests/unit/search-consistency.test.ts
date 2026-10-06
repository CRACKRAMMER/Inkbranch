import fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDocument } from '@/lib/content/writer'
import { invalidateSearchIndex, runSearch } from '@/lib/search/local'

const files: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  invalidateSearchIndex()
  for (const file of files.splice(0)) await fs.rm(file, { force: true })
})

describe('search freshness and scheduled visibility', () => {
  it('hides future scheduled content even when its ordinary date is in the past', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const created = await createDocument({
      type: 'post', slug: 'future-scheduled-secret', data: {
        title: 'Future Scheduled Secret', slug: 'future-scheduled-secret',
        date: '2020-01-01', status: 'scheduled', publishAt: future,
      }, body: 'unreleasedword\n',
    })
    files.push(created.absolutePath)
    invalidateSearchIndex()
    expect((await runSearch({ q: 'unreleasedword' })).hits).toEqual([])
    expect((await runSearch({ q: 'unreleasedword', statuses: ['scheduled'] })).hits).toHaveLength(1)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(future) + 1)
    expect((await runSearch({ q: 'unreleasedword' })).hits).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('rebuilds after a same-size edit whose mtime remains older than another document', async () => {
    const created = await createDocument({
      type: 'note', slug: 'older-search-document',
      data: { title: 'Older Search Document', slug: 'older-search-document', date: '2020-01-01' },
      body: 'firsttoken\n',
    })
    const newer = await createDocument({
      type: 'post', slug: 'newer-search-document',
      data: { title: 'Newer Search Document', slug: 'newer-search-document', date: '2020-01-01' },
      body: 'Unrelated.\n',
    })
    files.push(created.absolutePath, newer.absolutePath)
    const start = Date.now()
    const old = new Date(start - 60_000)
    const newest = new Date(start + 60_000)
    await fs.utimes(created.absolutePath, old, old)
    await fs.utimes(newer.absolutePath, newest, newest)
    invalidateSearchIndex()
    expect((await runSearch({ q: 'firsttoken' })).hits).toHaveLength(1)
    const original = await fs.readFile(created.absolutePath, 'utf8')
    await fs.writeFile(created.absolutePath, original.replace('firsttoken', 'latertoken'))
    const moved = new Date(old.getTime() + 1_000)
    await fs.utimes(created.absolutePath, moved, moved)
    vi.spyOn(Date, 'now').mockReturnValue(start + 6_000)
    expect((await runSearch({ q: 'latertoken' })).hits).toHaveLength(1)
    expect((await runSearch({ q: 'firsttoken' })).hits).toEqual([])
    vi.restoreAllMocks()
  })
})
