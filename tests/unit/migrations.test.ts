import { beforeEach, describe, expect, it, vi } from 'vitest'

const handles = vi.hoisted(() => ({
  migrated: false,
  query: vi.fn(), release: vi.fn(), close: vi.fn(), connect: vi.fn(), migrate: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  createDatabase: () => ({ pool: { connect: handles.connect }, close: handles.close }),
}))
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: handles.migrate }))

import { runMigrations } from '@/lib/db/migrate'

beforeEach(() => {
  vi.clearAllMocks()
  handles.migrated = false
  handles.connect.mockResolvedValue({ query: handles.query, release: handles.release })
  handles.query.mockImplementation(async (query: { text: string }) => {
    if (query.text.includes('to_regclass')) return { rows: [{ present: handles.migrated }] }
    if (query.text.includes('count(*)')) return { rows: [{ count: '1' }] }
    return { rows: [] }
  })
  handles.migrate.mockImplementation(async (database: { $client: { query: unknown } }) => {
    expect(database.$client.query).toBe(handles.query)
    handles.migrated = true
  })
})

describe('migration connection lifetime', () => {
  it('runs advisory lock, migration and unlock on a pinned database session', async () => {
    expect(await runMigrations('postgresql://fixture@localhost/fixture')).toMatchObject({ applied: 1 })
    const statements = handles.query.mock.calls.map(([query]) => (query as { text: string }).text)
    expect(statements[0]).toContain('pg_advisory_lock($1)')
    expect(statements.at(-1)).toContain('pg_advisory_unlock($1)')
    expect(handles.connect).toHaveBeenCalledOnce()
    expect(handles.release).toHaveBeenCalledOnce()
    expect(handles.close).toHaveBeenCalledOnce()
  })

  it('releases the advisory lock and connection when migration fails', async () => {
    handles.migrate.mockRejectedValueOnce(new Error('fixture migration failure'))
    await expect(runMigrations('postgresql://fixture@localhost/fixture')).rejects.toThrow('fixture migration failure')
    expect(handles.query.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining('pg_advisory_unlock') })
    expect(handles.release).toHaveBeenCalledOnce()
    expect(handles.close).toHaveBeenCalledOnce()
  })

  it('closes the isolated pool if acquiring a connection fails', async () => {
    handles.connect.mockRejectedValueOnce(new Error('fixture connection failure'))
    await expect(runMigrations('postgresql://fixture@localhost/fixture')).rejects.toThrow('fixture connection failure')
    expect(handles.release).not.toHaveBeenCalled()
    expect(handles.close).toHaveBeenCalledOnce()
  })
})
