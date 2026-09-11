import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/* -------------------------------------------------------------------------- */
/*  Database selection, before anything else can read it                       */
/* -------------------------------------------------------------------------- */

/**
 * Point the run at the test database, and at nothing else.
 *
 * `process.loadEnvFile` does not overwrite variables that are already set, so
 * the shell wins over `.env.local` — which is what makes `TEST_DATABASE_URL=…
 * pnpm test:integration` work in CI. It does mean `.env.local` must be loaded
 * here, because vitest is not Next and nothing else will load it.
 *
 * This assignment is not a convenience. `tests/setup.ts` uses `??=`, so a
 * `DATABASE_URL` from `.env.local` — the *development* database — would survive
 * into the test process and every integration test that forgot its skip guard
 * would run against real data. The line below is the only thing standing
 * between this suite and that, so it sets the value unconditionally: when no
 * test database is configured it falls back to the same unreachable address
 * `tests/setup.ts` uses, and the suites skip.
 */
const envFile = path.join(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:1/unused'

/**
 * Integration tests: real files, a real database, run one file at a time.
 *
 * They are split from the unit suite for a specific reason rather than for
 * tidiness. Every test file gets its own `CONTENT_DIR`, but they all share one
 * database — and `syncContent` reconciles `content_index` against *its* content
 * root, deleting any row whose file it cannot see. Two of these suites running
 * at once would therefore delete each other's fixtures mid-test, and the
 * failures would look like flaky assertions in whichever file lost the race.
 *
 * `fileParallelism: false` removes the race by removing the concurrency, which
 * is the only honest fix: the shared-database assumption is real (one database
 * belongs to one content root) and weakening it to make tests faster would
 * weaken the production invariant with it.
 *
 * Requires `TEST_DATABASE_URL`. Without it every suite here skips rather than
 * failing, so a checkout with no database still runs a green unit suite.
 *
 * ## Why the unit directory is included
 *
 * Eight files under `tests/unit/` hold a database-backed section beside their
 * pure tests — the redirect lookup, settings, jobs, revisions, analytics,
 * navigation, assets and the graph — and each one skips itself when
 * `TEST_DATABASE_URL` is unset. That is right for `pnpm test`, which promises
 * to need no database. The problem was the other end: `pnpm test:integration`
 * included only `tests/integration/**`, so those sections ran in neither suite
 * and seventy-nine tests were being skipped twice.
 *
 * They are included here because the split that matters is not unit versus
 * integration, it is *needs a database* versus *does not*. The pure tests in
 * that directory run again under this config, which costs seconds and is the
 * price of not having to remember which of the eight files is which.
 */

const serverOnlyNoop = path.join(
  path.dirname(createRequire(import.meta.url).resolve('server-only')),
  'empty.js',
)

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': serverOnlyNoop,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/integration/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'tests/e2e'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
  },
})
