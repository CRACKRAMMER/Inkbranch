import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import { auditLogs, redirects } from '@/lib/db/schema'
import {
  MAX_REDIRECT_HOPS,
  deleteRedirect,
  detectRedirectLoop,
  importRedirectsFromCsv,
  isResolvableRedirectSource,
  listRedirects,
  normalizeRedirectPath,
  parseRedirectsCsv,
  readCsvRecords,
  resolveRedirect,
  saveRedirect,
  validateRedirect,
  type RedirectMap,
} from '@/lib/redirects'
import { hasTestDatabase } from '../setup'

/**
 * Redirects.
 *
 * The import and the loop check are where this can go wrong quietly: a
 * mis-parsed CSV row installs a redirect nobody asked for, and a loop is an
 * infinite redirect that no log reports as an error. Both are pure, so both run
 * everywhere. The database round-trip — one indexed lookup on the 404 path —
 * needs a database and skips without one.
 */

describe('normalizeRedirectPath', () => {
  it('drops the query string and the fragment', () => {
    expect(normalizeRedirectPath('/old?a=1')).toBe('/old')
    expect(normalizeRedirectPath('/old#section')).toBe('/old')
    expect(normalizeRedirectPath('/old/?a=1#section')).toBe('/old')
  })

  it('removes trailing slashes', () => {
    expect(normalizeRedirectPath('/old/')).toBe('/old')
    expect(normalizeRedirectPath('/old///')).toBe('/old')
  })

  it('keeps the root path', () => {
    expect(normalizeRedirectPath('/')).toBe('/')
    expect(normalizeRedirectPath('//')).toBe('/')
  })

  it('leaves case and percent-encoding alone', () => {
    // The comparison downstream is against a request path, byte for byte.
    expect(normalizeRedirectPath('/Old/Path/')).toBe('/Old/Path')
    expect(normalizeRedirectPath('/caf%C3%A9/')).toBe('/caf%C3%A9')
  })
})

describe('isResolvableRedirectSource', () => {
  it('accepts ordinary paths', () => {
    expect(isResolvableRedirectSource('/old')).toBe(true)
    expect(isResolvableRedirectSource('/')).toBe(true)
    expect(isResolvableRedirectSource('/a/b/c')).toBe(true)
  })

  it('rejects what a redirect can never be stored on', () => {
    expect(isResolvableRedirectSource('')).toBe(false)
    expect(isResolvableRedirectSource('old')).toBe(false)
    expect(isResolvableRedirectSource('//evil.example')).toBe(false)
    expect(isResolvableRedirectSource(`/${'x'.repeat(600)}`)).toBe(false)
  })

  it('rejects the prefixes that are served before the 404 handler', () => {
    expect(isResolvableRedirectSource('/_next/static/chunk.js')).toBe(false)
    expect(isResolvableRedirectSource('/api/search')).toBe(false)
    expect(isResolvableRedirectSource('/_nextish')).toBe(true)
  })

  it('rejects the admin, which is the one redirect nobody could undo', () => {
    expect(isResolvableRedirectSource('/admin')).toBe(false)
    expect(isResolvableRedirectSource('/admin/posts')).toBe(false)
    expect(isResolvableRedirectSource('/admin/login')).toBe(false)
  })

  it('does not reject a page that merely starts with the same letters', () => {
    // The admin is matched exactly or with a following slash. A bare prefix
    // test would refuse a redirect on this page, and the mistake would look
    // like an unrelated bug in an unrelated feature.
    expect(isResolvableRedirectSource('/administrator')).toBe(true)
    expect(isResolvableRedirectSource('/admin-ish')).toBe(true)
  })
})

describe('readCsvRecords', () => {
  it('reads plain rows', () => {
    const { records } = readCsvRecords('/a,/b\n/c,/d\n')
    expect(records).toEqual([
      { line: 1, fields: ['/a', '/b'] },
      { line: 2, fields: ['/c', '/d'] },
    ])
  })

  it('reads CRLF line endings', () => {
    const { records } = readCsvRecords('/a,/b\r\n/c,/d\r\n')
    expect(records).toHaveLength(2)
    expect(records[0]?.fields).toEqual(['/a', '/b'])
    expect(records[1]?.fields).toEqual(['/c', '/d'])
  })

  it('keeps a comma inside a quoted field', () => {
    // The reason a `split(',')` is not good enough: this row has three fields
    // by that measure and two by the file's.
    const { records } = readCsvRecords('"/tag/react,redux",/tag/react\n')
    expect(records[0]?.fields).toEqual(['/tag/react,redux', '/tag/react'])
  })

  it('unescapes doubled quotes', () => {
    const { records } = readCsvRecords('"/say-""hi""",/hello\n')
    expect(records[0]?.fields).toEqual(['/say-"hi"', '/hello'])
  })

  it('keeps a newline inside a quoted field and still counts lines', () => {
    const { records } = readCsvRecords('"/a","/b\nstill b"\n/c,/d\n')
    expect(records[0]?.fields).toEqual(['/a', '/b\nstill b'])
    expect(records[1]?.line).toBe(3)
  })

  it('strips a byte order mark', () => {
    const { records } = readCsvRecords('﻿/a,/b\n')
    expect(records[0]?.fields).toEqual(['/a', '/b'])
  })

  it('reports a file that ends inside a quote', () => {
    const { unterminatedQuote } = readCsvRecords('/a,"/b\n')
    expect(unterminatedQuote).toBe(true)
    expect(readCsvRecords('/a,/b\n').unterminatedQuote).toBe(false)
  })
})

describe('parseRedirectsCsv', () => {
  const reasons = (text: string, existing?: RedirectMap) =>
    parseRedirectsCsv(text, existing ? { existing } : {}).skipped.map((s) => s.reason)

  it('parses rows, defaulting the status to 301', () => {
    const { rows, skipped } = parseRedirectsCsv('/a,/b\n/c,/d,302\n')
    expect(skipped).toEqual([])
    expect(rows).toEqual([
      { line: 1, fromPath: '/a', toPath: '/b', statusCode: 301, enabled: true, note: null },
      { line: 2, fromPath: '/c', toPath: '/d', statusCode: 302, enabled: true, note: null },
    ])
  })

  it('normalises both sides', () => {
    const { rows } = parseRedirectsCsv('/a/?x=1,/b/#top\n')
    expect(rows[0]?.fromPath).toBe('/a')
    expect(rows[0]?.toPath).toBe('/b')
  })

  it('skips a header row, a blank line and a trailing newline', () => {
    const { rows, skipped } = parseRedirectsCsv('from,to,status\n\n/a,/b\n')
    expect(rows).toHaveLength(1)
    expect(skipped.map((s) => s.reason)).toEqual(['header', 'blank'])
  })

  it('reports the line, the reason and the raw row for every skip', () => {
    const { skipped } = parseRedirectsCsv('/a,/b\nnope,/c\n/d\n')
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toMatchObject({ line: 2, reason: 'invalid_from', raw: 'nope,/c' })
    expect(skipped[1]).toMatchObject({ line: 3, reason: 'column_count', raw: '/d' })
  })

  it('refuses a source path that is not a path', () => {
    expect(reasons('nope,/a\n')).toEqual(['invalid_from'])
    expect(reasons('//evil.example,/a\n')).toEqual(['invalid_from'])
    expect(reasons('/a/../b,/c\n')).toEqual(['invalid_from'])
    expect(reasons('/_next/x,/a\n')).toEqual(['invalid_from'])
  })

  it('refuses a target that is neither a path nor http(s)', () => {
    expect(reasons('/a,javascript:alert(1)\n')).toEqual(['invalid_to'])
    expect(reasons('/a,//evil.example\n')).toEqual(['invalid_to'])
    expect(reasons('/a,nope\n')).toEqual(['invalid_to'])
  })

  it('refuses a mailto target, which a link may have but a redirect may not', () => {
    // An HTTP Location header naming a mailto is not something a browser
    // follows, so the row would be dead weight.
    expect(reasons('/a,mailto:x@example.com\n')).toEqual(['invalid_to'])
    expect(reasons('/a,https://example.com/x\n')).toEqual([])
  })

  it('refuses a status that is not a redirect', () => {
    expect(reasons('/a,/b,200\n')).toEqual(['invalid_status'])
    expect(reasons('/a,/b,303\n')).toEqual(['invalid_status'])
    expect(reasons('/a,/b,permanent\n')).toEqual(['invalid_status'])
    expect(reasons('/a,/b,308\n')).toEqual([])
  })

  it('treats a source that is already stored as an update', () => {
    // The source path is the identity of a redirect, so a file that re-states
    // one with a new target is how a wrong target gets fixed.
    const existing = new Map([['/a', { toPath: '/b', statusCode: 301 }]])
    const { rows, skipped } = parseRedirectsCsv('/a,/c\n', { existing })
    expect(skipped).toEqual([])
    expect(rows[0]).toMatchObject({ fromPath: '/a', toPath: '/c' })
  })

  it('skips a row that would write exactly what is already stored', () => {
    const existing = new Map([['/a', { toPath: '/b', statusCode: 301 }]])
    expect(reasons('/a,/b\n', existing)).toEqual(['duplicate'])
  })

  it('updates when only the status code differs', () => {
    const existing = new Map([['/a', { toPath: '/b', statusCode: 301 }]])
    const { rows, skipped } = parseRedirectsCsv('/a,/b,308\n', { existing })
    expect(skipped).toEqual([])
    expect(rows[0]?.statusCode).toBe(308)
  })

  it('refuses a source the file has already used', () => {
    // Two rows with one source is a file that disagrees with itself; which of
    // them wins is not something the operator can predict.
    expect(reasons('/a,/b\n/a,/c\n')).toEqual(['duplicate'])
  })

  it('refuses a loop formed inside the file', () => {
    // Neither row exists yet, so this is only visible because the walk sees the
    // rows accepted before it.
    const { rows, skipped } = parseRedirectsCsv('/a,/b\n/b,/a\n')
    expect(rows).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ line: 2, reason: 'loop' })
    expect(skipped[0]?.detail).toContain('/b → /a → /b')
  })

  it('refuses a loop that closes through the database', () => {
    const existing = new Map([['/b', { toPath: '/a', statusCode: 301 }]])
    const { rows, skipped } = parseRedirectsCsv('/a,/b\n', { existing })
    expect(rows).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ line: 1, reason: 'loop' })
  })

  it('refuses a source that redirects to itself', () => {
    expect(reasons('/a,/a/\n')).toEqual(['loop'])
  })

  it('accepts a chain of ten hops and refuses one longer', () => {
    // Written back to front so each row already has its successor in place —
    // the chain has to exist before the row that joins it.
    const chain = (length: number) =>
      Array.from({ length }, (_, index) => {
        const step = length - index
        return `/h${step},/h${step + 1}\n`
      }).join('')

    // 10 edges from /h1 to /h11: /h1 → /h2 (9 lookups) then /h11 → null.
    const accepted = parseRedirectsCsv(chain(10))
    expect(accepted.rows).toHaveLength(10)
    expect(accepted.skipped).toEqual([])

    const refused = parseRedirectsCsv(chain(11))
    expect(refused.rows).toHaveLength(10)
    expect(refused.skipped).toHaveLength(1)
    expect(refused.skipped[0]?.reason).toBe('chain_too_long')
  })

  it('surfaces an unterminated quote rather than guessing', () => {
    const parsed = parseRedirectsCsv('/a,"/b\n')
    expect(parsed.unterminatedQuote).toBe(true)
  })
})

describe('detectRedirectLoop', () => {
  const map = (entries: Record<string, string>) => (path: string) =>
    entries[path] ?? null

  it('accepts a redirect that ends', () => {
    expect(detectRedirectLoop('/a', '/b', map({}))).toEqual({ ok: true })
  })

  it('accepts a chain that ends', () => {
    expect(detectRedirectLoop('/a', '/b', map({ '/b': '/c', '/c': '/d' }))).toEqual({
      ok: true,
    })
  })

  it('refuses a two-step loop', () => {
    const check = detectRedirectLoop('/a', '/b', map({ '/b': '/a' }))
    expect(check).toEqual({ ok: false, reason: 'cycle', chain: ['/a', '/b', '/a'] })
  })

  it('refuses a longer loop', () => {
    const check = detectRedirectLoop('/a', '/b', map({ '/b': '/c', '/c': '/b' }))
    expect(check.ok).toBe(false)
    expect(check.ok ? [] : check.chain).toEqual(['/a', '/b', '/c', '/b'])
  })

  it('refuses a redirect to itself', () => {
    expect(detectRedirectLoop('/a', '/a', map({}))).toEqual({
      ok: false,
      reason: 'self',
      chain: ['/a', '/a'],
    })
  })

  it('compares paths in their stored form', () => {
    // The loop is between `/a` and `/b`; the trailing slashes are noise from
    // whoever typed it, and a walk that kept them would miss the loop.
    const check = detectRedirectLoop('/a/', '/b/', map({ '/b': '/a' }))
    expect(check.ok).toBe(false)
  })

  it('refuses a chain longer than the hop limit', () => {
    const entries: Record<string, string> = {}
    for (let index = 0; index < MAX_REDIRECT_HOPS + 1; index += 1) {
      entries[`/h${index + 1}`] = `/h${index + 2}`
    }
    const check = detectRedirectLoop('/h0', '/h1', map(entries))
    expect(check.ok).toBe(false)
    expect(check.ok ? '' : check.reason).toBe('too_long')
    // The source, the target, and one entry per hop walked.
    expect(check.ok ? [] : check.chain).toHaveLength(MAX_REDIRECT_HOPS + 2)
  })

  it('stops at the hop limit instead of following forever', () => {
    // A lookup that never repeats itself: there is nothing for cycle detection
    // to catch, so the only thing that ends the walk is the hop limit.
    const endless = (path: string) => `${path}x`
    const check = detectRedirectLoop('/a', '/b', endless)
    expect(check.ok).toBe(false)
    expect(check.ok ? '' : check.reason).toBe('too_long')
  })
})

describe('validateRedirect', () => {
  it('normalises the source and defaults the status', () => {
    expect(validateRedirect({ fromPath: '/old/?a=1', toPath: '/new/' })).toEqual({
      fromPath: '/old',
      toPath: '/new',
      statusCode: 301,
      enabled: true,
      note: null,
    })
  })

  it('keeps an external target exactly as written', () => {
    const validated = validateRedirect({
      fromPath: '/old',
      toPath: 'https://example.com/a/',
    })
    expect(validated.toPath).toBe('https://example.com/a/')
  })

  it('rejects a source that is not a path', () => {
    expect(() => validateRedirect({ fromPath: 'old', toPath: '/new' })).toThrow(
      /Site-relative paths must start with/,
    )
    expect(() => validateRedirect({ fromPath: '//evil.example', toPath: '/n' })).toThrow(
      /protocol-relative/,
    )
  })

  it('rejects a source that can never fire', () => {
    expect(() =>
      validateRedirect({ fromPath: '/_next/chunk.js', toPath: '/new' }),
    ).toThrow(/can never fire/)
  })

  it('refuses to redirect the admin, and says why', () => {
    // Not "this can never fire" — this one would fire, and that is the problem.
    expect(() => validateRedirect({ fromPath: '/admin', toPath: '/new' })).toThrow(
      /only place this row could be deleted from/,
    )
    expect(() =>
      validateRedirect({ fromPath: '/admin/posts', toPath: '/new' }),
    ).toThrow(/only place this row could be deleted from/)
  })

  it('rejects a target that is neither a path nor http(s)', () => {
    expect(() => validateRedirect({ fromPath: '/a', toPath: 'mailto:x@y.com' })).toThrow()
    expect(() =>
      validateRedirect({ fromPath: '/a', toPath: 'javascript:alert(1)' }),
    ).toThrow()
  })

  it('reports a bad status code as an issue rather than a crash', () => {
    const failure = (() => {
      try {
        validateRedirect({ fromPath: '/a', toPath: '/b', statusCode: 200 })
        return null
      } catch (error) {
        return error as { code?: string; reason?: string }
      }
    })()
    expect(failure?.code).toBe('REDIRECT')
    expect(failure?.reason).toBe('invalid_input')
  })

  it('accepts each allowed status code', () => {
    for (const statusCode of [301, 302, 307, 308]) {
      expect(validateRedirect({ fromPath: '/a', toPath: '/b', statusCode })).toMatchObject({
        statusCode,
      })
    }
  })
})

const describeWithDatabase = describe.skipIf(!hasTestDatabase)

describeWithDatabase('redirects storage', () => {
  beforeAll(async () => {
    await runMigrations(process.env.TEST_DATABASE_URL as string)
  })

  const clear = async () => {
    await db.delete(redirects)
  }

  it('returns null for a path with no row', async () => {
    await clear()
    expect(await resolveRedirect('/nothing')).toBeNull()
  })

  it('returns null fast for a path that cannot match', async () => {
    await clear()
    await saveRedirect({ fromPath: '/_next/chunk.js', toPath: '/x' }).catch(() => undefined)
    expect(await resolveRedirect('/_next/chunk.js')).toBeNull()
    expect(await resolveRedirect('/api/anything')).toBeNull()
    expect(await resolveRedirect('not-a-path')).toBeNull()
  })

  it('resolves a saved redirect after normalising the request', async () => {
    await clear()
    await saveRedirect({ fromPath: '/old/', toPath: '/new', statusCode: 302 })

    expect(await resolveRedirect('/old')).toMatchObject({
      fromPath: '/old',
      toPath: '/new',
      statusCode: 302,
    })
    expect(await resolveRedirect('/old/')).not.toBeNull()
    expect(await resolveRedirect('/old?utm_source=x')).not.toBeNull()
  })

  it('ignores a disabled redirect', async () => {
    await clear()
    await saveRedirect({ fromPath: '/off', toPath: '/new', enabled: false })
    expect(await resolveRedirect('/off')).toBeNull()
  })

  it('replaces the rule for a source path rather than adding a second', async () => {
    await clear()
    await saveRedirect({ fromPath: '/a', toPath: '/b' })
    await saveRedirect({ fromPath: '/a', toPath: '/c' })

    const { rows, total } = await listRedirects({})
    expect(total).toBe(1)
    expect(rows[0]?.toPath).toBe('/c')
  })

  it('refuses a loop before writing it', async () => {
    await clear()
    await saveRedirect({ fromPath: '/a', toPath: '/b' })
    await expect(
      saveRedirect({ fromPath: '/b', toPath: '/a' }),
    ).rejects.toMatchObject({ code: 'REDIRECT', reason: 'loop' })

    expect((await listRedirects({})).total).toBe(1)
  })

  it('allows correcting a redirect that already points somewhere', async () => {
    await clear()
    await saveRedirect({ fromPath: '/a', toPath: '/b' })
    // /a already points at /b, so re-saving it cannot close a new loop even
    // though the old value would have.
    await expect(saveRedirect({ fromPath: '/a', toPath: '/b' })).resolves.toMatchObject({
      toPath: '/b',
    })
  })

  it('deletes by id and reports a miss', async () => {
    await clear()
    const row = await saveRedirect({ fromPath: '/a', toPath: '/b' })

    expect(await deleteRedirect(row.id)).toBe(true)
    expect(await deleteRedirect(row.id)).toBe(false)
    expect((await listRedirects({})).total).toBe(0)
  })

  it('filters the list by both paths', async () => {
    await clear()
    await saveRedirect({ fromPath: '/old-post', toPath: '/posts/new' })
    await saveRedirect({ fromPath: '/other', toPath: '/elsewhere' })

    expect((await listRedirects({ search: 'old' })).total).toBe(1)
    expect((await listRedirects({ search: '/posts/' })).total).toBe(1)
    expect((await listRedirects({ search: 'nothing' })).total).toBe(0)
  })

  it('imports a file and reports what it did', async () => {
    await clear()
    const report = await importRedirectsFromCsv(
      'from,to\n/a,/b\n/c,/d,302\nbad,/e\n',
    )

    expect(report.imported).toBe(2)
    expect(report.updated).toBe(0)
    expect(report.skipped).toHaveLength(2)
    expect(report.skipped.map((s) => s.reason)).toEqual(['header', 'invalid_from'])
    expect((await listRedirects({})).total).toBe(2)
  })

  it('updates on a second import instead of duplicating', async () => {
    await clear()
    await importRedirectsFromCsv('/a,/b\n')
    const report = await importRedirectsFromCsv('/a,/c\n')

    expect(report).toMatchObject({ imported: 0, updated: 1 })
    expect((await listRedirects({})).total).toBe(1)
    expect((await listRedirects({})).rows[0]?.toPath).toBe('/c')
  })

  it('reports a file that is already in place rather than rewriting it', async () => {
    await clear()
    await importRedirectsFromCsv('/a,/b\n')
    const report = await importRedirectsFromCsv('/a,/b\n')

    expect(report).toMatchObject({ imported: 0, updated: 0 })
    expect(report.skipped[0]?.reason).toBe('duplicate')
    expect((await listRedirects({})).total).toBe(1)
  })

  it('refuses an import that would close a loop through existing rows', async () => {
    await clear()
    await saveRedirect({ fromPath: '/b', toPath: '/a' })
    const report = await importRedirectsFromCsv('/a,/b\n')

    expect(report.imported).toBe(0)
    expect(report.skipped[0]?.reason).toBe('loop')
    expect((await listRedirects({})).total).toBe(1)
  })

  it('records every write in the audit log', async () => {
    await clear()

    // Identified by the ids that existed before the writes: another suite is
    // writing audit rows into the same database while this one runs.
    const before = new Set(
      (await db.select({ id: auditLogs.id }).from(auditLogs)).map((row) => row.id),
    )

    const created = await saveRedirect({ fromPath: '/a', toPath: '/b' })
    await saveRedirect({ fromPath: '/a', toPath: '/c' })
    await deleteRedirect(created.id)

    const actions = (
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.targetType, 'redirect'))
    )
      .filter((row) => !before.has(row.id) && row.targetId === '/a')
      .map((row) => row.action)

    expect(actions.sort()).toEqual([
      'redirect.create',
      'redirect.delete',
      'redirect.update',
    ])
  })

  it('records an import in the audit log', async () => {
    await clear()
    const before = new Set(
      (await db.select({ id: auditLogs.id }).from(auditLogs)).map((row) => row.id),
    )

    await importRedirectsFromCsv('/a,/b\nbad,/e\n')

    const written = (
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'redirect.import'))
    ).filter((row) => !before.has(row.id))

    expect(written).toHaveLength(1)
    expect(written[0]?.meta).toMatchObject({
      imported: 1,
      updated: 0,
      skipped: 1,
      skipReasons: ['invalid_from'],
    })
  })
})
