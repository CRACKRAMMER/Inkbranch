/**
 * Test environment defaults.
 *
 * `src/env.ts` validates the whole environment at import time and refuses to
 * load without a database URL and a session secret, so importing almost any
 * module transitively requires them. Rather than make every test file set up a
 * database, this fills in values that are *obviously* not production and leaves
 * the connection pointing at `TEST_DATABASE_URL`.
 *
 * Integration tests that actually talk to Postgres assert on
 * `TEST_DATABASE_URL` themselves and skip when it is absent, so a missing
 * database shows up as a skipped suite rather than a wall of connection errors
 * — and, more importantly, so a test run can never be pointed at the
 * development database by accident.
 *
 * Every assignment goes through one widened view of `process.env`, because
 * `@types/node` declares `NODE_ENV` readonly and the defaults below would
 * otherwise each need their own cast.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const environment = process.env as Record<string, string | undefined>

environment.NODE_ENV ??= 'test'

// Deliberately not a valid production secret: long enough to pass validation,
// and named so that a leak into a real deployment is obvious on sight.
environment.SESSION_SECRET ??= 'test-only-secret-not-for-any-real-deployment-0000'

environment.DATABASE_URL ??=
  environment.TEST_DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:1/unused'

environment.ANALYTICS_ENABLED ??= '0'
environment.WORKER_INTERVAL_MS ??= '60000'

/**
 * A throwaway content root, one per test file.
 *
 * `src/lib/content/paths.ts` resolves `CONTENT_ROOT` from `CONTENT_DIR` once at
 * import time, so this has to be set before any content module is loaded —
 * which is exactly what a setup file is for. Pointing it at a temp directory is
 * what stops the content tests from writing into the repository's real
 * `content/` tree; there is no per-call override to forget.
 */
const contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myblog-content-'))
environment.CONTENT_DIR = contentRoot
// Left at 1 so the boot-time check never fires during tests, whatever the
// suite happens to be exercising.
environment.CONTENT_SYNC_ON_BOOT ??= '0'

/**
 * The same treatment for the upload root. `src/lib/assets/storage.ts` resolves
 * `UPLOAD_ROOT` from `UPLOAD_DIR` at import time, so without this every asset
 * test would be writing into the repository's real `public/uploads` — and the
 * assertion in `tests/unit/assets.test.ts` would be the only thing standing
 * between a test run and the site's media.
 */
const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myblog-uploads-'))
environment.UPLOAD_DIR = uploadRoot

afterAll(() => {
  fs.rmSync(contentRoot, { recursive: true, force: true })
  fs.rmSync(uploadRoot, { recursive: true, force: true })
})

/** True when a real database is available for integration tests. */
export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL)

/**
 * Root the content engine is writing to for this test file.
 *
 * Deliberately without an upload twin. A content test has to *place* fixture
 * files before the engine reads them, so it needs a path it can write to — six
 * files import this one. The asset tests need no such path from here: they take
 * `UPLOAD_ROOT` from `@/lib/assets/storage`, which is the module under test's
 * own resolution of `UPLOAD_DIR` and therefore also proves the variable was read
 * as intended. An exported `testUploadRoot` used to sit here saying otherwise;
 * it was named nowhere in the repository, and was removed.
 */
export const testContentRoot = contentRoot
