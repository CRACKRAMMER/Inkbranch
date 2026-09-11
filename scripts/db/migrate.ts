import process from 'node:process'

import { loadEnvFiles } from '../lib/load-env'

/**
 * Apply pending migrations. Used by `pnpm db:migrate` and by the container
 * entrypoint, so a fresh deployment comes up with a schema and no manual step.
 *
 * Every import that reads the environment is dynamic, and that is not a style
 * choice. ES module imports are hoisted and evaluated before any statement in
 * this file runs, so a static `import { env } from '@/env'` would parse
 * `process.env` — and throw on a missing `DATABASE_URL` — before
 * `loadEnvFiles()` on the next line could supply it. The rule is: load the
 * environment first, then import anything that needs it.
 */
const loaded = loadEnvFiles()

const { env } = await import('@/env')
const { runMigrations } = await import('@/lib/db/migrate')

if (loaded.length > 0) {
  console.log(`Loaded environment from ${loaded.join(', ')}`)
}

try {
  // The URL comes from the validated env rather than straight off
  // `process.env`, so a malformed one fails here with the same message the app
  // would give rather than as a connection error from the driver.
  const result = await runMigrations(env.DATABASE_URL)

  console.log(
    result.applied === 0
      ? `Schema is up to date (${result.durationMs}ms).`
      : `Applied ${result.applied} migration${result.applied === 1 ? '' : 's'} in ${result.durationMs}ms.`,
  )
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
