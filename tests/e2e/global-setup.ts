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
  maintenanceDatabaseUrl,
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

/** Drop and recreate the E2E database, so a run never inherits an earlier one. */
async function resetDatabase(url: string): Promise<void> {
  const database = new URL(url).pathname.replace(/^\//, '')
  const client = new Client({ connectionString: maintenanceDatabaseUrl() })
  await client.connect()
  try {
    // `WITH (FORCE)` disconnects anything still attached — a server left running
    // by a previous interrupted run holds a connection, and without this the
    // drop fails and the whole suite refuses to start for an unrelated reason.
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${database}"`)
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
