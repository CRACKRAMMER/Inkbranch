import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

import { E2E_BASE_URL, E2E_PORT, hasE2eDatabase, serverEnv } from './tests/e2e/environment'

const baseURL = E2E_BASE_URL

/** The installed Next.js CLI, so the server command needs no package manager. */
const nextBin = path.join('node_modules', '.bin', 'next')

/**
 * Keep the suite's own requests away from whatever proxy the shell has set.
 *
 * Playwright's `request` fixture — an `APIRequestContext` — honours `HTTP_PROXY`
 * and friends, while the browser it launches does not. On a machine with an
 * ambient proxy that difference is invisible until it isn't: a request to
 * `http://127.0.0.1:3100/some-path` is handed to the proxy, which has never
 * heard of the server under test, and the suite records whatever it answers as
 * if the application had answered it.
 *
 * This is a guard against a hazard that was observed here rather than a fix for
 * a failure that was diagnosed to it — no test in this suite is known to have
 * failed because of it. A `curl` to `127.0.0.1:3100` in this environment went to
 * a proxy on `127.0.0.1:8888` and came back 503 while nothing was listening on
 * the port at all, which is enough to show the trap is live.
 *
 * `127.0.0.1` and `localhost` are the only hosts this suite talks to, so
 * exempting them is the whole fix. Both spellings are set because libproxy and
 * the Node toolchain do not agree on which one to read.
 */
function exemptLoopback(current: string | undefined): string {
  const hosts = new Set(
    (current ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  )
  for (const host of ['127.0.0.1', 'localhost', '::1']) hosts.add(host)
  return [...hosts].join(',')
}

// Added to whatever is already there rather than replacing it: an existing
// exemption for the developer's own services is not this file's to discard.
process.env.NO_PROXY = exemptLoopback(process.env.NO_PROXY)
process.env.no_proxy = process.env.NO_PROXY

/**
 * End-to-end configuration.
 *
 * `globalSetup` provisions a database and a content tree of its own — see
 * `tests/e2e/environment.ts` for why the suite must not run against the
 * development ones — and the server below is started with exactly that
 * environment, so the process under test and the process that provisioned it
 * agree on where everything lives.
 *
 * `workers: 1` and `fullyParallel: false` are not timidity. The suite signs in,
 * writes a document and deletes it, and a second worker doing the same thing at
 * the same time would be racing over the session cookie and the content tree.
 * One browser at a time is what makes the result mean something.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: hasE2eDatabase ? './tests/e2e/global-setup.ts' : undefined,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  // Setting `E2E_BASE_URL` points the suite at a server someone else started,
  // which is how it is run against a build that is already up. Otherwise the
  // suite builds and starts its own, with its own environment.
  //
  // Readiness is `port`, not `url`, and that is not a shortcut. Playwright runs
  // the server *before* `globalSetup`, and `globalSetup` is what creates the
  // database this server talks to — so between the server accepting connections
  // and the database existing, every page that reads the database answers 500.
  // A `url` check waits for a response it considers healthy and would wait the
  // full five minutes before giving up on a server that is working exactly as
  // designed. Waiting for the port to accept a connection is waiting for the
  // thing that is actually being waited for; whether the application is
  // answering *correctly* is what the tests are for.
  //
  // The command calls the local binaries rather than going through a package
  // manager. Nothing here needs one — `node_modules` has to be installed for
  // this file to be loaded at all — and `pnpm` specifically is not on `PATH` in
  // every environment that runs the suite, where a missing pnpm reads as a
  // failing test rather than as a missing tool.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `${nextBin} build && ${nextBin} start --port ${E2E_PORT}`,
        port: E2E_PORT,
        // An existing server may use real content or a real database.
        reuseExistingServer: false,
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: serverEnv(),
      },
})
