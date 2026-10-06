import { describe, expect, it } from 'vitest'
import { safeNext } from '@/lib/admin/next-path'

describe('sign-in return destination', () => {
  it('keeps an ordinary same-site path and query', () => {
    expect(safeNext('/admin/posts?status=draft')).toBe('/admin/posts?status=draft')
  })

  it('rejects browser-normalized external URLs and malformed paths', () => {
    for (const value of ['//evil.test', '/\\evil.test', '/a\\evil.test',
      'https://evil.test', '/a/../admin', '/\nevil.test', '/admin/login',
      '/%2e%2e/admin', '/%252e%252e/admin', '/%5cevil.test',
      `/${'x'.repeat(600)}`]) {
      expect(safeNext(value), value).toBe('/admin')
      expect(new URL(safeNext(value), 'https://blog.test').origin).toBe('https://blog.test')
    }
  })
})
