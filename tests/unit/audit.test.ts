import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AuditQueryError,
  isSecretKey,
  listAuditLogs,
  recordAudit,
  redactAuditMetadata,
  type AuditAction,
} from '@/lib/audit'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { auditLogs } from '@/lib/db/schema'
import { hasTestDatabase } from '../setup'

/**
 * The audit log.
 *
 * ## What this file is for
 *
 * The write path is already covered where it happens: the settings, navigation
 * and redirects suites assert that a row lands with the right action and target.
 * What none of them touch is the part between the caller's `metadata` and the
 * stored `meta` — the redaction walk — and that is the one piece of this module
 * that is a security control rather than bookkeeping. It is also the piece the
 * module says out loud is meant to be tested here:
 *
 *   > Exported so a caller can assert on what will be written — and so the rule
 *   > is testable without a database.
 *
 * The admin's own System page repeats the promise to the operator in as many
 * words ("Credentials are replaced with `[redacted]` before a row is written").
 * A promise made to the person reading the log, on a table that outlives the
 * request, with nothing checking it, is the shape this file exists to close.
 *
 * ## What is checked, and what is not
 *
 * The redaction rules — which key names count as credentials, what happens to a
 * value that JSON cannot hold, and where the walk stops — and the two invariants
 * about the vocabulary that until now only held because someone had read the
 * call sites by hand: that every declared action is recorded somewhere, and that
 * `audit_logs` has exactly one writer.
 *
 * Not checked: which actions *should* exist. That is a judgement about the
 * product, and the module is explicit that adding one is a deliberate edit to
 * the union rather than something a test should decide.
 *
 * ## Why the vocabulary tests read the source
 *
 * `AUDIT_ACTIONS` is a closed union and TypeScript already stops a call site
 * from passing a value that is not in it. The direction TypeScript cannot catch
 * is the other one: an action that stays declared after its last call site is
 * deleted, or one added in advance of the code that records it. Both leave a
 * member that nothing writes, and the module's own reason for the union is that
 * such a row is one "no query and no UI ever looks for again". Nothing in the
 * running program can see that, so the source is read, which is also the only
 * way to see that the single-writer rule has not quietly grown a second door.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const files = sourceFiles(SRC).map((file) => ({
  path: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}))

describe('isSecretKey', () => {
  /*
   * Whole words, not substrings. The distinction is the whole reason this
   * function splits camelCase and snake_case before looking: a substring match
   * on "auth" would redact `authorId`, and — the failure that matters more —
   * would look like it was working.
   */
  it.each([
    'password',
    'passwordHash',
    'password_hash',
    'passwd',
    'pass',
    'pwd',
    'secret',
    'token',
    'csrfToken',
    'sessionToken',
    'session_count',
    'authorization',
    'cookie',
    'credential',
    'credentials',
    'x-csrf-token',
  ])('treats %s as a credential', (key) => {
    expect(isSecretKey(key)).toBe(true)
  })

  it.each([
    // The module's own example: "auth" is inside it and is not the word.
    'authorId',
    'author',
    'key',
    'keyword',
    'monkey',
    'targetKey',
    'contentType',
    'ipHash',
    'slug',
    'status',
  ])('leaves %s alone', (key) => {
    expect(isSecretKey(key)).toBe(false)
  })

  it('needs a qualifier before it will call a key a credential', () => {
    // `targetKey` names a document and `apiKey` is a bearer token, so the rule
    // is that `key` counts only next to a word that makes it one.
    expect(isSecretKey('apiKey')).toBe(true)
    expect(isSecretKey('api_key')).toBe(true)
    expect(isSecretKey('privateKey')).toBe(true)
    expect(isSecretKey('accessKey')).toBe(true)
    expect(isSecretKey('signingKey')).toBe(true)
    expect(isSecretKey('secretKey')).toBe(true)
    expect(isSecretKey('targetKey')).toBe(false)
    expect(isSecretKey('foreignKey')).toBe(false)
  })
})

describe('redactAuditMetadata', () => {
  it('replaces a credential with a marker rather than dropping the key', () => {
    // The marker is the point: a reader should be able to tell that a field was
    // there and was withheld, instead of wondering whether it was ever recorded.
    expect(redactAuditMetadata({ password: 'hunter2' })).toEqual({
      password: '[redacted]',
    })
  })

  it('walks nested objects and arrays', () => {
    expect(
      redactAuditMetadata({
        before: { name: 'Old', sessionToken: 'abc' },
        changes: [{ field: 'title', token: 'xyz' }, { field: 'slug' }],
      }),
    ).toEqual({
      before: { name: 'Old', sessionToken: '[redacted]' },
      changes: [{ field: 'title', token: '[redacted]' }, { field: 'slug' }],
    })
  })

  it('leaves ordinary audit fields exactly as they were', () => {
    // The metadata a call site actually passes, so that a rule which is too
    // eager to redact shows up here rather than in a log nobody can read.
    const metadata = {
      type: 'post',
      slug: 'atomic-writes',
      path: 'content/posts/atomic-writes.md',
      previousStatus: 'draft',
      status: 'published',
      wordCount: 1200,
      via: 'tag.rename',
      tag: 'database',
      to: 'databases',
      keys: ['siteName'],
    }

    expect(redactAuditMetadata(metadata)).toEqual(metadata)
  })

  it('does not write into the object it was given', () => {
    // A caller keeps its own object after recording, and edits it again on the
    // next save. Redaction belongs to the row, not to the caller's data.
    const metadata = { password: 'hunter2', nested: { token: 'abc' } }

    redactAuditMetadata(metadata)

    expect(metadata).toEqual({ password: 'hunter2', nested: { token: 'abc' } })
  })

  it('returns something JSON can hold, whatever it was given', () => {
    /*
     * `JSON.stringify` throws on a bigint, and the column is jsonb — so a value
     * the walk passes through unchanged is a thrown error at the insert, which
     * `recordAudit` catches and drops. The row is then simply lost, taking with
     * it the record of whatever the admin did. This test is that sentence made
     * executable: every one of these inputs is a real thing a call site could
     * hand over (a byte count as a bigint, a duration that came out NaN, a
     * Date straight off a row).
     */
    const result = redactAuditMetadata({
      big: 10n,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      when: new Date('2026-01-02T03:04:05.000Z'),
      missing: undefined,
      fn: () => 'nope',
      sym: Symbol('nope'),
      list: [1, undefined, 3n],
    })

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(result).toEqual({
      big: '10',
      nan: null,
      infinite: null,
      when: '2026-01-02T03:04:05.000Z',
      list: [1, null, '3'],
    })
    // Dropped rather than nulled, because a function is not a value that was
    // there and read as absent — there is nothing to tell the reader about.
    expect('missing' in result).toBe(false)
    expect('fn' in result).toBe(false)
    expect('sym' in result).toBe(false)
  })

  it('stops walking before the stack does', () => {
    // The depth ceiling exists for the cyclic case, which is not hypothetical:
    // `recordAudit` is handed metadata assembled from rows and request context.
    const cyclic: Record<string, unknown> = { title: 'loop' }
    cyclic.self = cyclic

    const result = redactAuditMetadata(cyclic)

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(JSON.stringify(result)).toContain('[truncated]')
  })

  it('carries a secret no further than the ceiling, and no further than the marker', () => {
    // Nesting past the ceiling must truncate the branch rather than let it
    // through: a walk that stopped with the value already copied would leak the
    // one thing it exists to withhold.
    let deep: Record<string, unknown> = { password: 'hunter2' }
    for (let level = 0; level < 12; level += 1) deep = { level: deep }

    const result = redactAuditMetadata(deep)
    const serialised = JSON.stringify(result)

    expect(serialised).not.toContain('hunter2')
    expect(serialised).toContain('[truncated]')
  })

  it('leaves a shallow object untruncated', () => {
    // Guards the test above: if the ceiling were applied at depth 1, truncating
    // everything, that assertion would still pass while proving nothing.
    const shallow = redactAuditMetadata({ a: { b: { c: { d: 'value' } } } })

    expect(JSON.stringify(shallow)).not.toContain('[truncated]')
    expect(JSON.stringify(shallow)).toContain('value')
  })
})

describe('the vocabulary', () => {
  it('declares each action once', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length)
  })

  it('keeps every action a dotted lowercase name', () => {
    // Not decoration: these values go into a grep, a filter dropdown and a URL
    // query parameter, so a stray capital or a bare word is a value that cannot
    // be found again by the means the log is meant to be read with.
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z]+(\.[a-z_]+)+$/)
    }
  })

  it('records every action it declares', () => {
    /*
     * The direction TypeScript cannot enforce. `lib/audit.ts` is excluded
     * because the declaration is itself a list of these literals — without the
     * exclusion this assertion would pass by finding the union it is checking.
     *
     * The check is deliberately an over-approximation: a literal anywhere in
     * `src/` counts, whether it reached its call site directly, through a
     * ternary, or as a value in a `Record<..., AuditAction>` map, which are all
     * forms the code already uses. That bias can only ever produce a false pass,
     * never a false failure, which is the right way round for a test whose job
     * is to notice a member nothing writes.
     */
    const callers = files.filter((file) => file.path !== 'lib/audit.ts')

    const neverRecorded = AUDIT_ACTIONS.filter(
      (action) => !callers.some((file) => file.text.includes(`'${action}'`)),
    )

    expect(neverRecorded).toEqual([])
  })

  it('is reasoning about a source tree it actually found', () => {
    // The guard for the tests above. A walk that returned nothing, or a path
    // that stopped resolving, would make every one of them pass vacuously.
    const callSites = files.reduce(
      (total, file) => total + (file.text.match(/recordAudit\(\{/g)?.length ?? 0),
      0,
    )

    // A floor rather than the exact count: adding an audit call is ordinary
    // work, and a test that fails on it would be a test people delete.
    expect(callSites).toBeGreaterThanOrEqual(20)
    expect(files.length).toBeGreaterThan(100)
  })

  it('writes through one door', () => {
    // "Every path into `audit_logs.meta` goes through here; there is no second
    // door." A second `insert(auditLogs)` anywhere else would bypass the
    // redaction and the schema both, so the claim is checked rather than trusted.
    const writers = files.filter((file) => file.text.includes('.insert(auditLogs)'))

    expect(writers.map((file) => file.path)).toEqual(['lib/audit.ts'])
  })
})

describe('recordAudit', () => {
  it('resolves rather than throwing when the entry is not valid', async () => {
    /*
     * The module's central contract: an audit write must never fail the action
     * it was recording. The failure is reported on the server log instead — so
     * the assertion is on both halves, the resolved promise and the log line,
     * because a version that swallowed the entry silently would satisfy only
     * the first.
     */
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        recordAudit({ action: 'post.publsh' as AuditAction }),
      ).resolves.toBeUndefined()

      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses an entry whose actor is not a uuid, without throwing', async () => {
    // The other half of the same contract, on a field rather than on the
    // action: an actor that is not a `users.id` would be an insert error, and
    // the entry is turned away before it reaches the database for it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        recordAudit({ action: 'post.update', actorId: 'not-a-uuid' }),
      ).resolves.toBeUndefined()

      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('listAuditLogs', () => {
  it('refuses a page size the query cannot honour', async () => {
    // Throwing is the contract here, unlike the write path: a caller asking for
    // a page size of zero or a non-integer is a programming error, and the
    // alternative is a page that silently shows something other than what was
    // asked for. It throws before the database is touched.
    await expect(listAuditLogs({ limit: 0 })).rejects.toBeInstanceOf(AuditQueryError)
    await expect(listAuditLogs({ limit: 201 })).rejects.toBeInstanceOf(AuditQueryError)
    await expect(listAuditLogs({ limit: 1.5 })).rejects.toBeInstanceOf(AuditQueryError)
    await expect(listAuditLogs({ offset: -1 })).rejects.toBeInstanceOf(AuditQueryError)
  })

  it('refuses an action outside the vocabulary', async () => {
    await expect(
      listAuditLogs({ action: 'post.publsh' as AuditAction }),
    ).rejects.toMatchObject({ code: 'AUDIT_QUERY', name: 'AuditQueryError' })
  })
})

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('audit storage', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  /** A row is identified by this, so another suite's rows cannot be mistaken for it. */
  const marker = () => `audit-test-${crypto.randomUUID()}`

  it('stores a credential as a marker, not as the credential', async () => {
    // The end-to-end version of the promise the System page makes to whoever is
    // reading the log. The unit tests above prove the walk is right; this one
    // proves the walk is on the path the value actually travels.
    const targetId = marker()

    await recordAudit({
      action: 'settings.update',
      targetType: 'test',
      targetId,
      metadata: {
        password: 'hunter2',
        sessionToken: 'abc',
        targetKey: 'posts/hello',
        authorId: 'author-1',
      },
    })

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, targetId))

    expect(row?.meta).toEqual({
      password: '[redacted]',
      sessionToken: '[redacted]',
      targetKey: 'posts/hello',
      authorId: 'author-1',
    })
  })

  it('records a denied outcome as denied', async () => {
    const targetId = marker()

    await recordAudit({
      action: 'post.delete',
      outcome: 'denied',
      targetType: 'test',
      targetId,
    })

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, targetId))

    expect(row?.outcome).toBe('denied')
    expect(AUDIT_OUTCOMES).toContain('denied')
  })

  it('defaults to an ok outcome when the caller says nothing', async () => {
    const targetId = marker()

    await recordAudit({ action: 'post.update', targetType: 'test', targetId })

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, targetId))

    expect(row?.outcome).toBe('ok')
  })

  it('survives a write the database refuses, and writes nothing', async () => {
    /*
     * The never-throw contract under a real failure rather than a validation
     * one: `user_id` is a foreign key, so an actor that does not exist is a
     * genuine insert error. An action must still not fail because of it — the
     * admin did the thing, and the audit row is the thing that is missing.
     */
    const absent = crypto.randomUUID()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        recordAudit({ action: 'post.update', actorId: absent }),
      ).resolves.toBeUndefined()

      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.userId, absent))
    expect(rows).toEqual([])
  })

  it('pages the log newest first and counts what the filters match', async () => {
    const targetId = marker()
    await recordAudit({ action: 'settings.update', targetType: 'test', targetId })

    const page = await listAuditLogs({ action: 'settings.update', limit: 200 })

    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows.filter((row) => row.action !== 'settings.update')).toEqual([])
    expect(page.rows.some((row) => row.targetId === targetId)).toBe(true)
    // The total counts the filter, not the page.
    expect(page.total).toBeGreaterThanOrEqual(page.rows.length)

    const outOfOrder = page.rows
      .slice(1)
      .filter((row, index) => row.createdAt > page.rows[index]!.createdAt)
    expect(outOfOrder).toEqual([])
  })

  it('returns nothing, and still a count, for a window nothing falls in', async () => {
    // Deterministic by construction: a lower bound in the future cannot match a
    // row, whatever else is running against this table.
    const future = new Date(Date.now() + 60_000)
    const after = await listAuditLogs({ from: future })
    expect(after.rows).toEqual([])
    expect(after.total).toBe(0)

    const past = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000)
    const before = await listAuditLogs({ to: past })
    expect(before.rows).toEqual([])
    expect(before.total).toBe(0)

    const nobody = await listAuditLogs({ actorId: crypto.randomUUID() })
    expect(nobody.rows).toEqual([])
    expect(nobody.total).toBe(0)
  })

  it('returns an empty page past the end without claiming the log is empty', async () => {
    /*
     * The count is what distinguishes "nothing has been recorded" from "you are
     * past the last page" — a caller reading only `rows` cannot tell those
     * apart, which is why the total counts the whole filter rather than the
     * page. `/admin/system` reads it that way, and says which of the two it is.
     */
    const beyond = await listAuditLogs({ offset: 1_000_000, limit: 1 })

    expect(beyond.rows).toEqual([])
    expect(beyond.total).toBeGreaterThan(0)
  })
})
