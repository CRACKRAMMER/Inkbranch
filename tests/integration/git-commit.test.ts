import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { env } from '@/env'
import { hasTestDatabase, testContentRoot } from '../setup'

import { commitContentChange } from '@/lib/admin/git'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { siteSettings } from '@/lib/db/schema'
import { updateSettings } from '@/lib/settings'

/**
 * The admin half of git auto-commit, composed.
 *
 * The unit tests hold the message rules, the decision table and what git does
 * when it runs. What none of them can show is that the two halves meet: that the
 * settings row a deployment actually has is what drives the decision, and that a
 * site which has asked for commits gets an answer — either a commit or a reason
 * — rather than silence.
 *
 * The reason this matters more than it looks: the failure mode of this feature
 * is not a bad commit, it is a switch that does nothing. So the assertion with
 * teeth here is the one that says a site with the settings on always gets a
 * non-null outcome, whichever way this deployment is configured.
 *
 * Nothing is committed by this file. `GIT_INTEGRATION_ENABLED` is `0` in every
 * test environment, and the one call that does reach git finds a content root
 * that is not a repository.
 */
describe.skipIf(!hasTestDatabase)('git auto-commit, from the admin side', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  const clear = () => db.delete(siteSettings).where(eq(siteSettings.id, 'default'))

  afterEach(clear)

  const change = {
    action: 'update' as const,
    title: 'Linux Network Debugging',
    paths: ['posts/linux-network-debugging.md'],
  }

  /** No `.git` anywhere under the content root, whatever else has happened. */
  function repositoryExists(): boolean {
    return fs.existsSync(path.join(testContentRoot, '.git'))
  }

  it('returns nothing at all for a site that has not asked for commits', async () => {
    await clear()
    expect(await commitContentChange(change)).toBeNull()
    expect(repositoryExists()).toBe(false)
  })

  it('returns nothing when the switches disagree', async () => {
    await clear()
    await updateSettings({ gitEnabled: true, gitAutoCommit: false })
    expect(await commitContentChange(change)).toBeNull()

    await updateSettings({ gitEnabled: false, gitAutoCommit: true })
    expect(await commitContentChange(change)).toBeNull()

    expect(repositoryExists()).toBe(false)
  })

  it('answers when both settings are on, whichever way the deployment is set', async () => {
    await clear()
    await updateSettings({ gitEnabled: true, gitAutoCommit: true })

    const outcome = await commitContentChange(change)

    // Never null: a site that has asked for commits is told what happened.
    expect(outcome).not.toBeNull()

    if (env.GIT_INTEGRATION_ENABLED) {
      // This deployment permits commits, so the attempt is real. The content
      // root is not a repository, and the outcome says exactly that.
      expect(outcome?.reason).toBe('not-a-repository')
    } else {
      // The ordinary test configuration: the second switch is off, and the note
      // names it rather than leaving the operator with a switch that does
      // nothing.
      expect(outcome?.status).toBe('skipped')
      expect(outcome?.reason).toBe('deployment-disabled')
    }
  })
})
