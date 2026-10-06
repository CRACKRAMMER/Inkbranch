import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashToken } from '@/lib/auth/tokens'

const state = vi.hoisted(() => ({ headers: new Headers(), cookie: 'session-csrf-token' }))
vi.mock('next/headers', () => ({ headers: async () => state.headers }))
vi.mock('@/lib/auth/session', () => ({
  getRequestContext: async () => ({
    origin: state.headers.get('origin'), referer: state.headers.get('referer'),
  }),
  trustedHosts: () => ['blog.test'],
  getCsrfToken: async () => state.cookie,
}))

import { assertTrustedOrigin, CsrfError, readCsrfToken, verifyCsrfRequest, verifyCsrfToken } from '@/lib/auth/csrf'

beforeEach(() => { state.headers = new Headers() })
const session = { csrfTokenHash: hashToken('session-csrf-token') }

describe('CSRF request guard', () => {
  it('refuses cross-site and same-site requests before permitting any mutation', async () => {
    for (const fetchSite of ['cross-site', 'same-site']) {
      state.headers = new Headers({ 'sec-fetch-site': fetchSite, 'x-csrf-token': state.cookie })
      await expect(verifyCsrfRequest(session)).rejects.toBeInstanceOf(CsrfError)
    }
  })

  it('checks Origin or Referer when browser fetch metadata is absent', async () => {
    state.headers = new Headers({ origin: 'https://evil.test', 'x-csrf-token': state.cookie })
    await expect(verifyCsrfRequest(session)).rejects.toBeInstanceOf(CsrfError)
    state.headers = new Headers({ referer: 'https://blog.test/admin/posts' })
    await expect(assertTrustedOrigin()).resolves.toBeUndefined()
    state.headers = new Headers({ origin: 'null' })
    await expect(assertTrustedOrigin()).rejects.toBeInstanceOf(CsrfError)
  })

  it('binds the token to the current session and rejects absent or foreign tokens', () => {
    expect(() => verifyCsrfToken(session, state.cookie)).not.toThrow()
    expect(() => verifyCsrfToken(session, 'another-session-token')).toThrow(CsrfError)
    expect(() => verifyCsrfToken(session, undefined)).toThrow(CsrfError)
  })

  it('checks the token even when fetch metadata permits the origin', async () => {
    state.headers = new Headers({ 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'foreign-token' })
    await expect(verifyCsrfRequest(session)).rejects.toBeInstanceOf(CsrfError)
  })

  it('prefers an explicit header or form token over the readable cookie', async () => {
    const form = new FormData()
    form.set('csrf', 'form-token')
    state.headers.set('x-csrf-token', 'header-token')
    expect(await readCsrfToken(form)).toBe('header-token')
    state.headers.delete('x-csrf-token')
    expect(await readCsrfToken(form)).toBe('form-token')
  })
})
