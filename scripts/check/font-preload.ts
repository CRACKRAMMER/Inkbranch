/**
 * Check that the hand-written font preloads still name real files.
 *
 * `src/lib/fonts.ts` holds Next-generated filenames in a source file, which is
 * the kind of thing that goes wrong quietly: the files are content-hashed, so
 * changing a `next/font` option, bumping the package, or moving to a different
 * weight renames them, and every preload then points at a 404 on every page
 * that emits it. Nothing crashes. Lighthouse stops counting the 404 against the
 * score once the page still works, so the only trace is one wasted request per
 * visit and a console warning nobody reads.
 *
 * So the build asks the build.
 *
 *   pnpm check:font-preload
 *
 * Chained into `build` rather than left as something to remember, because a
 * check nobody runs is the same as no check.
 *
 * ## What it asks, and why not the font manifest
 *
 * The obvious source is `.next/server/next-font-manifest.json`, and it is the
 * wrong one. That manifest is what `next/font`'s broken preload lookup reads,
 * and in this build it is flattened: it maps all thirty-odd routes to the same
 * single Inter file and omits the other two families entirely. A check against
 * it would fail every time for the article face while the article face was
 * being served correctly — the check would be measuring the bug rather than the
 * site.
 *
 * The stylesheet is the real coupling. A preloaded file is one the browser
 * would otherwise have discovered from an `@font-face` rule, so the honest
 * question is whether any built stylesheet still names it, followed by whether
 * the build wrote it. Both have to hold.
 *
 * A missing manifest or a build with no stylesheets is *not* a failure. It
 * means this build has no fonts at all — a real possibility for a project that
 * has removed them — or that a future Next writes its output somewhere else,
 * and failing on that would break every build for a reason that has nothing to
 * do with the app. The check fails only on positive evidence of drift: CSS that
 * exists and does not reference the file, or a reference with no file behind it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRELOADED_FONTS, type FontPreload } from '../../src/lib/fonts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHUNKS = join(ROOT, '.next/static/chunks')
const MEDIA = join(ROOT, '.next/static/media')

function fail(message: string, detail: string[] = []): never {
  console.error(`✗ font-preload: ${message}`)
  for (const line of detail) console.error(`  ${line}`)
  process.exit(1)
}

if (!existsSync(CHUNKS)) {
  console.log('· font-preload: no stylesheets in this build; nothing to check')
  process.exit(0)
}

/** Every built stylesheet, concatenated — the site's `@font-face` rules. */
const css = readdirSync(CHUNKS)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(CHUNKS, name), 'utf8'))
  .join('\n')

if (css === '') {
  console.log('· font-preload: this build emits no stylesheets; nothing to check')
  process.exit(0)
}

for (const [role, font] of Object.entries(PRELOADED_FONTS)) check(role, font)

function check(role: string, font: FontPreload): void {
  const name = basename(decodeURIComponent(font.href))

  if (!css.includes(name)) {
    fail(
      `the ${role} preload names ${name}, which no stylesheet in this build references.`,
      [
        'The preload is warming a request nothing makes.',
        'Font files this build does reference:',
        // The dots matter: Next names its primary subsets `…-s.p.<hash>.woff2`
        // and the rest `…-s.<hash>.woff2`, so a pattern that stops at the first
        // dot lists half the files and hides the one being looked for.
        ...[...new Set(css.match(/[\w-]+-s\.[\w.-]+\.woff2/g) ?? [])]
          .sort()
          .map((file) => `  ${file}`),
        '',
        `Set the ${role} entry in PRELOADED_FONTS to one of those.`,
      ],
    )
  }

  // Referenced, but was it written? A stylesheet can outlive its file.
  if (!existsSync(join(MEDIA, name))) {
    fail(`${name} is referenced by the stylesheet but was not written to .next/static/media.`)
  }

  console.log(`✓ font-preload (${role}): ${name}`)
}
