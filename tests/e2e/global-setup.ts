import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_NAME,
  E2E_ADMIN_PASSWORD,
  E2E_CONTENT_DIR,
  E2E_ROOT,
  E2E_UPLOAD_DIR,
  e2eDatabaseUrl,
  hasE2eDatabase,
  serverEnv,
} from './environment'

/**
 * Provision a run of the end-to-end suite.
 *
 * Four steps, and the order is the whole point: the content tree has to exist
 * before the server starts, the schema has to exist before the seed runs, and
 * the admin has to exist before a test tries to sign in.
 *
 * ## Why this runs the project's own CLI entry points
 *
 * Migrating and seeding are spawned as `tsx scripts/db/*.ts` rather than
 * imported. Two reasons, and the second is the better one.
 *
 * The mechanical reason is that those scripts are written for a process that
 * loads its own environment — they call `loadEnvFiles()` before their first
 * dynamic import, and importing them here would evaluate `src/env.ts` against
 * whatever this process happens to have. The alias resolution and the
 * `server-only` package would both have to be worked around to make that safe.
 *
 * The better reason is that it means E2E exercises the same migration path a
 * deployment uses. A suite that migrates through a private code path of its own
 * can pass while `pnpm db:migrate` is broken, which is the failure that actually
 * matters.
 */

/** Run a script through `tsx` with the given environment, inheriting stdio. */
function runScript(script: string, env: Record<string, string>): void {
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
  if (!fs.existsSync(tsx)) {
    throw new Error(`tsx is not installed at ${tsx}; run pnpm install first.`)
  }
  execFileSync(
    tsx,
    // `react-server` is the condition `server-only` uses to decide it is being
    // imported on the server. Without it an import of any server module throws.
    ['--conditions=react-server', script],
    { env, stdio: 'inherit', cwd: process.cwd() },
  )
}

/**
 * Empty the E2E database, so a run never inherits an earlier one.
 *
 * ## Why the schema is dropped and not the database
 *
 * This used to `DROP DATABASE … WITH (FORCE)` and `CREATE DATABASE`, which is
 * the obvious way to get a clean slate and is wrong here for a reason that is
 * easy to miss: **Playwright starts the web server before it runs
 * `globalSetup`**. The server under test is therefore already connected — with
 * a pool of live connections — to the very database being dropped.
 *
 * Postgres disconnects those clients when the database goes away. The server's
 * pools have to notice and rebuild themselves, and while they are doing it a
 * query can fail. Most of the time that is invisible, because the app's own
 * queries retry their way to a fresh connection before a test looks. The proxy
 * is the exception: its lookup fails open by design — a database it cannot
 * reach costs a visitor their redirect rather than turning every URL into a
 * 500 — so the failure surfaced as a redirect that had been saved correctly and
 * was not being served, on the first assertion of the test and nowhere else.
 *
 * Dropping the *schema* empties the database without changing its identity, so
 * every existing connection stays valid and nothing has to recover. The
 * destination is the same — migrations run against an empty `public` schema
 * either way — and one class of confusing, intermittent failure is gone.
 *
 * `CASCADE` because the schema is not empty: tables, types and the migration
 * journal all live there and all go together.
 */
async function resetDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

export default async function globalSetup(): Promise<void> {
  if (!hasE2eDatabase) {
    throw new Error(
      'TEST_DATABASE_URL is not set, so the E2E suite has nowhere to run. ' +
        'Add it to .env.local — same server as DATABASE_URL, and a database name that is not DATABASE_URL\'s.',
    )
  }

  // A clean tree every run. The delete flow means a previous run may have left
  // documents behind if it failed partway, and a suite whose result depends on
  // whether the last one finished is worse than no suite.
  fs.rmSync(E2E_ROOT, { recursive: true, force: true })
  fs.mkdirSync(E2E_CONTENT_DIR, { recursive: true })
  fs.mkdirSync(E2E_UPLOAD_DIR, { recursive: true })

  const env = serverEnv()

  await resetDatabase(e2eDatabaseUrl())
  runScript('scripts/db/migrate.ts', env)

  runScript('scripts/db/seed.ts', {
    ...env,
    ADMIN_EMAIL: E2E_ADMIN_EMAIL,
    ADMIN_NAME: E2E_ADMIN_NAME,
    ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
  })
}
