import { describe, expect, it } from 'vitest'

import { fontPreloadsFromCss } from '@/lib/fonts'

describe('build-specific font hints', () => {
  it('chooses the Latin subset and follows changed asset hashes', () => {
    const css = `@font-face{font-family:Inter;src:url(../media/cyrillic.woff2);unicode-range:U+460-52F}
      @font-face{font-family:Inter;src:url(../media/new-ui-hash.woff2);unicode-range:U+??,U+131}
      @font-face {font-family:'Source Serif 4';src:url('../media/new-prose-hash.woff2');unicode-range:U+0000-00FF,U+131}`
    expect(fontPreloadsFromCss(css)).toEqual({
      ui: { href: '/_next/static/media/new-ui-hash.woff2', type: 'font/woff2' },
      prose: { href: '/_next/static/media/new-prose-hash.woff2', type: 'font/woff2' },
    })
  })

  it('never preloads an unrecognized family or remote/unsafe asset', () => {
    expect(fontPreloadsFromCss(`@font-face{font-family:Inter;src:url(data:bad);unicode-range:U+??}
      @font-face{font-family:Other;src:url(other.woff2);unicode-range:U+??}`)).toEqual({})
  })
})
