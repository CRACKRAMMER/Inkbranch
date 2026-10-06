import 'server-only'

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { fontPreloadsFromCss, type FontPreload, type FontRole } from './fonts'

let builtFonts: Partial<Record<FontRole, FontPreload>> | undefined

/** The output is immutable for a server process, so inspect it only once. */
export function getFontPreload(role: FontRole): FontPreload | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined
  if (!builtFonts) {
    const chunks = path.join(process.cwd(), '.next', 'static', 'chunks')
    try {
      const css = readdirSync(chunks)
        .filter((file) => file.endsWith('.css'))
        .map((file) => readFileSync(path.join(chunks, file), 'utf8'))
        .join('\n')
      builtFonts = fontPreloadsFromCss(css)
    } catch (error) {
      // Preloading improves discovery; the CSS still loads the correct fonts.
      console.error('[fonts] built stylesheets could not be read for preload hints', error)
      builtFonts = {}
    }
  }
  return builtFonts[role]
}
