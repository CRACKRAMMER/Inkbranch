import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `server-only` is a marker that throws the moment it is loaded anywhere other
 * than a React Server Components graph — which is every vitest run, so a test
 * could not import a server-only module at all. Vitest gets the package's own
 * no-op entry instead, which keeps the marker doing its job in the Next build
 * (a client component that imports one of these modules still fails to build)
 * without making the module untestable.
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
    // Unit tests only. Integration tests share one database and some of them
    // reconcile it wholesale, so they run through
    // `vitest.integration.config.ts` one file at a time — see that file for
    // why running them here would make them delete each other's fixtures.
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'tests/e2e'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
  },
})
