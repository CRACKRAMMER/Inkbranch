/**
 * Serve the production build the way production serves it.
 *
 * `next start` cannot do this. It reads `.next/` directly and expects a build
 * it can still consult the build-time manifests of, which is not what
 * `output: 'standalone'` leaves behind — so the one command everybody reaches
 * for first is the one that does not measure the thing that ships. What ships
 * is `.next/standalone/server.js`, and it wants two directories beside it that
 * the build deliberately does not put there:
 *
 *   .next/standalone/.next/static   the hashed chunks and stylesheets
 *   .next/standalone/public         fonts, icons, uploads
 *
 * The Dockerfile copies both in. Locally they are symlinked, because a rebuild
 * replaces `.next/` wholesale and a copy would silently go stale — which is
 * worse than it sounds: an empty `public/` and a missing `static/` do not
 * fail. The server answers every page request with 200 and correct markup and
 * 404s every stylesheet, script and font, so the page renders unstyled and
 * every measurement taken against it is a measurement of a page nobody will
 * ever see. That happened, which is why the self-check at the bottom is not
 * optional and not quiet.
 *
 *   pnpm serve:standalone
 *
 * Reads `.env.local` for `DATABASE_URL` and fills in the production posture the
 * app refuses to start without — a real `SESSION_SECRET`, `COOKIE_SECURE`, and
 * an `https://` `SITE_URL`. It prints which of those it supplied and never
 * prints their values.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STANDALONE = join(ROOT, '.next/standalone')
const SERVER = join(STANDALONE, 'server.js')

const PORT = Number(process.env.PORT ?? 3200)
const HOSTNAME = process.env.HOSTNAME ?? '127.0.0.1'
const ORIGIN = `http://${HOSTNAME}:${PORT}`

if (!existsSync(SERVER)) {
  console.error(`✗ no standalone build at ${SERVER}`)
  console.error('  run `pnpm build` first — it is what produces this file.')
  process.exit(1)
}

/**
 * What the caller set, before `.env.local` gets a say.
 *
 * `.env.local` is a development file: its `SESSION_SECRET` is the placeholder
 * the app refuses to boot on in production, and `SITE_URL` is `http://`. Those
 * are exactly the two values this script exists to fill in, so an `??` against
 * `process.env` after loading the file would read the placeholder as though
 * someone had chosen it — the app would then refuse to start, and the error
 * would point at a setting the operator did set. Snapshotting first is what
 * separates "the environment asked for this" from "the file happened to
 * contain it".
 */
const suppliedByCaller = { ...process.env }

/*
 * Read here rather than in the server because the standalone entry point calls
 * `process.chdir(__dirname)` before the app loads, so a relative `./content`
 * resolves under `.next/standalone` and `.env.local` is never found.
 */
const envFile = join(ROOT, '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

/** A value the caller set in the environment, if they set one. */
const chose = (key: string): string | undefined => suppliedByCaller[key]

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set (expected in the environment or .env.local)')
  process.exit(1)
}

/**
 * Point the build output at the real assets, replacing whatever is there.
 *
 * Replacing is safe without a second thought because `destination` is always
 * inside `.next/standalone`, which is build output: a rebuild deletes it, and
 * nothing that lives there is anyone's data. It is *not* safe to assume that
 * silently, though. A build does put some of `public/` here — the traced files,
 * like the CJK subset font a route imports — so the directory arrives
 * non-empty, and "delete it and link" would be a line that quietly removes
 * files the build put there. Listing what goes is what keeps that honest.
 */
function link(target: string, destination: string, label: string): void {
  if (existsSync(destination)) {
    const existing = lstatSync(destination)
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      const entries = readdirSync(destination)
      if (entries.length > 0) {
        console.log(`· ${label}: replacing ${entries.length} file(s) the build left here`)
      }
    }
    rmSync(destination, { recursive: true, force: true })
  }

  const source = join(ROOT, target)
  if (!existsSync(source)) {
    console.error(`✗ ${label}: nothing to link from ${source}`)
    process.exit(1)
  }

  symlinkSync(source, destination, 'dir')
  console.log(`· ${label}: ${destination} -> ${source}`)
}

link('.next/static', join(STANDALONE, '.next/static'), 'chunks and stylesheets')
link('public', join(STANDALONE, 'public'), 'static files')

/*
 * `assertProductionPosture` refuses to boot on the development defaults, which
 * is the right behaviour and the reason these are filled in here rather than
 * left to whoever runs it. The secret is per-run: this server is for measuring,
 * and a session it issues need not outlive it.
 */
const generated = {
  // An absolute CONTENT_DIR, because the server chdirs before it reads this.
  CONTENT_DIR: join(ROOT, 'content'),
  UPLOAD_DIR: join(ROOT, 'public/uploads'),
  SESSION_SECRET: randomBytes(48).toString('base64'),
  COOKIE_SECURE: '1',
  SITE_URL: `https://localhost:${PORT}`,
  TRUSTED_ORIGINS: `localhost:${PORT}`,
}

const overrides: Record<string, string> = {}
for (const [key, fallback] of Object.entries(generated)) {
  const chosen = chose(key)
  if (chosen !== undefined) overrides[key] = chosen
  else overrides[key] = fallback
}

const child = spawn(process.execPath, [SERVER], {
  cwd: STANDALONE,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME,
    PORT: String(PORT),
    DATABASE_URL,
    ...overrides,
  },
})

console.log('· DATABASE_URL: present (not printed)')
for (const key of Object.keys(generated)) {
  console.log(`· ${key}: ${chose(key) === undefined ? 'set for this run' : 'from the environment'}`)
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})

/*
 * The check that makes the rest of this trustworthy.
 *
 * An unstyled page is indistinguishable from a styled one if all you look at
 * is the status code, so ask for the assets the page itself names and insist
 * on a 200 for each. If this fails the server is still running and still
 * useful — it is a warning, not a shutdown — but no measurement taken against
 * it means anything, which the message says outright.
 */
async function selfCheck(): Promise<void> {
  const deadline = Date.now() + 60_000
  let html = ''

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/`)
      if (response.ok) {
        html = await response.text()
        break
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (!html) {
    console.error(`✗ self-check: nothing answered on ${ORIGIN} within 60s`)
    return
  }

  const assets = [
    ...new Set(html.match(/\/_next\/static\/[^"'\\\s]+/g) ?? []),
  ]
  if (assets.length === 0) {
    console.error('✗ self-check: the page names no static assets at all')
    return
  }

  const broken: string[] = []
  for (const asset of assets) {
    const response = await fetch(ORIGIN + asset).catch(() => null)
    if (!response?.ok) broken.push(`${response?.status ?? 'no response'} ${asset}`)
  }

  if (broken.length > 0) {
    console.error(`\n✗ self-check: ${broken.length} of ${assets.length} assets did not serve.`)
    for (const line of broken.slice(0, 5)) console.error(`    ${line}`)
    console.error('  The page will render unstyled and unhydrated. Do not measure it.\n')
    return
  }

  console.log(`✓ self-check: ${assets.length} assets served from ${ORIGIN}`)
}

void selfCheck()
