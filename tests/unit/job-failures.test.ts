import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledJobRow } from '@/lib/db/schema'

const mock = vi.hoisted(() => ({ sync: vi.fn(), update: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/content/sync', async (original) => ({
  ...await original<typeof import('@/lib/content/sync')>(),
  syncContent: mock.sync,
}))
vi.mock('@/lib/content/writer', async (original) => ({
  ...await original<typeof import('@/lib/content/writer')>(),
  updateDocument: mock.update,
}))
vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('@/lib/db')>(),
  db: { select: mock.select },
}))

import { jobHandlers, PublishSupersededError } from '@/lib/jobs/handlers'

const log = { info: vi.fn(), error: vi.fn() }
const context = {
  job: {} as ScheduledJobRow,
  signal: new AbortController().signal,
  log,
}
const report = {
  scanned: 1, added: 0, updated: 0, deleted: 0, unchanged: 1,
  tagsCreated: 0, linksResolved: 0, linksBroken: 0, durationMs: 1,
  truncated: false, errors: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.sync.mockResolvedValue(report)
  mock.select.mockReturnValue({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{
      id: 'fixture', path: 'posts/fixture.md', status: 'scheduled', scheduledAt: new Date(0),
    }] }) }) }),
  })
})

describe('worker incomplete-job status', () => {
  it('rejects truncated sync instead of completing a partial job', async () => {
    mock.sync.mockResolvedValueOnce({ ...report, truncated: true })
    await expect(jobHandlers['content.sync'](context)).rejects.toThrow(/Content sync incomplete.*CONTENT_MAX_FILES/)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'job.content-sync.truncated' }))
  })

  it('rejects per-file sync errors so the worker records failure and retries', async () => {
    mock.sync.mockResolvedValueOnce({ ...report, errors: [{ path: 'posts/bad.md', message: 'invalid frontmatter' }] })
    await expect(jobHandlers['content.sync'](context)).rejects.toThrow(/posts\/bad.md: invalid frontmatter/)
  })

  it('completes a genuinely successful sync', async () => {
    await expect(jobHandlers['content.sync'](context)).resolves.toMatchObject({ truncated: false, errorCount: 0 })
  })

  it('rejects a failed scheduled write instead of marking publishing done', async () => {
    mock.update.mockRejectedValueOnce(new Error('fixture disk full'))
    await expect(jobHandlers['content.publish-scheduled'](context)).rejects.toThrow(/posts\/fixture.md: fixture disk full/)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'job.content-publish-scheduled.failed' }))
  })

  it('treats a superseded schedule as a safe no-op rather than a failed write', async () => {
    mock.update.mockRejectedValueOnce(new PublishSupersededError('posts/fixture.md', 'rescheduled by author'))
    await expect(jobHandlers['content.publish-scheduled'](context)).resolves.toMatchObject({
      errorCount: 0, publishedCount: 0, skipped: [{ path: 'posts/fixture.md', reason: expect.stringContaining('rescheduled') }],
    })
  })
})
