import { describe, expect, it } from 'vitest'
import { safeUrlSchema } from '@/lib/content/schema'

describe('Markdown metadata URL validation', () => {
  it('accepts ordinary encoded filenames, absolute web URLs, and internal paths', () => {
    for (const value of ['/uploads/a.png', '/notes/%E4%B8%AD%E6%96%87',
      'https://example.test/image.png', '/uploads/image.png?size=100']) {
      expect(safeUrlSchema.safeParse(value).success, value).toBe(true)
    }
  })

  it('rejects unsafe paths and URLs before they reach metadata or project links', () => {
    for (const value of ['/\\evil.test', '//evil.test', '/a\\b',
      '/a/../b', '/%2e%2e/b', '/%252e%252e/b', '/%5cevil.test',
      '/a\nb', 'javascript:alert(1)', 'data:text/html,evil',
      'https:evil.test', 'https://good.test\\@evil.test']) {
      expect(safeUrlSchema.safeParse(value).success, value).toBe(false)
    }
  })
})
