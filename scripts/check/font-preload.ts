/** Verify font hints against this build's CSS and media, including standalone. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FONT_FAMILIES, fontPreloadsFromCss } from '../../src/lib/fonts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const chunks = join(root, '.next/static/chunks')
const css = readdirSync(chunks)
  .filter((file) => file.endsWith('.css'))
  .map((file) => readFileSync(join(chunks, file), 'utf8'))
  .join('\n')
const preloads = fontPreloadsFromCss(css)

for (const role of Object.keys(FONT_FAMILIES) as (keyof typeof FONT_FAMILIES)[]) {
  const font = preloads[role]
  if (!font || !existsSync(join(root, '.next/static/media', basename(font.href)))) {
    console.error(`✗ font-preload: ${role} has no emitted Latin font file`)
    process.exit(1)
  }
  console.log(`✓ font-preload (${role}): ${basename(font.href)}`)
}
