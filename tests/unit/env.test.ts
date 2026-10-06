import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:password@127.0.0.1/fixture')
  vi.stubEnv('SESSION_SECRET', 'fixture-secret-at-least-thirty-two-characters')
})
afterEach(() => vi.unstubAllEnvs())

describe('environment validation', () => {
  it.each(['1', 'true', 'TRUE', '0', 'false', 'FALSE'])('accepts the explicit boolean %s', async (value) => {
    vi.stubEnv('WORKER_ENABLED', value)
    const { env } = await import('@/env')
    expect(env.WORKER_ENABLED).toBe(['1', 'true'].includes(value.toLowerCase()))
  })

  it.each(['yes', 'enabled', 'tru', '2', ''])('refuses the unrecognized boolean %s', async (value) => {
    vi.stubEnv('ANALYTICS_ENABLED', value)
    await expect(import('@/env')).rejects.toThrow(/ANALYTICS_ENABLED.*Expected 0, 1, true or false/)
  })

  it.each(['postgres://', 'postgresql://localhost', 'postgresql://localhost:invalid/db', 'https://localhost/db'])('refuses a malformed database URL %s', async (value) => {
    vi.stubEnv('DATABASE_URL', value)
    await expect(import('@/env')).rejects.toThrow(/DATABASE_URL/)
  })

  it.each(['not-a-url', 'ftp://example.test', 'https://user:password@example.test', 'https://example.test/blog', 'https://example.test?token=secret', 'https://example.test#fragment'])('refuses a non-public site origin %s', async (value) => {
    vi.stubEnv('SITE_URL', value)
    await expect(import('@/env')).rejects.toThrow(/SITE_URL/)
  })

  it('refuses insecure runtime production posture while accepting build-time shape', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COOKIE_SECURE', '0')
    const { assertProductionPosture } = await import('@/env')
    expect(assertProductionPosture).toThrow(/COOKIE_SECURE/)
  })
})
