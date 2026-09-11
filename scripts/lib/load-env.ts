import fs from 'node:fs'
import path from 'node:path'

/**
 * Load `.env.local` then `.env` into `process.env` for the CLI scripts.
 *
 * The application proper does not need this: `next dev` and `next start` load
 * these files themselves. A script run through `tsx` does not, so every entry
 * point under `scripts/` calls this **before** importing anything that reads
 * `@/env` — `src/env.ts` parses `process.env` at module load and throws on a
 * missing `DATABASE_URL`, so an import that runs first would fail the process
 * before the first line of the script could execute.
 *
 * Order matters and is load-bearing. `process.loadEnvFile` does not overwrite
 * variables that are already set, so loading `.env.local` first gives it
 * precedence over `.env` — which is the same rule Next.js applies, so a value
 * seen by `pnpm db:migrate` is the value the app will use. Loading them the
 * other way round silently inverts that and is the kind of bug that only shows
 * up in a deployment where the two files disagree.
 *
 * Not implemented, deliberately: `${VAR}` expansion and the `.env.development`
 * / `.env.production` variants. Both are Next-specific conveniences, and a
 * script that behaves subtly differently from the app because it expanded a
 * value the app did not is worse than one that has no opinion.
 */
export function loadEnvFiles(): string[] {
  const loaded: string[] = []

  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file)
    if (!fs.existsSync(full)) continue

    process.loadEnvFile(full)
    loaded.push(file)
  }

  return loaded
}
