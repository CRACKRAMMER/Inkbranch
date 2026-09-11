import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { env, siteOrigin } from '@/env'
import {
  DayRollup,
  aggregateDay,
  aggregateRange,
  type RollupEvent,
} from '@/lib/analytics/aggregate'
import {
  VISITOR_COOKIE_NAME,
  beaconSchema,
  classifyUserAgent,
  collectPageView,
  hashVisitor,
  mintVisitorValue,
  normalizePath,
  pathFromReferer,
  readVisitorCookie,
  referrerHost,
  secondsUntilUtcMidnight,
} from '@/lib/analytics/collect'
import {
  addDays,
  dayEnd,
  dayStart,
  eachDay,
  isDay,
  utcDay,
} from '@/lib/analytics/day'
import { analyticsEnabled, recordPageView } from '@/lib/analytics'
import {
  AnalyticsRangeError,
  MAX_RANGE_DAYS,
  getAnalyticsSummary,
  getTopContent,
  rangeSchema,
} from '@/lib/analytics/query'
import { partitionPrunableDays, pruneRawEvents } from '@/lib/analytics/retention'
import { documentUrl } from '@/lib/content/paths'
import { db } from '@/lib/db'
import {
  analyticsDaily,
  analyticsEvents,
  contentIndex,
  type DeviceType,
} from '@/lib/db/schema'
import { hasTestDatabase } from '../setup'

/**
 * Analytics.
 *
 * Two halves, split the way the module is. The pure half — path and referrer
 * reduction, user-agent classification, the day arithmetic, the roll-up maths,
 * the retention policy — is what actually decides every number the dashboard
 * shows, and it runs everywhere. The database half only proves that the SQL
 * around that logic does what the logic says: it is guarded on
 * `hasTestDatabase` so a run with no database configured skips it instead of
 * failing, and so a run can never be pointed at the development database by
 * accident.
 *
 * The tests import the individual modules rather than `@/lib/analytics`. That is
 * deliberate and not a workaround: the index is a curated public surface that
 * hides the helpers on purpose, and the helpers are exactly what needs testing.
 */

const ORIGIN = 'https://example.com'

/* -------------------------------------------------------------------------- */
/*  Day arithmetic                                                             */
/* -------------------------------------------------------------------------- */

describe('utcDay', () => {
  it('names the UTC day, not the local one', () => {
    expect(utcDay(new Date('2026-03-01T00:30:00.000Z'))).toBe('2026-03-01')
    // The instant just before the boundary belongs to the day before it, which
    // is the case a local-midnight reading gets wrong.
    expect(utcDay(new Date('2026-03-01T23:59:59.999Z'))).toBe('2026-03-01')
    expect(utcDay(new Date('2026-03-02T00:00:00.000Z'))).toBe('2026-03-02')
  })
})

describe('isDay', () => {
  it('accepts days that exist', () => {
    expect(isDay('2026-01-01')).toBe(true)
    expect(isDay('2024-02-29')).toBe(true)
  })

  it('rejects a day that does not exist', () => {
    // `Date` rolls this forward into March without complaining, so the pattern
    // alone is not enough.
    expect(isDay('2026-02-31')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('2026-00-10')).toBe(false)
  })

  it('rejects anything that is not a zero-padded day', () => {
    expect(isDay('2026-1-1')).toBe(false)
    expect(isDay('20260101')).toBe(false)
    expect(isDay('2026-01-01T00:00:00Z')).toBe(false)
    expect(isDay('')).toBe(false)
  })
})

describe('dayStart, dayEnd and addDays', () => {
  it('puts the bounds exactly one day apart, at UTC midnight', () => {
    expect(dayStart('2026-03-01').toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(dayEnd('2026-03-01').toISOString()).toBe('2026-03-02T00:00:00.000Z')
    expect(dayEnd('2026-03-01').getTime() - dayStart('2026-03-01').getTime()).toBe(
      86_400_000,
    )
  })

  it('keeps every day 24 hours long in UTC, including across a DST change', () => {
    // The two US DST transitions in 2026, which is where a local-time reading
    // would produce a 23- or 25-hour day.
    expect(dayEnd('2026-03-08').getTime() - dayStart('2026-03-08').getTime()).toBe(
      86_400_000,
    )
    expect(dayEnd('2026-11-01').getTime() - dayStart('2026-11-01').getTime()).toBe(
      86_400_000,
    )
  })

  it('shifts by whole days in both directions', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02')
    expect(addDays('2026-03-01', -30)).toBe('2026-01-30')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
  })
})

describe('eachDay', () => {
  it('returns every day of an inclusive range', () => {
    expect(eachDay('2026-01-01', '2026-01-03')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
  })

  it('returns a single day for a single-day range', () => {
    expect(eachDay('2026-01-01', '2026-01-01')).toEqual(['2026-01-01'])
  })

  it('returns nothing when the range runs backwards', () => {
    // Not an error, and not a reversed list: a caller that swapped its bounds
    // gets no days, which the range validation then rejects in its own words.
    expect(eachDay('2026-01-03', '2026-01-01')).toEqual([])
  })

  it('crosses a month and a year boundary', () => {
    expect(eachDay('2025-12-30', '2026-01-02')).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*  Path normalisation                                                         */
/* -------------------------------------------------------------------------- */

describe('normalizePath', () => {
  it('drops the query string', () => {
    expect(normalizePath('/posts/x?utm_source=newsletter')).toBe('/posts/x')
    expect(normalizePath('/?page=2')).toBe('/')
  })

  it('drops the fragment', () => {
    expect(normalizePath('/posts/x#section-2')).toBe('/posts/x')
    expect(normalizePath('/posts/x?a=1#b')).toBe('/posts/x')
  })

  it('normalises one trailing slash, and leaves the root alone', () => {
    expect(normalizePath('/posts/x/')).toBe('/posts/x')
    expect(normalizePath('/posts/x///')).toBe('/posts/x')
    expect(normalizePath('/')).toBe('/')
  })

  it('folds repeated slashes, which HTTP treats as one', () => {
    expect(normalizePath('//posts//x')).toBe('/posts/x')
  })

  it('does not collapse unrelated paths into one', () => {
    // The rule that matters: normalisation must not invent a page. A path with
    // an extra segment keeps failing as its own row, which is how a broken link
    // gets noticed, and two different sections stay two rows.
    expect(normalizePath('/posts/x/y')).toBe('/posts/x/y')
    expect(normalizePath('/posts/a')).not.toBe(normalizePath('/posts/b'))
    expect(normalizePath('/posts/a')).not.toBe(normalizePath('/posts'))
    expect(normalizePath('/tags/js')).not.toBe(normalizePath('/tags/ts'))
  })

  it('keeps percent-encoding exactly as the browser sent it', () => {
    // Decoding `%2F` would turn an encoded separator back on and merge two
    // different routes into one.
    expect(normalizePath('/posts/a%2Fb')).toBe('/posts/a%2Fb')
    expect(normalizePath('/posts/a%20b')).toBe('/posts/a%20b')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizePath('  /posts/x  ')).toBe('/posts/x')
  })

  it('rejects anything that is not an absolute path', () => {
    expect(normalizePath('posts/x')).toBe(null)
    expect(normalizePath('https://example.com/posts/x')).toBe(null)
    expect(normalizePath('')).toBe(null)
    expect(normalizePath('   ')).toBe(null)
  })

  it('rejects a path longer than the column can hold', () => {
    expect(normalizePath(`/posts/${'a'.repeat(600)}`)).toBe(null)
    // One under the column width is still fine, so the limit is a width and not
    // an arbitrary length.
    expect(normalizePath(`/${'a'.repeat(511)}`)).toBe(`/${'a'.repeat(511)}`)
  })

  it('rejects control characters', () => {
    // Built rather than written as an escape so the file cannot be read as
    // containing a real control byte.
    const bell = String.fromCharCode(7)
    expect(normalizePath(`/posts/${bell}x`)).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/*  Referrers                                                                  */
/* -------------------------------------------------------------------------- */

describe('referrerHost', () => {
  it('keeps the host and only the host', () => {
    // The query string of a search results page is what the reader typed.
    expect(referrerHost('https://news.ycombinator.com/item?id=42', ORIGIN)).toBe(
      'news.ycombinator.com',
    )
    expect(
      referrerHost('https://www.google.com/search?q=how+to+blog', ORIGIN),
    ).toBe('google.com')
  })

  it('drops the port, which is not part of a domain', () => {
    expect(referrerHost('https://news.ycombinator.com:8443/item', ORIGIN)).toBe(
      'news.ycombinator.com',
    )
  })

  it('lowercases, and drops a trailing dot and a leading www', () => {
    expect(referrerHost('HTTPS://News.YCombinator.COM/x', ORIGIN)).toBe(
      'news.ycombinator.com',
    )
    expect(referrerHost('https://example.org./x', ORIGIN)).toBe('example.org')
    expect(referrerHost('https://www.example.org/x', ORIGIN)).toBe('example.org')
  })

  it('treats the site itself as no referrer', () => {
    // An internal referrer would otherwise put the site's own domain at the top
    // of its own referrer list, which is the most common way the number is read
    // wrong.
    expect(referrerHost('https://example.com/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('https://www.example.com/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('https://EXAMPLE.com/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('https://example.com:8443/posts/x', ORIGIN)).toBe('')
  })

  it('does not treat a subdomain as the site itself', () => {
    expect(referrerHost('https://blog.example.com/posts/x', ORIGIN)).toBe(
      'blog.example.com',
    )
  })

  it('drops referrers that are not web pages', () => {
    expect(referrerHost('mailto:someone@example.com', ORIGIN)).toBe('')
    expect(referrerHost('android-app://com.example.app', ORIGIN)).toBe('')
    expect(referrerHost('about:blank', ORIGIN)).toBe('')
  })

  it('drops a referrer whose host is an address', () => {
    // An address is not a domain, no reader navigated to it by name, and the
    // one thing that must never reach a column is an address.
    expect(referrerHost('http://192.168.1.5/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('http://[2001:db8::1]/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('http://[::ffff:192.168.1.5]/x', ORIGIN)).toBe('')
  })

  it('drops anything that is not a URL', () => {
    expect(referrerHost(null, ORIGIN)).toBe('')
    expect(referrerHost(undefined, ORIGIN)).toBe('')
    expect(referrerHost('', ORIGIN)).toBe('')
    expect(referrerHost('not a url', ORIGIN)).toBe('')
    // A relative value has no host, and a proxy-truncated header has no scheme.
    expect(referrerHost('/posts/x', ORIGIN)).toBe('')
    expect(referrerHost('//news.ycombinator.com/x', ORIGIN)).toBe('')
  })

  it('drops a host that could not be a DNS name', () => {
    expect(referrerHost(`https://${'a'.repeat(300)}.example/x`, ORIGIN)).toBe('')
  })

  it('defaults to the configured site origin', () => {
    expect(referrerHost(`${siteOrigin}/posts/x`)).toBe('')
    expect(referrerHost('https://some-other-site.example/x')).toBe(
      'some-other-site.example',
    )
  })
})

describe('pathFromReferer', () => {
  it('reads the path of a beacon sent from this site', () => {
    expect(pathFromReferer('https://example.com/posts/x?utm=1', ORIGIN)).toBe(
      '/posts/x',
    )
    expect(pathFromReferer('https://example.com/posts/x/', ORIGIN)).toBe('/posts/x')
  })

  it('accepts the www host for a site configured without it', () => {
    expect(pathFromReferer('https://www.example.com/posts/x', ORIGIN)).toBe(
      '/posts/x',
    )
  })

  it('refuses a beacon sent from anywhere else', () => {
    // A page on another origin cannot claim a path on this one.
    expect(pathFromReferer('https://other.example/posts/x', ORIGIN)).toBe(null)
    expect(pathFromReferer('https://example.com.evil.example/posts/x', ORIGIN)).toBe(
      null,
    )
    expect(pathFromReferer('https://blog.example.com/posts/x', ORIGIN)).toBe(null)
  })

  it('refuses a referer that is missing or unusable', () => {
    expect(pathFromReferer(null, ORIGIN)).toBe(null)
    expect(pathFromReferer('', ORIGIN)).toBe(null)
    expect(pathFromReferer('not a url', ORIGIN)).toBe(null)
    expect(pathFromReferer('/posts/x', ORIGIN)).toBe(null)
  })

  it('refuses the same host over a different scheme', () => {
    expect(pathFromReferer('http://example.com/posts/x', ORIGIN)).toBe(null)
  })

  it('refuses a path that normalises away', () => {
    expect(pathFromReferer(`https://example.com/${'a'.repeat(600)}`, ORIGIN)).toBe(
      null,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  User agents                                                                */
/* -------------------------------------------------------------------------- */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const ANDROID_PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

describe('classifyUserAgent', () => {
  it('classifies the readers', () => {
    expect(classifyUserAgent(IPHONE_UA)).toEqual({ device: 'mobile', bot: false })
    expect(classifyUserAgent(ANDROID_PHONE_UA)).toEqual({
      device: 'mobile',
      bot: false,
    })
    expect(classifyUserAgent(ANDROID_TABLET_UA)).toEqual({
      device: 'tablet',
      bot: false,
    })
    expect(classifyUserAgent(WINDOWS_UA)).toEqual({ device: 'desktop', bot: false })
    expect(classifyUserAgent(MAC_UA)).toEqual({ device: 'desktop', bot: false })
  })

  it('prefers the tablet reading when a user agent says both', () => {
    // An iPad UA contains `Mobile`, and an Android tablet is where the two
    // patterns overlap. Checking tablets first is what keeps the overlap from
    // silently becoming a phone.
    expect(classifyUserAgent(IPAD_UA).device).toBe('tablet')
    expect(classifyUserAgent(ANDROID_TABLET_UA).device).toBe('tablet')
  })

  it('spots the crawlers that actually visit a blog', () => {
    const crawlers = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'curl/8.4.0',
      'python-requests/2.31.0',
    ]

    for (const userAgent of crawlers) {
      expect(classifyUserAgent(userAgent).bot, userAgent).toBe(true)
    }
  })

  it('counts a phone whose brand ends in "bot" as a crawler', () => {
    // The known false positive of the `bot\b` rule, accepted rather than
    // special-cased: a handful of readers on one phone brand are dropped, and
    // the alternative is a pattern list that misses the next crawler.
    const cubot =
      'Mozilla/5.0 (Linux; Android 9; CUBOT X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.66 Mobile Safari/537.36'
    expect(classifyUserAgent(cubot)).toEqual({ device: 'mobile', bot: true })
  })

  it('does not call a reader a crawler for having no user agent', () => {
    // Privacy tools strip it, so a missing header is not evidence of a crawler.
    for (const userAgent of [null, undefined, '']) {
      expect(classifyUserAgent(userAgent)).toEqual({ device: 'other', bot: false })
    }
    expect(classifyUserAgent('SomePrivateBrowser/1.0')).toEqual({
      device: 'other',
      bot: false,
    })
  })

  it('leaves a crawler in a device class rather than inventing a fourth', () => {
    // `bot` is a value the schema allows and this module never writes: the
    // crawler decision is carried by `bot`, and the device class stays one of
    // the reader classes.
    const googlebot =
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    expect(classifyUserAgent(googlebot).device).toBe('other')
    expect(classifyUserAgent(`${WINDOWS_UA} AppleWebKit bot`).device).toBe('desktop')
  })
})

/* -------------------------------------------------------------------------- */
/*  The beacon contract                                                        */
/* -------------------------------------------------------------------------- */

describe('beaconSchema', () => {
  it('accepts an empty payload and the three fields the client may send', () => {
    expect(beaconSchema.safeParse({}).success).toBe(true)
    expect(
      beaconSchema.safeParse({
        referrer: 'https://news.ycombinator.com/item?id=42',
        durationMs: 12_000,
        navigationType: 'back_forward',
      }).success,
    ).toBe(true)
  })

  it('refuses a payload that names its own path', () => {
    // The path comes from the beacon request's `Referer`, never from the body.
    // A body that tries to supply one is a client that disagrees with the
    // contract, and the beacon is dropped rather than half-understood.
    expect(beaconSchema.safeParse({ path: '/posts/x' }).success).toBe(false)
    expect(beaconSchema.safeParse({ referrer: 'x', extra: 1 }).success).toBe(false)
  })

  it('refuses values outside the documented bounds', () => {
    expect(beaconSchema.safeParse({ durationMs: -1 }).success).toBe(false)
    expect(beaconSchema.safeParse({ durationMs: 1.5 }).success).toBe(false)
    expect(
      beaconSchema.safeParse({ durationMs: 24 * 60 * 60 * 1000 + 1 }).success,
    ).toBe(false)
    expect(
      beaconSchema.safeParse({ navigationType: 'push' }).success,
    ).toBe(false)
    expect(
      beaconSchema.safeParse({ referrer: 'a'.repeat(2049) }).success,
    ).toBe(false)
    expect(beaconSchema.safeParse({ referrer: 42 }).success).toBe(false)
  })

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'text', 7, []]) {
      expect(beaconSchema.safeParse(body).success).toBe(false)
    }
  })
})

describe('collectPageView', () => {
  const headers = {
    referer: 'https://example.com/posts/x',
    userAgent: IPHONE_UA,
  }

  it('derives the whole view from the request headers', () => {
    expect(collectPageView(headers, {}, ORIGIN)).toEqual({
      ok: true,
      view: {
        path: '/posts/x',
        referrerDomain: '',
        device: 'mobile',
        navigationType: 'navigate',
        durationMs: 0,
      },
    })
  })

  it('keeps the external referrer host and drops an internal one', () => {
    const external = collectPageView(
      headers,
      { referrer: 'https://news.ycombinator.com/item?id=42' },
      ORIGIN,
    )
    expect(external.ok && external.view.referrerDomain).toBe('news.ycombinator.com')

    const internal = collectPageView(
      headers,
      { referrer: `${ORIGIN}/notes/other` },
      ORIGIN,
    )
    expect(internal.ok && internal.view.referrerDomain).toBe('')
  })

  it('carries the optional fields through', () => {
    const collected = collectPageView(
      headers,
      { durationMs: 4200, navigationType: 'reload' },
      ORIGIN,
    )
    expect(collected.ok && collected.view.durationMs).toBe(4200)
    expect(collected.ok && collected.view.navigationType).toBe('reload')
  })

  it('drops a beacon with no path it can trust', () => {
    for (const referer of [null, '', 'not a url', 'https://other.example/posts/x']) {
      expect(collectPageView({ ...headers, referer }, {}, ORIGIN)).toEqual({
        ok: false,
        reason: 'no-path',
      })
    }
  })

  it('drops a crawler before anything is written', () => {
    expect(
      collectPageView({ referer: headers.referer, userAgent: 'curl/8.4.0' }, {}, ORIGIN),
    ).toEqual({ ok: false, reason: 'bot' })
    // A crawler is dropped even when the rest of the beacon is perfectly good.
    expect(
      collectPageView(
        { referer: headers.referer, userAgent: WINDOWS_UA.replace('Windows', 'Googlebot') },
        { referrer: 'https://news.ycombinator.com/item?id=1', durationMs: 5 },
        ORIGIN,
      ),
    ).toEqual({ ok: false, reason: 'bot' })
  })
})

/* -------------------------------------------------------------------------- */
/*  Visitor identity                                                           */
/* -------------------------------------------------------------------------- */

const VISITOR_VALUE = '0123456789abcdef0123456789abcdef'
const OTHER_VISITOR_VALUE = 'fedcba9876543210fedcba9876543210'

describe('mintVisitorValue', () => {
  it('is 32 hex characters and different every time', () => {
    const first = mintVisitorValue()
    const second = mintVisitorValue()

    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
  })

  it('takes no input, so nothing about the reader can reach it', () => {
    // 16 bytes from the CSPRNG and no parameter to feed: there is nowhere for
    // an address, a user agent or anything else stable about the machine to be
    // mixed in, which is what makes this a visitor count and not a fingerprint.
    expect(mintVisitorValue.length).toBe(0)
  })
})

describe('readVisitorCookie', () => {
  it('finds the value among other cookies', () => {
    const header = `theme=dark; ${VISITOR_COOKIE_NAME}=${VISITOR_VALUE}; tz=UTC`
    expect(readVisitorCookie(header)).toBe(VISITOR_VALUE)
  })

  it('decodes a percent-encoded value', () => {
    expect(
      readVisitorCookie(`${VISITOR_COOKIE_NAME}=${encodeURIComponent(VISITOR_VALUE)}`),
    ).toBe(VISITOR_VALUE)
  })

  it('is not fooled by another cookie that looks like ours', () => {
    expect(readVisitorCookie(`not_${VISITOR_COOKIE_NAME}=${VISITOR_VALUE}`)).toBe(null)
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME.toUpperCase()}=${VISITOR_VALUE}`)).toBe(
      null,
    )
  })

  it('accepts only the shape this module mints', () => {
    // Anything else is replaced rather than hashed into the day's visitor
    // count: a truncated cookie, another application's cookie, a guess.
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=`)).toBe(null)
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=abc`)).toBe(null)
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=${VISITOR_VALUE}00`)).toBe(null)
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=${VISITOR_VALUE.toUpperCase()}`)).toBe(
      null,
    )
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=${'g'.repeat(32)}`)).toBe(null)
  })

  it('returns nothing for a header that is missing or malformed', () => {
    expect(readVisitorCookie(null)).toBe(null)
    expect(readVisitorCookie(undefined)).toBe(null)
    expect(readVisitorCookie('')).toBe(null)
    expect(readVisitorCookie(VISITOR_COOKIE_NAME)).toBe(null)
    // A `%` that begins no escape sequence is not a value to guess at.
    expect(readVisitorCookie(`${VISITOR_COOKIE_NAME}=%zz`)).toBe(null)
  })
})

describe('hashVisitor', () => {
  const day = '2026-03-01'
  const secret = 'unit-test-secret'

  it('is stable for the same value and day', () => {
    expect(hashVisitor(VISITOR_VALUE, day, secret)).toBe(
      hashVisitor(VISITOR_VALUE, day, secret),
    )
    expect(hashVisitor(VISITOR_VALUE, day, secret)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cannot be joined across days', () => {
    // The day is inside the digest, so yesterday's rows cannot be matched to
    // today's reader even with the cookie in hand.
    expect(hashVisitor(VISITOR_VALUE, day, secret)).not.toBe(
      hashVisitor(VISITOR_VALUE, '2026-03-02', secret),
    )
  })

  it('separates two readers and two secrets', () => {
    expect(hashVisitor(VISITOR_VALUE, day, secret)).not.toBe(
      hashVisitor(OTHER_VISITOR_VALUE, day, secret),
    )
    expect(hashVisitor(VISITOR_VALUE, day, secret)).not.toBe(
      hashVisitor(VISITOR_VALUE, day, `${secret}-other`),
    )
  })

  it('does not contain the value it hashes', () => {
    // The database must not hold something that is also a live cookie.
    expect(hashVisitor(VISITOR_VALUE, day, secret)).not.toContain(VISITOR_VALUE)
  })

  it('defaults to the session secret', () => {
    expect(hashVisitor(VISITOR_VALUE, day)).toBe(
      hashVisitor(VISITOR_VALUE, day, env.SESSION_SECRET),
    )
  })
})

describe('secondsUntilUtcMidnight', () => {
  it('is the rest of the UTC day', () => {
    expect(secondsUntilUtcMidnight(new Date('2026-03-01T00:00:00.000Z'))).toBe(86_400)
    expect(secondsUntilUtcMidnight(new Date('2026-03-01T12:00:00.000Z'))).toBe(43_200)
    expect(secondsUntilUtcMidnight(new Date('2026-03-01T23:59:00.000Z'))).toBe(60)
  })

  it('never returns zero, so the cookie it sets always has a lifetime', () => {
    expect(secondsUntilUtcMidnight(new Date('2026-03-01T23:59:59.500Z'))).toBe(1)
    expect(secondsUntilUtcMidnight(new Date('2026-03-01T23:59:59.999Z'))).toBe(1)
  })

  it('lands exactly on the next UTC midnight', () => {
    // The cookie's lifetime and the hash's day are the same boundary: a reader
    // is countable within the day they were seen and is new tomorrow.
    const now = new Date('2026-03-01T12:00:00.000Z')
    const expiry = new Date(now.getTime() + secondsUntilUtcMidnight(now) * 1000)
    expect(expiry.toISOString()).toBe(dayStart(addDays(utcDay(now), 1)).toISOString())
  })
})

/* -------------------------------------------------------------------------- */
/*  The roll-up maths                                                          */
/* -------------------------------------------------------------------------- */

function rollupEvent(overrides: Partial<RollupEvent> = {}): RollupEvent {
  return {
    path: '/posts/a',
    contentId: null,
    referrerDomain: '',
    device: 'desktop',
    country: '',
    visitorHash: 'visitor-1',
    ...overrides,
  }
}

function rollupOf(events: RollupEvent[]): DayRollup {
  const rollup = new DayRollup()
  for (const event of events) rollup.add(event)
  return rollup
}

describe('DayRollup', () => {
  it('counts views and distinct visitors separately', () => {
    const rollup = rollupOf([
      rollupEvent({ visitorHash: 'visitor-1' }),
      rollupEvent({ visitorHash: 'visitor-1' }),
      rollupEvent({ visitorHash: 'visitor-2' }),
    ])

    expect(rollup.size).toBe(3)
    expect(rollup.rows()).toEqual([
      {
        path: '/posts/a',
        contentId: null,
        referrerDomain: '',
        device: 'desktop',
        country: '',
        views: 3,
        visitors: 2,
      },
    ])
    expect(rollup.totals()).toEqual({ views: 3, visitors: 2 })
  })

  it('keeps every dimension apart', () => {
    // The daily table's unique key is the dimension tuple, so two events that
    // differ anywhere in it are two rows and not one summed row.
    const rollup = rollupOf([
      rollupEvent(),
      rollupEvent({ referrerDomain: 'news.ycombinator.com' }),
      rollupEvent({ device: 'mobile' }),
      rollupEvent({ country: 'DE' }),
      rollupEvent({ path: '/posts/b' }),
      rollupEvent({ contentId: '11111111-1111-4111-8111-111111111111' }),
    ])

    expect(rollup.rows()).toHaveLength(6)
    expect(rollup.rows().every((row) => row.views === 1)).toBe(true)
    expect(rollup.totals()).toEqual({ views: 6, visitors: 6 })
  })

  it('does not merge two dimensions whose parts concatenate the same way', () => {
    // Without a separator in the key, ('/x', 'yz') and ('/xy', 'z') are the
    // same string, and two unrelated rows become one that describes neither.
    const rollup = rollupOf([
      rollupEvent({ path: '/x', contentId: 'yz' }),
      rollupEvent({ path: '/xy', contentId: 'z' }),
    ])

    expect(rollup.rows()).toHaveLength(2)
  })

  it('counts an event with no visitor without inventing one', () => {
    // A reader whose cookie is absent or malformed still viewed the page. The
    // row can therefore have more views than visitors.
    const rollup = rollupOf([rollupEvent({ visitorHash: '' })])
    const [row] = rollup.rows()

    expect(row).toBeDefined()
    expect(row?.views).toBe(1)
    expect(row?.visitors).toBe(0)
    expect(rollup.totals()).toEqual({ views: 1, visitors: 0 })
  })

  it('produces the same rows whatever order the events arrive in', () => {
    const events = [
      rollupEvent({ path: '/posts/b', visitorHash: 'visitor-1' }),
      rollupEvent({ visitorHash: 'visitor-2' }),
      rollupEvent({ path: '/posts/b', visitorHash: 'visitor-2' }),
      rollupEvent({ referrerDomain: 'news.ycombinator.com' }),
    ]

    // Idempotency starts here: the aggregation recomputes a day from its
    // events, so the same events must produce byte-identical rows however they
    // are read back.
    expect(rollupOf(events).rows()).toEqual(rollupOf([...events].reverse()).rows())
    expect(rollupOf(events).totals()).toEqual(rollupOf([...events].reverse()).totals())
  })

  it('is empty before anything is added', () => {
    const rollup = new DayRollup()
    expect(rollup.size).toBe(0)
    expect(rollup.rows()).toEqual([])
    expect(rollup.totals()).toEqual({ views: 0, visitors: 0 })
  })
})

/* -------------------------------------------------------------------------- */
/*  Retention policy                                                           */
/* -------------------------------------------------------------------------- */

describe('partitionPrunableDays', () => {
  it('prunes only the days the daily table already holds', () => {
    expect(
      partitionPrunableDays(
        ['2026-01-01', '2026-01-02'],
        new Set(['2026-01-02']),
      ),
    ).toEqual({ prunable: ['2026-01-02'], withheld: ['2026-01-01'] })
  })

  it('withholds a day whose only copy is still the raw events', () => {
    // This is the rule the whole module exists for: deleting an unaggregated
    // day destroys it for good, because no later run can rebuild a day whose
    // events are gone.
    expect(partitionPrunableDays(['2026-01-01'], []).withheld).toEqual(['2026-01-01'])
    expect(partitionPrunableDays(['2026-01-01'], []).prunable).toEqual([])
  })

  it('ignores an aggregated day that has no events left', () => {
    // Nothing to delete, and nothing missing either.
    expect(partitionPrunableDays([], ['2026-01-01'])).toEqual({
      prunable: [],
      withheld: [],
    })
    expect(partitionPrunableDays([], [])).toEqual({ prunable: [], withheld: [] })
  })

  it('returns both lists in day order', () => {
    const { prunable, withheld } = partitionPrunableDays(
      ['2026-01-03', '2026-01-01', '2026-01-04', '2026-01-02'],
      ['2026-01-03', '2026-01-01'],
    )

    expect(prunable).toEqual(['2026-01-01', '2026-01-03'])
    expect(withheld).toEqual(['2026-01-02', '2026-01-04'])
  })
})

/* -------------------------------------------------------------------------- */
/*  Range validation                                                           */
/* -------------------------------------------------------------------------- */

describe('range validation', () => {
  it('rejects a range that runs backwards', async () => {
    await expect(
      getAnalyticsSummary({ from: '2026-03-02', to: '2026-03-01' }),
    ).rejects.toThrow(AnalyticsRangeError)
  })

  it('rejects a day that does not exist', async () => {
    await expect(
      getAnalyticsSummary({ from: '2026-02-31', to: '2026-03-01' }),
    ).rejects.toThrow(AnalyticsRangeError)
  })

  it('rejects a range longer than the dashboard may ask for', async () => {
    await expect(
      getAnalyticsSummary({ from: '2026-01-01', to: '2027-01-02' }),
    ).rejects.toThrow(AnalyticsRangeError)
  })

  it('is inclusive at the limit, so the boundary is a span and not an off-by-one', () => {
    // Asserted on the schema rather than through `getAnalyticsSummary`, because
    // a range this long is *valid* and would therefore be answered with a
    // query — which this half of the file has no database for.
    expect(eachDay('2026-01-01', '2027-01-01')).toHaveLength(MAX_RANGE_DAYS)
    expect(
      rangeSchema.safeParse({ from: '2026-01-01', to: '2027-01-01' }).success,
    ).toBe(true)
    expect(
      rangeSchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success,
    ).toBe(false)
  })

  it('rejects a limit outside the range the list can render', async () => {
    await expect(
      getTopContent({ from: '2026-03-01', to: '2026-03-01', limit: 0 }),
    ).rejects.toThrow(AnalyticsRangeError)
    await expect(
      getTopContent({ from: '2026-03-01', to: '2026-03-01', limit: 101 }),
    ).rejects.toThrow(AnalyticsRangeError)
    await expect(
      getTopContent({ from: '2026-03-01', to: '2026-03-01', limit: 1.5 }),
    ).rejects.toThrow(AnalyticsRangeError)
  })

  it('names its own error, so a caller can answer with a 400', () => {
    expect(new AnalyticsRangeError('bad range').code).toBe('ANALYTICS_RANGE')
    expect(new AnalyticsRangeError('bad range').name).toBe('AnalyticsRangeError')
    expect(new AnalyticsRangeError('bad range')).toBeInstanceOf(Error)
  })
})

/* -------------------------------------------------------------------------- */
/*  Collection with analytics off                                              */
/* -------------------------------------------------------------------------- */

/**
 * The flag is read at call time but the environment is fixed when the process
 * starts, so a test file cannot turn collection on for one case and off for
 * another. When the environment has collection on, these assertions would be
 * testing nothing, and they say so by skipping instead of passing vacuously.
 */
describe.skipIf(env.ANALYTICS_ENABLED)('with collection disabled', () => {
  /**
   * A request that fails loudly if anything reads it.
   *
   * "Writes nothing" is not the same as "does no work": a disabled install that
   * still parsed bodies and headers would spend the work and leave the trace.
   * Any of these getters being reached turns into the test's failure message.
   */
  function untouchedRequest(): Request {
    const request = new Request('http://localhost:3000/api/analytics', {
      method: 'POST',
      body: JSON.stringify({ referrer: 'https://news.ycombinator.com/item?id=1' }),
    })

    Object.defineProperty(request, 'headers', {
      get() {
        throw new Error('the disabled path read the request headers')
      },
    })
    Object.defineProperty(request, 'json', {
      value: () => {
        throw new Error('the disabled path read the request body')
      },
    })

    return request
  }

  it('reports the flag through the public surface', () => {
    expect(analyticsEnabled()).toBe(false)
  })

  it('drops the beacon without touching the request', async () => {
    await expect(recordPageView(untouchedRequest())).resolves.toEqual({
      recorded: false,
      reason: 'disabled',
    })
  })

  it('never asks for a visitor cookie', async () => {
    const outcome = await recordPageView(untouchedRequest())
    expect(outcome.setVisitorCookie).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Against a database                                                         */
/* -------------------------------------------------------------------------- */

describe.skipIf(!hasTestDatabase)('analytics against a database', () => {
  /** Scopes every fixture to this run, so a rerun cannot read the last one's rows. */
  const RUN = `analytics-${Date.now().toString(36)}`

  /*
   * Fixed days, all far enough in the past that the retention cutoff cannot
   * drift onto them, and each test owns its own so that one test's aggregation
   * cannot recompute another's day.
   */
  const AGG_DAY = '2023-05-01'
  const QUIET_DAY = '2023-05-02'
  const RANGE_DAY = '2023-05-03'
  const SUMMARY_FROM = '2023-05-09'
  const SUMMARY_DAY = '2023-05-10'
  const TOP_DAY = '2023-05-20'

  const POST_SLUG = `${RUN}-post`
  const POST_PATH = `/posts/${POST_SLUG}`
  const TOP_SLUG = `${RUN}-top`
  const TOP_PATH = `/posts/${TOP_SLUG}`
  const MISSING_PATH = `/__analytics_test__/${RUN}/missing`
  const MISSING_TOP_PATH = `/__analytics_test__/${RUN}/gone`
  const DIRECT_PATH = `/__analytics_test__/${RUN}/direct`
  const AGGREGATED_PATH = `/__analytics_test__/${RUN}/aggregated`

  const RECORDED_PATH = `/posts/${RUN}-record`
  const DISABLED_PATH = `/posts/${RUN}-disabled`

  const contentIds: string[] = []

  /**
   * Days used by the retention test, relative to today because the cutoff is.
   * Ten and twenty days past the retention window, so a different retention
   * setting in the environment still leaves them on the old side of it.
   */
  function retentionDays(): [unaggregated: string, aggregated: string] {
    const span = env.ANALYTICS_RAW_RETENTION_DAYS
    return [addDays(utcDay(), -span - 10), addDays(utcDay(), -span - 20)]
  }

  /** Remove everything this file owns for a day, so a rerun starts clean. */
  async function clearDay(day: string): Promise<void> {
    await db.delete(analyticsDaily).where(eq(analyticsDaily.day, day))
    await db
      .delete(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.createdAt, dayStart(day)),
          lt(analyticsEvents.createdAt, dayEnd(day)),
        ),
      )
  }

  interface RawEventFixture {
    day: string
    /** Seconds past midnight UTC, so the rows stay in the order they are read. */
    offset: number
    path: string
    visitorHash?: string
    device?: DeviceType
    referrerDomain?: string
    contentId?: string | null
  }

  async function insertRawEvents(fixtures: RawEventFixture[]): Promise<void> {
    await db.insert(analyticsEvents).values(
      fixtures.map((fixture) => ({
        path: fixture.path,
        visitorHash: fixture.visitorHash ?? '',
        device: fixture.device ?? 'desktop',
        referrerDomain: fixture.referrerDomain ?? '',
        contentId: fixture.contentId ?? null,
        createdAt: new Date(dayStart(fixture.day).getTime() + fixture.offset * 1000),
      })),
    )
  }

  interface DailyRow {
    path: string
    device: DeviceType
    referrerDomain: string
    views: number
    visitors: number
  }

  function dailyRows(day: string): Promise<DailyRow[]> {
    return db
      .select({
        path: analyticsDaily.path,
        device: analyticsDaily.device,
        referrerDomain: analyticsDaily.referrerDomain,
        views: analyticsDaily.views,
        visitors: analyticsDaily.visitors,
      })
      .from(analyticsDaily)
      .where(eq(analyticsDaily.day, day))
      .orderBy(asc(analyticsDaily.path), asc(analyticsDaily.device))
  }

  async function rawCount(day: string): Promise<number> {
    const rows = await db
      .select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.createdAt, dayStart(day)),
          lt(analyticsEvents.createdAt, dayEnd(day)),
        ),
      )
    return rows.length
  }

  /** A beacon request from this site, sent at `now`. */
  function beaconRequest(options: {
    path: string
    cookie?: string
    payload?: Record<string, unknown>
    userAgent?: string
  }): Request {
    const headers = new Headers({
      referer: `${siteOrigin}${options.path}`,
      'user-agent': options.userAgent ?? WINDOWS_UA,
      'content-type': 'application/json',
    })
    if (options.cookie) headers.set('cookie', options.cookie)

    return new Request(`${siteOrigin}/api/analytics`, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        options.payload ?? {
          referrer: 'https://news.ycombinator.com/item?id=42',
          durationMs: 1200,
          navigationType: 'navigate',
        },
      ),
    })
  }

  afterAll(async () => {
    const [unaggregated, aggregated] = retentionDays()
    for (const day of [
      AGG_DAY,
      QUIET_DAY,
      RANGE_DAY,
      SUMMARY_FROM,
      SUMMARY_DAY,
      TOP_DAY,
      unaggregated,
      aggregated,
    ]) {
      await clearDay(day)
    }

    // Deleting the documents cascades the daily rows that point at them.
    if (contentIds.length > 0) {
      await db.delete(contentIndex).where(inArray(contentIndex.id, contentIds))
      await db.delete(analyticsDaily).where(inArray(analyticsDaily.contentId, contentIds))
    }

    await db.delete(analyticsEvents).where(eq(analyticsEvents.path, RECORDED_PATH))
  })

  /* ------------------------------------------------------------------------ */
  /*  Aggregation                                                             */
  /* ------------------------------------------------------------------------ */

  describe('aggregateDay', () => {
    /**
     * Six raw events on `AGG_DAY`: three views from two readers on two devices,
     * and two views by a reader whose cookie was absent or was not the shape
     * this module mints.
     */
    async function seedAggregateDay(): Promise<void> {
      await clearDay(AGG_DAY)

      await insertRawEvents([
        { day: AGG_DAY, offset: 0, path: POST_PATH, visitorHash: 'a1' },
        { day: AGG_DAY, offset: 1, path: POST_PATH, visitorHash: 'a2' },
        { day: AGG_DAY, offset: 2, path: POST_PATH, visitorHash: 'a1' },
        {
          day: AGG_DAY,
          offset: 3,
          path: POST_PATH,
          visitorHash: 'a3',
          device: 'mobile',
        },
        // Two views with no visitor at all: the views still happened.
        { day: AGG_DAY, offset: 4, path: MISSING_PATH },
        { day: AGG_DAY, offset: 5, path: MISSING_PATH },
      ])
    }

    it('rolls a day up by dimension, and never touches an empty day', async () => {
      await seedAggregateDay()
      await clearDay(QUIET_DAY)

      const result = await aggregateDay(AGG_DAY)

      expect(result).toEqual({
        day: AGG_DAY,
        skipped: false,
        rows: 3,
        views: 6,
        visitors: 3,
      })

      expect(await dailyRows(AGG_DAY)).toEqual([
        {
          path: MISSING_PATH,
          device: 'desktop',
          referrerDomain: '',
          views: 2,
          visitors: 0,
        },
        {
          path: POST_PATH,
          device: 'desktop',
          referrerDomain: '',
          views: 3,
          visitors: 2,
        },
        {
          path: POST_PATH,
          device: 'mobile',
          referrerDomain: '',
          views: 1,
          visitors: 1,
        },
      ])

      // Aggregation reads the raw events; retention is what deletes them.
      expect(await rawCount(AGG_DAY)).toBe(6)

      const quiet = await aggregateDay(QUIET_DAY)
      expect(quiet).toEqual({
        day: QUIET_DAY,
        skipped: true,
        rows: 0,
        views: 0,
        visitors: 0,
      })
      expect(await dailyRows(QUIET_DAY)).toEqual([])
    })

    it('recomputes a day instead of adding to it', async () => {
      // The property that makes a retry safe. An incrementing roll-up doubles
      // every counter it touches the second time it runs, and the second time is
      // the one that happens after a crash.
      await seedAggregateDay()

      const first = await aggregateDay(AGG_DAY)
      const firstRows = await dailyRows(AGG_DAY)

      expect(first.views).toBe(6)
      expect(await aggregateDay(AGG_DAY)).toEqual(first)
      expect(await dailyRows(AGG_DAY)).toEqual(firstRows)

      // One more view from a reader already counted: the row becomes the total
      // of the day's events, not the old row plus the new event.
      await insertRawEvents([
        { day: AGG_DAY, offset: 10, path: POST_PATH, visitorHash: 'a1' },
      ])

      const third = await aggregateDay(AGG_DAY)
      expect(third.views).toBe(7)
      expect(third.visitors).toBe(3)

      const rows = await dailyRows(AGG_DAY)
      expect(
        rows.find((row) => row.path === POST_PATH && row.device === 'desktop'),
      ).toEqual({
        path: POST_PATH,
        device: 'desktop',
        referrerDomain: '',
        views: 4,
        visitors: 2,
      })
    })

    it('aggregates a range day by day', async () => {
      await clearDay(QUIET_DAY)
      await clearDay(RANGE_DAY)
      await insertRawEvents([
        { day: RANGE_DAY, offset: 0, path: POST_PATH, visitorHash: 'd1' },
        { day: RANGE_DAY, offset: 1, path: POST_PATH, visitorHash: 'd1' },
      ])

      const results = await aggregateRange(QUIET_DAY, RANGE_DAY)

      expect(results.map((result) => result.day)).toEqual([QUIET_DAY, RANGE_DAY])
      expect(results[0]?.skipped).toBe(true)
      expect(results[1]).toEqual({
        day: RANGE_DAY,
        skipped: false,
        rows: 1,
        views: 2,
        visitors: 1,
      })
    })

    it('refuses something that is not a day', async () => {
      // A caller with a bad date has a bug, and rounding it into a day would
      // hide it behind a plausible number.
      await expect(aggregateDay('2026-02-31')).rejects.toThrow('Not a calendar day')
      await expect(aggregateDay('yesterday')).rejects.toThrow('Not a calendar day')
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Reads                                                                   */
  /* ------------------------------------------------------------------------ */

  describe('getAnalyticsSummary', () => {
    it('answers with the totals, a zero-filled series and the splits', async () => {
      await clearDay(SUMMARY_FROM)
      await clearDay(SUMMARY_DAY)

      await insertRawEvents([
        {
          day: SUMMARY_DAY,
          offset: 0,
          path: POST_PATH,
          visitorHash: 'b1',
          referrerDomain: 'example.org',
          device: 'mobile',
        },
        {
          day: SUMMARY_DAY,
          offset: 1,
          path: POST_PATH,
          visitorHash: 'b1',
          referrerDomain: 'example.org',
          device: 'mobile',
        },
        {
          day: SUMMARY_DAY,
          offset: 2,
          path: POST_PATH,
          visitorHash: 'b2',
          referrerDomain: 'search.example.net',
        },
        {
          day: SUMMARY_DAY,
          offset: 3,
          path: DIRECT_PATH,
          visitorHash: 'b3',
          device: 'tablet',
        },
      ])

      await aggregateDay(SUMMARY_DAY)

      const summary = await getAnalyticsSummary({
        from: SUMMARY_FROM,
        to: SUMMARY_DAY,
      })

      expect(summary.from).toBe(SUMMARY_FROM)
      expect(summary.to).toBe(SUMMARY_DAY)
      expect(summary.totals).toEqual({ views: 4, visitors: 3 })

      // A quiet day is a zero in the series, not a gap: a missing day and a day
      // nobody read look the same in a line chart, and only one of them is true.
      expect(summary.series).toEqual([
        { day: SUMMARY_FROM, views: 0, visitors: 0 },
        { day: SUMMARY_DAY, views: 4, visitors: 3 },
      ])

      expect(summary.topPaths).toEqual([
        { path: POST_PATH, views: 3, visitors: 2 },
        { path: DIRECT_PATH, views: 1, visitors: 1 },
      ])

      // Direct traffic is not a referrer, and the empty domain is filtered out
      // rather than listed as a source.
      expect(summary.topReferrers).toEqual([
        { domain: 'example.org', views: 2, visitors: 1 },
        { domain: 'search.example.net', views: 1, visitors: 1 },
      ])

      expect(summary.devices).toEqual([
        { device: 'mobile', views: 2, visitors: 1 },
        { device: 'desktop', views: 1, visitors: 1 },
        { device: 'tablet', views: 1, visitors: 1 },
      ])
    })

    it('answers an empty range with zeroes rather than nothing', async () => {
      await clearDay(SUMMARY_FROM)

      const summary = await getAnalyticsSummary({
        from: SUMMARY_FROM,
        to: SUMMARY_FROM,
      })

      expect(summary.totals).toEqual({ views: 0, visitors: 0 })
      expect(summary.series).toEqual([{ day: SUMMARY_FROM, views: 0, visitors: 0 }])
      expect(summary.topPaths).toEqual([])
      expect(summary.topReferrers).toEqual([])
      expect(summary.devices).toEqual([])
    })
  })

  describe('getTopContent', () => {
    it('joins the content index and keeps the paths that resolve to nothing', async () => {
      await clearDay(TOP_DAY)

      const [document] = await db
        .insert(contentIndex)
        .values({
          type: 'post',
          slug: TOP_SLUG,
          path: `posts/${TOP_SLUG}.md`,
          title: 'Analytics fixture',
          status: 'published',
          checksum: 'a'.repeat(64),
        })
        .returning({ id: contentIndex.id })

      if (!document) throw new Error('Could not insert the top-content fixture')
      contentIds.push(document.id)

      await insertRawEvents([
        {
          day: TOP_DAY,
          offset: 0,
          path: TOP_PATH,
          visitorHash: 'c1',
          referrerDomain: 'news.ycombinator.com',
          contentId: document.id,
        },
        {
          day: TOP_DAY,
          offset: 1,
          path: TOP_PATH,
          visitorHash: 'c2',
          referrerDomain: 'news.ycombinator.com',
          contentId: document.id,
        },
        {
          day: TOP_DAY,
          offset: 2,
          path: TOP_PATH,
          visitorHash: 'c2',
          referrerDomain: 'news.ycombinator.com',
          contentId: document.id,
        },
        // A path nothing in the index matches, arriving more often than the
        // article does: a 404 readers keep hitting, or a document that has since
        // been deleted.
        { day: TOP_DAY, offset: 3, path: MISSING_TOP_PATH, visitorHash: 'c3' },
        { day: TOP_DAY, offset: 4, path: MISSING_TOP_PATH, visitorHash: 'c3' },
        { day: TOP_DAY, offset: 5, path: MISSING_TOP_PATH, visitorHash: 'c3' },
        { day: TOP_DAY, offset: 6, path: MISSING_TOP_PATH, visitorHash: 'c3' },
        { day: TOP_DAY, offset: 7, path: MISSING_TOP_PATH, visitorHash: 'c3' },
      ])

      await aggregateDay(TOP_DAY)

      const entries = await getTopContent({
        from: TOP_DAY,
        to: TOP_DAY,
        limit: 10,
      })

      expect(entries).toEqual([
        {
          kind: 'unresolved',
          path: MISSING_TOP_PATH,
          views: 5,
          visitors: 1,
        },
        {
          kind: 'content',
          contentId: document.id,
          type: 'post',
          slug: TOP_SLUG,
          title: 'Analytics fixture',
          status: 'published',
          url: documentUrl('post', TOP_SLUG),
          path: TOP_PATH,
          views: 3,
          visitors: 2,
        },
      ])

      // Unresolved paths compete for places in the list rather than being
      // appended to it: a 404 that outranks the articles is the interesting
      // part of the report.
      expect(
        (await getTopContent({ from: TOP_DAY, to: TOP_DAY, limit: 1 })).map(
          (entry) => entry.kind,
        ),
      ).toEqual(['unresolved'])
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Retention                                                               */
  /* ------------------------------------------------------------------------ */

  describe('pruneRawEvents', () => {
    it('withholds a day that has not been aggregated, and deletes the rest', async () => {
      const [unaggregated, aggregated] = retentionDays()
      await clearDay(unaggregated)
      await clearDay(aggregated)

      await insertRawEvents([
        { day: unaggregated, offset: 0, path: MISSING_PATH },
        { day: unaggregated, offset: 1, path: MISSING_PATH },
        { day: unaggregated, offset: 2, path: MISSING_PATH },
        { day: aggregated, offset: 0, path: AGGREGATED_PATH },
        { day: aggregated, offset: 1, path: AGGREGATED_PATH },
      ])

      // Stand in for a day the aggregator has already written.
      await db.insert(analyticsDaily).values({
        day: aggregated,
        path: AGGREGATED_PATH,
        views: 2,
        visitors: 2,
        referrerDomain: '',
        device: 'desktop',
        country: '',
      })

      const first = await pruneRawEvents()

      expect(first.withheldDays).toContain(unaggregated)
      expect(first.withheldDays).toEqual([...first.withheldDays].sort())
      expect(first.deleted).toBeGreaterThanOrEqual(2)

      // The day nothing else has a copy of is still here. This is the whole
      // reason pruning asks the daily table first.
      expect(await rawCount(unaggregated)).toBe(3)
      expect(await rawCount(aggregated)).toBe(0)

      // Once the day has been aggregated, the next run is allowed to take it.
      await aggregateDay(unaggregated)
      const second = await pruneRawEvents()

      expect(second.withheldDays).not.toContain(unaggregated)
      expect(second.deleted).toBeGreaterThanOrEqual(3)
      expect(await rawCount(unaggregated)).toBe(0)

      // And the day is still readable, which is the point of waiting: the
      // events are gone and the numbers they produced are not.
      const daily = await dailyRows(unaggregated)
      expect(daily).toHaveLength(1)
      expect(daily[0]?.views).toBe(3)
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Collection                                                              */
  /* ------------------------------------------------------------------------ */

  describe('recordPageView', () => {
    it('records a view, counts one visitor per day, and issues one cookie', async () => {
      // The flag is read at call time, so it can be turned on for this case and
      // restored before anything else runs. `finally` rather than a cleanup
      // hook: a failing assertion must not leave collection on for the rest of
      // the file.
      const previous = env.ANALYTICS_ENABLED
      env.ANALYTICS_ENABLED = true

      try {
        await db.delete(analyticsEvents).where(eq(analyticsEvents.path, RECORDED_PATH))

        const now = new Date()
        const day = utcDay(now)

        const first = await recordPageView(beaconRequest({ path: RECORDED_PATH }), now)
        expect(first.recorded).toBe(true)

        const cookie = first.setVisitorCookie
        if (!cookie) throw new Error('the first beacon did not issue a visitor cookie')

        expect(cookie.name).toBe(VISITOR_COOKIE_NAME)
        expect(cookie.path).toBe('/')
        expect(cookie.httpOnly).toBe(true)
        expect(cookie.sameSite).toBe('lax')
        expect(cookie.secure).toBe(env.COOKIE_SECURE)
        // No cookie written here outlives the day it was minted in.
        expect(cookie.maxAge).toBeGreaterThan(0)
        expect(cookie.maxAge).toBeLessThanOrEqual(86_400)

        // The same reader, later the same day, from the same page: no second
        // cookie, and the same visitor.
        const second = await recordPageView(
          beaconRequest({
            path: RECORDED_PATH,
            cookie: `${VISITOR_COOKIE_NAME}=${cookie.value}`,
          }),
          now,
        )
        expect(second.recorded).toBe(true)
        expect(second.setVisitorCookie).toBeUndefined()

        const rows = await db
          .select({
            visitorHash: analyticsEvents.visitorHash,
            path: analyticsEvents.path,
            referrerDomain: analyticsEvents.referrerDomain,
            device: analyticsEvents.device,
            country: analyticsEvents.country,
            navigationType: analyticsEvents.navigationType,
            durationMs: analyticsEvents.durationMs,
          })
          .from(analyticsEvents)
          .where(eq(analyticsEvents.path, RECORDED_PATH))

        expect(rows).toHaveLength(2)
        expect(new Set(rows.map((row) => row.visitorHash)).size).toBe(1)
        expect(rows[0]).toEqual({
          visitorHash: hashVisitor(cookie.value, day),
          path: RECORDED_PATH,
          referrerDomain: 'news.ycombinator.com',
          device: 'desktop',
          // Never filled: filling it means reading the reader's address.
          country: '',
          navigationType: 'navigate',
          durationMs: 1200,
        })
      } finally {
        env.ANALYTICS_ENABLED = previous
      }
    })

    it('drops a beacon it cannot attribute, and writes nothing for it', async () => {
      const previous = env.ANALYTICS_ENABLED
      env.ANALYTICS_ENABLED = true

      try {
        const before = await rawCount(utcDay())
        const request = new Request(`${siteOrigin}/api/analytics`, {
          method: 'POST',
          headers: {
            // A beacon from a preview deployment is not a view of this site.
            referer: 'https://preview.example.net/posts/x',
            'user-agent': WINDOWS_UA,
            'content-type': 'application/json',
          },
          body: JSON.stringify({}),
        })

        await expect(recordPageView(request)).resolves.toEqual({
          recorded: false,
          reason: 'no-path',
        })
        expect(await rawCount(utcDay())).toBe(before)
      } finally {
        env.ANALYTICS_ENABLED = previous
      }
    })

    it.skipIf(env.ANALYTICS_ENABLED)('writes no row at all while disabled', async () => {
      // The same beacon that the test above records, sent while collection is
      // off: nothing is written, and no visitor cookie is asked for.
      const value = '00112233445566778899aabbccddeeff'
      const day = utcDay()
      const outcome = await recordPageView(
        beaconRequest({
          path: DISABLED_PATH,
          cookie: `${VISITOR_COOKIE_NAME}=${value}`,
        }),
      )

      expect(outcome).toEqual({ recorded: false, reason: 'disabled' })

      // Scoped to the hash this beacon would have written, so the assertion
      // cannot be satisfied by the absence of any row whatsoever.
      const rows = await db
        .select({ id: analyticsEvents.id })
        .from(analyticsEvents)
        .where(eq(analyticsEvents.visitorHash, hashVisitor(value, day)))
      expect(rows).toEqual([])

      const paths = await db
        .select({ id: analyticsEvents.id })
        .from(analyticsEvents)
        .where(eq(analyticsEvents.path, DISABLED_PATH))
      expect(paths).toEqual([])
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  The public surface                                                         */
/* -------------------------------------------------------------------------- */

describe('the analytics entry point', () => {
  it('is the same collection function the module exports', async () => {
    // A caller importing from `@/lib/analytics` gets the module that enforces
    // the rules, not a wrapper that could skip them.
    const { recordPageView: fromModule } = await import('@/lib/analytics/collect')
    expect(recordPageView).toBe(fromModule)
  })

  it('does not re-export the internals it is meant to hide', async () => {
    const surface = await import('@/lib/analytics')
    for (const name of ['normalizePath', 'referrerHost', 'classifyUserAgent', 'hashVisitor']) {
      expect(Object.keys(surface)).not.toContain(name)
    }
  })
})
