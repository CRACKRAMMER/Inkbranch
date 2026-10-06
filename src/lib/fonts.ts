/** Font roles stay stable while next/font chooses build-specific asset URLs. */
export const UI_FONT = 'ui'
export const PROSE_FONT = 'prose'
export const FONT_FAMILIES = { ui: 'Inter', prose: 'Source Serif 4' } as const
export type FontRole = keyof typeof FONT_FAMILIES

export interface FontPreload {
  href: string
  type: string
}

/** Read the Latin face from emitted CSS, rather than pinning a generated hash. */
export function fontPreloadsFromCss(css: string): Partial<Record<FontRole, FontPreload>> {
  const fonts: Partial<Record<FontRole, FontPreload>> = {}
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const rule = match[1] ?? ''
    const family = rule.match(/font-family\s*:\s*([^;]+)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    // Latin is the basic U+0000–00FF face. Do not warm a different subset,
    // which would cost a request without helping the UI or English prose.
    if (!/unicode-range\s*:\s*U\+(?:0{2,4}-00FF|\?\?)(?:[,;]|$)/i.test(rule)) continue
    const source = rule.match(/src\s*:\s*url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/)?.[1]
    if (!source) continue
    const filename = source.split('/').at(-1)
    if (!filename || !/^[\w.-]+\.woff2$/.test(filename)) continue
    for (const [role, expected] of Object.entries(FONT_FAMILIES)) {
      if (family === expected) fonts[role as FontRole] = { href: `/_next/static/media/${filename}`, type: 'font/woff2' }
    }
  }
  return fonts
}
