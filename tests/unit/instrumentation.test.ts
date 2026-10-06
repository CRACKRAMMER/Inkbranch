import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  warmHighlighter: vi.fn(),
  startEmbeddedWorker: vi.fn(),
}))
vi.mock('@/lib/markdown/shiki', () => ({ warmHighlighter: hooks.warmHighlighter }))
vi.mock('@/lib/jobs', () => ({ startEmbeddedWorker: hooks.startEmbeddedWorker }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('NEXT_RUNTIME', 'nodejs')
  vi.stubEnv('NODE_ENV', 'production')
})
afterEach(() => {
  vi.doUnmock('@/env')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('startup configuration rejection', () => {
  it.each(['shape', 'posture'])('exits production on a %s error before starting services', async (failure) => {
    const cause = new Error(failure === 'shape'
      ? 'Invalid environment configuration:\n  - COOKIE_SECURE: Expected 0, 1, true or false'
      : 'SITE_URL must use https:// in production.')
    if (failure === 'shape') {
      vi.doUnmock('@/env')
      vi.stubEnv('COOKIE_SECURE', 'maybe')
    } else {
      vi.doMock('@/env', () => ({ env: { WORKER_ENABLED: true }, assertProductionPosture: () => { throw cause } }))
    }
    const exitSignal = new Error('mocked process termination')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exitSignal })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { register } = await import('@/instrumentation')
    await expect(register()).rejects.toBe(exitSignal)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(log).toHaveBeenCalledExactlyOnceWith('[startup] Configuration refused:', cause.message)
    expect(hooks.warmHighlighter).not.toHaveBeenCalled()
    expect(hooks.startEmbeddedWorker).not.toHaveBeenCalled()
  })

  it('rethrows development validation errors without terminating the dev server', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.doUnmock('@/env')
    vi.stubEnv('DATABASE_URL', 'malformed')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit') })
    const { register } = await import('@/instrumentation')
    await expect(register()).rejects.toThrow(/Invalid environment configuration:\n  - DATABASE_URL/)
    expect(exit).not.toHaveBeenCalled()
  })

  it('does not load the Node configuration in an edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    const load = vi.fn(() => { throw new Error('unexpected Node configuration import') })
    vi.doMock('@/env', load)
    const { register } = await import('@/instrumentation')
    await register()
    expect(load).not.toHaveBeenCalled()
    expect(hooks.warmHighlighter).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps valid startup and worker enablement %s intact', async (enabled) => {
    const posture = vi.fn()
    vi.doMock('@/env', () => ({ env: { WORKER_ENABLED: enabled }, assertProductionPosture: posture }))
    const { register } = await import('@/instrumentation')
    await register()
    expect(posture).toHaveBeenCalledOnce()
    expect(hooks.warmHighlighter).toHaveBeenCalledOnce()
    expect(hooks.startEmbeddedWorker).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })
})
