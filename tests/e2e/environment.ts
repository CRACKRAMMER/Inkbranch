import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The environment an end-to-end run uses, defined once.
 *
 * ## Why this is a separate module
 *
 * `playwright.config.ts` is evaluated *before* `globalSetup` runs, and the
 * config is what declares the server command and the environment that command
 * gets. So the setup cannot create a temporary tree and hand the path to the
 * config — by the time it could, the config has already been read. Both sides
 * therefore import the paths from here, and the setup is what *materialises*
 * them.
 *
 * That forces the paths to be deterministic rather than freshly `mkdtemp`'d.
 * They are wiped and recreated at the start of each run, which is what makes the
 * run idempotent: a suite that creates a post and deletes it leaves nothing
 * behind if it passes, and nothing that matters if it fails.
 */

/** Everything the run owns. Removed and recreated at the start of every run. */
export const E2E_ROOT = path.join(os.tmpdir(), 'myblog-e2e')

/**
 * The Markdown tree the server under test reads and writes.
 *
 * Deliberately not the repository's `content/`. This suite creates documents and
 * then **deletes** them — the delete is one of the flows being tested — so
 * pointing it at `./content` would mean a test run operating on whatever the
 * author happens to be working on. The integration suite has the same reasoning
 * behind its temp root; here it is not merely hygiene but the difference between
 * a test and a data-loss tool.
 */
export const E2E_CONTENT_DIR = path.join(E2E_ROOT, 'content')

/** The same treatment for uploads, which would otherwise land in `public/uploads`. */
export const E2E_UPLOAD_DIR = path.join(E2E_ROOT, 'uploads')

/**
 * Credentials for the account the suite signs in as.
 *
 * Fixed rather than generated, so a failing run can be reproduced by hand
 * against the same database state. `.test` is reserved by RFC 2606 and can
 * never resolve, which keeps the address from ever being a real one.
 */
export const E2E_ADMIN_EMAIL = 'e2e@example.test'
export const E2E_ADMIN_NAME = 'E2E Author'
export const E2E_ADMIN_PASSWORD = 'e2e-password-not-for-any-real-site'

/**
 * The database the run owns.
 *
 * A third database, alongside the development one and `TEST_DATABASE_URL`. The
 * integration suite asserts on the contents of its database and the E2E run
 * empties and repopulates its own; sharing one would make each suite fail
 * depending on whether the other had run. Neither failure would point at the
 * real cause.
 */
const E2E_DATABASE_NAME = 'myblog_e2e'

/** Load `.env.local` then `.env` into the process, without overriding what is set. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file)
    if (!fs.existsSync(full)) continue
    // Does not overwrite variables that are already set, which is the same
    // precedence Next.js applies — so a value seen here is the value the app
    // would see.
    process.loadEnvFile(full)
  }
}

loadEnvFiles()

/**
 * The URL the suite's database lives at, derived from `TEST_DATABASE_URL`.
 *
 * Deriving rather than taking a second variable means a developer who has
 * configured a test database has configured the E2E one: same server, same
 * credentials, different database name. When `TEST_DATABASE_URL` is absent the
 * E2E suite cannot run, and says so — see `hasE2eDatabase`.
 */
export function e2eDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL is not set, so the E2E suite has no Postgres to run against. ' +
        'Set it in .env.local to the same server as DATABASE_URL but a different database name.',
    )
  }
  const url = new URL(base)
  url.pathname = `/${E2E_DATABASE_NAME}`
  return url.toString()
}

/** True when the suite has a database to run against. */
export const hasE2eDatabase = Boolean(process.env.TEST_DATABASE_URL)

/** Where the server listens. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100)
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`

/**
 * The environment the server under test is started with.
 *
 * Spread over `process.env` rather than replacing it, so the process still has
 * `PATH` and whatever the developer exported. The values below are the ones that
 * *must* differ from a development run: without them the server would read the
 * real `content/`, write to the real `public/uploads`, and talk to the
 * development database — which is exactly the accident the whole file exists to
 * prevent, and it would look like a working test run.
 *
 * ## Why this is configured as a production deployment
 *
 * `next start` forces `NODE_ENV=production`, and the application refuses to run
 * in production on an insecure configuration — `assertProductionPosture` in
 * `src/env.ts` throws on a non-`Secure` cookie and on an `http://` site URL.
 * That check is correct and this suite is not a reason to weaken it: testing a
 * server configured *less* strictly than a real one would leave the strict path
 * untested.
 *
 * So the server is configured the way a deployment is, and it works because
 * `127.0.0.1` is a secure context: Chromium accepts a `Secure` cookie from it
 * over plain HTTP. The alternative — setting `COOKIE_SECURE=0` — does not start
 * the server at all.
 */
export function serverEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DATABASE_URL: e2eDatabaseUrl(),
    CONTENT_DIR: E2E_CONTENT_DIR,
    UPLOAD_DIR: E2E_UPLOAD_DIR,
    SESSION_SECRET: 'e2e-only-session-secret-not-for-any-real-deployment-00',
    COOKIE_SECURE: '1',
    SITE_URL: `https://127.0.0.1:${E2E_PORT}`,
    TRUSTED_ORIGINS: `127.0.0.1:${E2E_PORT},localhost:${E2E_PORT}`,
    ANALYTICS_ENABLED: '0',
    CONTENT_SYNC_ON_BOOT: '1',
  }
}
