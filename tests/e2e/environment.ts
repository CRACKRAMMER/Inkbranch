import { execFileSync } from 'node:child_process'
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

/**
 * True when this machine has git.
 *
 * `tests/e2e/git.spec.ts` is the only file that needs it, and it needs it in
 * two places: in the server process, which runs the commit, and in the test
 * process, which reads the log back. Both are this machine, so one look suffices
 * — and a machine without git gets that spec skipped rather than a setup that
 * throws before any test can report why.
 */
export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

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
 *
 * ## Why the embedded worker is switched off
 *
 * `WORKER_ENABLED=0` turns off the loop the server starts for itself, and it is
 * off here for a reason that is about this suite rather than about the worker:
 * **the server under test starts before the database it will use exists.**
 * `globalSetup` creates the database, so a loop that starts with the server
 * either fails to connect or — on a re-run, when the database is still there
 * from last time — connects to the schema that `globalSetup` is about to drop,
 * writes job rows into it, and has them deleted underneath it. Either way the
 * result is a worker whose behaviour depends on how fast the setup ran, which is
 * not something a test can assert on.
 *
 * The worker is tested where the database exists before the process does:
 * `tests/unit/jobs.test.ts` starts one against the integration database and
 * watches the cadence write rows. What is given up here is one line —
 * `src/instrumentation.ts` calling `startEmbeddedWorker()` behind the flag —
 * which has no branch of its own to get wrong.
 *
 * `CONTENT_SYNC_ON_BOOT` stays on because it is the *read* path that needs it:
 * it is what makes the first request to a freshly seeded index correct, and it
 * is exercised by every test that looks at a public page.
 *
 * ## Why collection is switched on
 *
 * The opposite call, and for the opposite reason. `ANALYTICS_ENABLED=0` would
 * stop the layout from rendering the beacon at all, so a suite run with it off
 * asserts nothing about the one part of analytics that only a browser can test:
 * that a real reader's page view is reported, once, when they leave. `tests/e2e/analytics.spec.ts`
 * is what this flag is on for, and it is the only file that depends on it.
 *
 * It is safe to leave on for the rest of the suite because the two halves are
 * independent: a beacon that is *dropped* writes no row and sets no cookie, and
 * — as `analytics.spec.ts` explains at length — every beacon this suite's
 * browser sends is dropped, because the server is configured `https://` and the
 * browser speaks `http://`. Nothing else in the suite can see a difference.
 *
 * ## Why content auto-commit is *permitted* here
 *
 * `GIT_INTEGRATION_ENABLED=1` is the deployment half of a two-key switch, and on
 * its own it changes nothing at all: the site's own settings are off by default,
 * so every save takes the decision's `not-asked` branch and returns before git
 * is spawned. That is the state the whole suite is in except for one file.
 *
 * `tests/e2e/git.spec.ts` is that file. It turns the two settings on, saves, and
 * turns them off again — including when it fails, which is why the turn-off is
 * an `afterEach`. It needs the flag *on* rather than off because the value is
 * read from the server's environment at start-up: a run cannot test both
 * halves, and the half worth testing is the one where a commit really happens.
 * The refusal note ("auto-commit is off for this deployment") is a pure function
 * of the decision, and `tests/unit/git.test.ts` holds it.
 *
 * `global-setup.ts` makes the content tree a repository with no commits in it,
 * so every commit the spec finds was made by the server under test.
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
    WORKER_ENABLED: '0',
    ANALYTICS_ENABLED: '1',
    CONTENT_SYNC_ON_BOOT: '1',
    GIT_INTEGRATION_ENABLED: '1',
  }
}
