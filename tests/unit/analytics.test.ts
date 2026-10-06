import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env, siteOrigin } from '@/env'
import {
  DayRollup,
  aggregateDay,
  aggregateDays,
  aggregatePending,
  aggregateRange,
  pendingDays,
  refreshViewCounts,
  type RollupEvent,
} from '@/lib/analytics/aggregate'
import {
  MAX_DURATION_MS,
  MAX_REFERRER_LENGTH,
  NAVIGATION_TYPES,
  buildBeacon,
} from '@/lib/analytics/beacon'
import { DwellClock } from '@/lib/analytics/dwell'
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
  readBeacon,
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
  TRAFFIC_WINDOW_DAYS,
  getAnalyticsSummary,
  getTopContent,
  getTrafficWindows,
  rangeSchema,
  type TrafficWindows,
  type ViewCounts,
} from '@/lib/analytics/query'
import { partitionPrunableDays, pruneRawEvents } from '@/lib/analytics/retention'
import { documentUrl } from '@/lib/content/paths'
import { db } from '@/lib/db'
import { runMigrations } from '@/lib/db/migrate'
import {
  analyticsDaily,
  analyticsEvents,
  contentIndex,
  siteSettings,
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

describe('bounded beacon bodies', () => {
  it('rejects and cancels an oversized chunked body without trusting content-length', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2048).fill(32)) },
      cancel() { cancelled = true },
    })
    const request = new Request(`${siteOrigin}/api/analytics`, {
      method: 'POST', body, duplex: 'half',
    } as RequestInit & { duplex: string })
    expect(await readBeacon(request)).toBeNull()
    expect(cancelled).toBe(true)
  })

  it('enforces the byte ceiling even when the declared length understates the payload', async () => {
    const request = new Request(`${siteOrigin}/api/analytics`, {
      method: 'POST', headers: { 'content-length': '2' },
      body: JSON.stringify({ referrer: 'x'.repeat(5000) }),
    })
    expect(await readBeacon(request)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  The client half                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `DwellClock` and `./beacon` are what the browser actually runs; the component
 * around them only attaches listeners. Both are free of the DOM so that this is
 * possible at all — a component that owns a `document` listener can only be
 * tested by driving a browser, which in practice means it is not tested.
 */
describe('DwellClock', () => {
  /** A clock the test moves by hand. No timers, no waiting, no flakiness. */
  function clockAt(startMs = 0) {
    let now = startMs
    return {
      clock: new DwellClock(() => now),
      advance(ms: number) {
        now += ms
      },
      set(ms: number) {
        now = ms
      },
    }
  }

  it('counts nothing before the page is shown', () => {
    const { clock, advance } = clockAt()
    advance(5_000)
    expect(clock.elapsedMs()).toBe(0)
  })

  it('counts the stretch the page is visible for', () => {
    const { clock, advance } = clockAt()
    clock.show()
    advance(4_200)
    expect(clock.elapsedMs()).toBe(4_200)
  })

  it('banks what it counted, and adds the next stretch to it', () => {
    // A reader who switches to another tab and comes back was reading for both
    // stretches, and only the time in between is not theirs.
    const { clock, advance } = clockAt()
    clock.show()
    advance(1_000)
    clock.hide()
    advance(60_000)
    clock.show()
    advance(500)
    expect(clock.elapsedMs()).toBe(1_500)
  })

  it('stops counting while the page is hidden', () => {
    const { clock, advance } = clockAt()
    clock.show()
    advance(1_000)
    clock.hide()
    advance(10_000)
    expect(clock.elapsedMs()).toBe(1_000)
  })

  it('does not start a second stretch when shown twice', () => {
    // `visibilitychange` can fire with the same value twice, and a handler that
    // took the second call as a fresh start would report half the time.
    const { clock, advance } = clockAt()
    clock.show()
    advance(1_000)
    clock.show()
    advance(1_000)
    expect(clock.elapsedMs()).toBe(2_000)
  })

  it('banks nothing when hidden without having been shown', () => {
    const { clock, advance } = clockAt()
    clock.hide()
    advance(1_000)
    clock.show()
    advance(1_000)
    expect(clock.elapsedMs()).toBe(1_000)
  })

  it('never counts backwards when the clock does', () => {
    // An NTP correction, or a laptop waking from suspend. A negative duration
    // fails the schema, and a failed schema drops the whole beacon — the view
    // would be lost, not just this field.
    const { clock, set, advance } = clockAt(1_000_000)
    clock.show()
    set(1_000_000 - 30_000)
    expect(clock.elapsedMs()).toBe(0)

    // The stretch is measured against the corrected clock, so counting resumes
    // when it passes the point the stretch started from rather than at the jump.
    advance(30_000)
    expect(clock.elapsedMs()).toBe(0)
    advance(1_000)
    expect(clock.elapsedMs()).toBe(1_000)

    clock.hide()
    expect(clock.elapsedMs()).toBe(1_000)
  })

  it('banks nothing for a stretch the clock says was negative', () => {
    // The same correction, this time landing on `hide()`: the time is banked
    // through the same clamp, so nothing is carried forward from it.
    const { clock, set, advance } = clockAt(1_000_000)
    clock.show()
    set(1_000_000 - 60_000)
    clock.hide()
    expect(clock.elapsedMs()).toBe(0)

    advance(1_000)
    clock.show()
    advance(2_000)
    expect(clock.elapsedMs()).toBe(2_000)
  })

  it('lets a view be reported exactly once', () => {
    // Not tidiness: the server writes one row per beacon and cannot recognise a
    // repeat without keeping something about the reader to recognise it with.
    // A second beacon is a second view, so on a phone this is every app switch.
    const { clock } = clockAt()
    expect(clock.isReported).toBe(false)
    expect(clock.claim()).toBe(true)
    expect(clock.isReported).toBe(true)
    expect(clock.claim()).toBe(false)
  })
})

describe('what the client builds, the server accepts', () => {
  /**
   * The drift guard, in the direction that can silently break the site.
   *
   * `./beacon` is the client's half of the contract and `beaconSchema` is the
   * server's, and they are two files because the server's half imports zod —
   * which a page's bundle must not, to validate a payload the client itself
   * just built. The risk of that split is one-directional: a client that sends
   * a field the schema refuses has every beacon dropped, and a dropped beacon
   * is invisible. The dashboard would go quiet and nothing would fail.
   *
   * So these do not test the shape of either half. They build payloads the way
   * the browser builds them, and require the server to accept every one.
   */
  const asBuilt = [
    buildBeacon({}),
    buildBeacon({ durationMs: 0 }),
    buildBeacon({ durationMs: 8_431 }),
    buildBeacon({ durationMs: 0.4 }),
    buildBeacon({ durationMs: 7 * 24 * 60 * 60 * 1000 }),
    buildBeacon({ durationMs: Number.NaN }),
    buildBeacon({ durationMs: -1 }),
    buildBeacon({ durationMs: Number.POSITIVE_INFINITY }),
    buildBeacon({ referrer: 'https://news.ycombinator.com/item?id=42' }),
    buildBeacon({ referrer: '' }),
    buildBeacon({ referrer: '   ' }),
    buildBeacon({ referrer: null }),
    buildBeacon({ referrer: 'x'.repeat(4_096) }),
    buildBeacon({ referrer: 'https://example.com/post', durationMs: 900 }),
    ...NAVIGATION_TYPES.map((navigationType) =>
      buildBeacon({ navigationType, durationMs: 1 }),
    ),
  ]

  it('accepts every payload the client can build', () => {
    for (const payload of asBuilt) {
      const parsed = beaconSchema.safeParse(payload)
      expect(parsed.success, JSON.stringify(payload)).toBe(true)
    }
  })

  it('sends a payload the server stores exactly as it arrived', () => {
    const payload = buildBeacon({
      referrer: 'https://example.com/post',
      durationMs: 8_431,
      navigationType: 'reload',
    })
    expect(beaconSchema.parse(payload)).toEqual(payload)
  })

  it('truncates a referrer to exactly the limit the schema enforces', () => {
    const payload = buildBeacon({ referrer: `https://example.com/${'x'.repeat(4_000)}` })
    expect(payload.referrer).toHaveLength(MAX_REFERRER_LENGTH)
    expect(beaconSchema.safeParse(payload).success).toBe(true)

    // And the boundary is real: one character more is refused, which is what
    // makes truncating rather than sending the whole thing the right call.
    expect(
      beaconSchema.safeParse({ referrer: 'x'.repeat(MAX_REFERRER_LENGTH + 1) }).success,
    ).toBe(false)
  })

  it('clamps a duration to the day the schema allows', () => {
    const week = 7 * 24 * 60 * 60 * 1000
    expect(buildBeacon({ durationMs: week }).durationMs).toBe(MAX_DURATION_MS)
    expect(buildBeacon({ durationMs: MAX_DURATION_MS }).durationMs).toBe(MAX_DURATION_MS)
    // A clock that was never shown, or one that moved backwards.
    expect(buildBeacon({ durationMs: Number.NaN }).durationMs).toBe(0)
    expect(buildBeacon({ durationMs: -5 }).durationMs).toBe(0)
  })

  it('omits a field rather than sending an empty one', () => {
    // The schema's version of "no referrer" is a missing key, and a zero-length
    // string is a different thing on the wire. `strictObject` would refuse the
    // extra key if it were sent; it cannot refuse a key that is absent.
    expect('referrer' in buildBeacon({ referrer: '' })).toBe(false)
    expect('referrer' in buildBeacon({ referrer: '   ' })).toBe(false)
    expect('referrer' in buildBeacon({ referrer: null })).toBe(false)
    expect('referrer' in buildBeacon({})).toBe(false)
    // A client-side navigation within the site is none of the four arrivals,
    // and reporting nothing is the honest answer rather than a fifth word.
    expect('navigationType' in buildBeacon({})).toBe(false)
    expect('navigationType' in buildBeacon({ navigationType: undefined })).toBe(false)
    // Duration is always present: zero is a real answer to "how long".
    expect(buildBeacon({}).durationMs).toBe(0)
  })

  it('names arrivals with the four words the browser itself uses', () => {
    // Exactly `PerformanceNavigationTiming.type`'s values, so the client can
    // pass one through without mapping it.
    expect([...NAVIGATION_TYPES]).toEqual([
      'navigate',
      'reload',
      'back_forward',
      'prerender',
    ])
    expect(beaconSchema.safeParse({ navigationType: 'push' }).success).toBe(false)
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
  beforeAll(async () => { await runMigrations(process.env.TEST_DATABASE_URL as string) })
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

  /**
   * Two days for the view-count fold, because the sum has to span them.
   *
   * A fold that read one day — today, or the range the dashboard defaults to —
   * would give a plausible number for a document with a single day's traffic and
   * a wrong one for everything else. This is the cheap way to be unable to make
   * that mistake.
   */
  const COUNT_DAY = '2023-05-21'
  const COUNT_DAY_2 = '2023-05-22'

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
      COUNT_DAY,
      COUNT_DAY_2,
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

  describe('getTrafficWindows', () => {
    /** This test's rows and no one else's, so cleanup never has to be a guess. */
    const TRAFFIC_PATH = `/__analytics_test__/${RUN}/windows`

    const clearTrafficRows = (): Promise<unknown> =>
      db.delete(analyticsDaily).where(eq(analyticsDaily.path, TRAFFIC_PATH))

    afterAll(clearTrafficRows)

    /*
     * Days relative to today, because the windows are: "the last thirty days"
     * is measured from the moment of the call, so a fixture pinned to a date in
     * 2023 would sit outside every window and the test would pass against a
     * function that answered zeroes.
     */
    it('counts today, the last seven days and the last thirty — and stops where each says', async () => {
      await clearTrafficRows()

      /*
       * Read before the fixture is written, so the assertions below are deltas.
       * That keeps them exact about the days they name without depending on
       * what else is in the table — including rows a previous run left behind,
       * which is the difference between a test that reruns and one that does
       * not.
       */
      const before = await getTrafficWindows()

      const today = utcDay()
      /** The oldest day each window holds, and the first day past it. */
      const weekEdge = addDays(today, -6)
      const monthEdge = addDays(today, -(TRAFFIC_WINDOW_DAYS - 1))

      /*
       * Powers of two, one day per boundary. Any subset of them sums to a
       * different number, so a window that took in one day too many or too few
       * cannot land on the right total by accident — which is the only failure
       * this test is built to catch.
       */
      await db.insert(analyticsDaily).values([
        { day: today, path: TRAFFIC_PATH, views: 1, visitors: 3 },
        { day: addDays(today, -1), path: TRAFFIC_PATH, views: 2, visitors: 4 },
        { day: weekEdge, path: TRAFFIC_PATH, views: 4, visitors: 6 },
        { day: addDays(weekEdge, -1), path: TRAFFIC_PATH, views: 8, visitors: 16 },
        { day: monthEdge, path: TRAFFIC_PATH, views: 32, visitors: 64 },
        { day: addDays(monthEdge, -1), path: TRAFFIC_PATH, views: 128, visitors: 256 },
      ])

      const after = await getTrafficWindows()

      /** What the fixture added to a window, which is all this test claims. */
      const added = (window: keyof TrafficWindows): ViewCounts => ({
        views: after[window].views - before[window].views,
        visitors: after[window].visitors - before[window].visitors,
      })

      // Today is today: yesterday is not in it, and the two figures are the
      // fixture's own rather than a sum that happens to fit.
      expect(added('today')).toEqual({ views: 1, visitors: 3 })

      // Today, yesterday and the sixth day back — and not the seventh, which is
      // where the eight views are.
      expect(added('last7')).toEqual({ views: 7, visitors: 13 })

      // The same three plus days seven and twenty-nine back: 47 rather than the
      // 175 a window that reached one day further would report.
      expect(added('last30')).toEqual({ views: 47, visitors: 93 })
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
  /*  The count the admin list reads                                          */
  /* ------------------------------------------------------------------------ */

  describe('refreshViewCounts', () => {
    const COUNT_SLUG = `${RUN}-counted`
    const COUNT_PATH = `/posts/${COUNT_SLUG}`
    const QUIET_SLUG = `${RUN}-quiet`

    async function insertDocument(slug: string): Promise<string> {
      const [row] = await db
        .insert(contentIndex)
        .values({
          type: 'post',
          slug,
          path: `posts/${slug}.md`,
          title: 'View count fixture',
          status: 'published',
          checksum: 'b'.repeat(64),
        })
        .returning({ id: contentIndex.id })

      if (!row) throw new Error('Could not insert the view-count fixture')
      contentIds.push(row.id)
      return row.id
    }

    async function viewCountOf(id: string): Promise<number> {
      const [row] = await db
        .select({ viewCount: contentIndex.viewCount })
        .from(contentIndex)
        .where(eq(contentIndex.id, id))
        .limit(1)
      return row?.viewCount ?? -1
    }

    it('folds every day into the column, and rewrites nothing on the next pass', async () => {
      await clearDay(COUNT_DAY)
      await clearDay(COUNT_DAY_2)

      const counted = await insertDocument(COUNT_SLUG)
      const quiet = await insertDocument(QUIET_SLUG)

      // Before: the column is at its default and nothing has written it. This is
      // the state the admin list was in for every document.
      expect(await viewCountOf(counted)).toBe(0)

      await db.insert(analyticsDaily).values([
        { day: COUNT_DAY, path: COUNT_PATH, contentId: counted, views: 3, visitors: 2 },
        { day: COUNT_DAY, path: COUNT_PATH, contentId: counted, views: 1, visitors: 1, device: 'mobile' },
        { day: COUNT_DAY_2, path: COUNT_PATH, contentId: counted, views: 4, visitors: 3 },
        // A path with no document behind it: it has nowhere to be counted, and
        // it must not stop the statement or land on someone else's row.
        { day: COUNT_DAY, path: MISSING_PATH, views: 9, visitors: 9 },
      ])

      await refreshViewCounts()

      // Summed across both days, and only over this document's rows.
      expect(await viewCountOf(counted)).toBe(8)
      // A document nobody has read stays where it is rather than being written.
      expect(await viewCountOf(quiet)).toBe(0)

      /*
       * The second pass rewrites nothing, and that is the property the job
       * depends on: it runs every minute, and a statement that rewrote every
       * row every minute would be a table-wide write for no change. `updated: 0`
       * is an exact assertion here rather than a loose one — after a pass,
       * nothing can still differ.
       */
      expect(await refreshViewCounts()).toEqual({ updated: 0 })
    })

    it('takes a document back to zero when the views behind it are gone', async () => {
      await clearDay(COUNT_DAY)
      await clearDay(COUNT_DAY_2)

      const id = await insertDocument(`${COUNT_SLUG}-gone`)
      await db.insert(analyticsDaily).values({
        day: COUNT_DAY,
        path: `/posts/${COUNT_SLUG}-gone`,
        contentId: id,
        views: 5,
        visitors: 5,
      })

      await refreshViewCounts()
      expect(await viewCountOf(id)).toBe(5)

      // The days a document was read on can lose their rows — retention, a
      // rebuild, an operator clearing a bad day — and a count that only ever
      // rises would keep reporting traffic that no longer exists anywhere.
      await db.delete(analyticsDaily).where(eq(analyticsDaily.contentId, id))

      await refreshViewCounts()
      expect(await viewCountOf(id)).toBe(0)
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
  /*  Catching up                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * `pendingDays` and `aggregatePending`: the question the worker asks on every
   * tick, and what it does about the answer.
   *
   * Every day here is in 2030 and `pendingDays` is handed a matching `now`, and
   * both halves of that matter. The sweep looks back the retention window from
   * today: a fixture in 2023 is outside it and would prove nothing, while the
   * rest of this file writes events at the real today — which, read by a sweep
   * pointed at it, would appear as a hole this test never created.
   */
  describe('catching up', () => {
    const NOW = new Date('2030-01-15T12:00:00.000Z')
    const TODAY = '2030-01-15'
    const YESTERDAY = '2030-01-14'
    /** Two days inside the lookback with events and no daily row: the holes. */
    const HOLE_OLD = '2030-01-10'
    const HOLE_NEW = '2030-01-12'
    /** A day the aggregator has already written, so it is not behind. */
    const DONE = '2030-01-11'
    /** A day whose events no retention window still covers. */
    function beyondTheWindow(): string {
      return addDays(TODAY, -(env.ANALYTICS_RAW_RETENTION_DAYS + 5))
    }

    const HOLE_PATH = `/__analytics_test__/${RUN}/hole`
    const DONE_PATH = `/__analytics_test__/${RUN}/done`

    const FIXTURE_DAYS = [TODAY, YESTERDAY, HOLE_OLD, HOLE_NEW, DONE]

    afterAll(async () => {
      for (const day of [...FIXTURE_DAYS, beyondTheWindow()]) {
        await clearDay(day)
      }
    })

    /** Three views by two readers on the old hole, one view on the new one. */
    async function seedHoles(): Promise<void> {
      await clearDay(HOLE_OLD)
      await clearDay(HOLE_NEW)
      await insertRawEvents([
        { day: HOLE_OLD, offset: 0, path: HOLE_PATH, visitorHash: 'b1' },
        { day: HOLE_OLD, offset: 1, path: HOLE_PATH, visitorHash: 'b2' },
        { day: HOLE_OLD, offset: 2, path: HOLE_PATH, visitorHash: 'b1' },
        { day: HOLE_NEW, offset: 0, path: HOLE_PATH, visitorHash: 'b3' },
      ])
    }

    it('asks for today and yesterday, then the oldest hole first', async () => {
      for (const day of [...FIXTURE_DAYS, beyondTheWindow()]) {
        await clearDay(day)
      }
      await seedHoles()

      // A day that is already rolled up, and a day older than anything the
      // sweep looks back over.
      await clearDay(DONE)
      await db.insert(analyticsDaily).values({
        day: DONE,
        path: DONE_PATH,
        views: 4,
        visitors: 2,
        referrerDomain: '',
        device: 'desktop',
        country: '',
      })
      await insertRawEvents([
        { day: beyondTheWindow(), offset: 0, path: HOLE_PATH },
      ])

      const pending = await pendingDays(NOW)

      // Today is not over and yesterday's last event can outlive the last run
      // of that day, so neither is ever considered finished.
      expect(pending.days.slice(0, 2)).toEqual([TODAY, YESTERDAY])

      expect(pending.days).toContain(HOLE_OLD)
      expect(pending.days).toContain(HOLE_NEW)
      // Already rolled up, so there is nothing to rebuild.
      expect(pending.days).not.toContain(DONE)
      // Older than the window. Retention has already had its chance at that
      // day, or is about to; either way this sweep is not what unblocks it.
      expect(pending.days).not.toContain(beyondTheWindow())

      // Oldest first, which is what stops the day retention is waiting on from
      // being the day that gets deferred.
      expect(pending.days.indexOf(HOLE_OLD)).toBeLessThan(
        pending.days.indexOf(HOLE_NEW),
      )
    })

    it('rebuilds the days that are behind and names the ones with nothing', async () => {
      for (const day of [...FIXTURE_DAYS, beyondTheWindow()]) {
        await clearDay(day)
      }
      await seedHoles()

      const result = await aggregatePending(NOW)

      expect(result.aggregated).toContain(HOLE_OLD)
      expect(result.aggregated).toContain(HOLE_NEW)
      // Nothing happened on those two, and a day that had nothing is reported
      // rather than written as a zero row.
      expect(result.empty).toContain(TODAY)
      expect(result.empty).toContain(YESTERDAY)
      // A day is rebuilt or it was empty. Both is a double count.
      expect(result.aggregated.filter((day) => result.empty.includes(day))).toEqual([])

      expect(await dailyRows(HOLE_OLD)).toMatchObject([
        { path: HOLE_PATH, views: 3, visitors: 2 },
      ])
      expect(await dailyRows(HOLE_NEW)).toMatchObject([
        { path: HOLE_PATH, views: 1, visitors: 1 },
      ])
      // Aggregating reads the raw events. Retention is what deletes them.
      expect(await rawCount(HOLE_OLD)).toBe(3)
      expect(await rawCount(HOLE_NEW)).toBe(1)

      // Today was not rolled up — there was nothing to roll up — so it has no
      // rows at all rather than an empty set of them.
      expect(await dailyRows(TODAY)).toEqual([])
    })

    it('sums what the days it rebuilt produced', async () => {
      // These are the numbers an operator reads in the job list, so they have
      // to be the day's totals and not, say, the number of days touched.
      await clearDay(YESTERDAY)
      await seedHoles()

      expect(await aggregateDays([HOLE_OLD, HOLE_NEW, YESTERDAY])).toEqual({
        aggregated: [HOLE_OLD, HOLE_NEW],
        empty: [YESTERDAY],
        rows: 2,
        views: 4,
        visitors: 3,
      })

      // A run with nothing to do is a run with nothing to do, not an error.
      expect(await aggregateDays([])).toEqual({
        aggregated: [],
        empty: [],
        rows: 0,
        views: 0,
        visitors: 0,
      })
    })
  })

  /* ------------------------------------------------------------------------ */
  /*  Collection                                                              */
  /* ------------------------------------------------------------------------ */

  describe('recordPageView', () => {
    it('writes no raw events after the administrator disables collection', async () => {
      const previous = env.ANALYTICS_ENABLED
      const [beforeSettings] = await db.select().from(siteSettings).where(eq(siteSettings.id, 'default'))
      env.ANALYTICS_ENABLED = true
      try {
        await db.insert(siteSettings).values({ id: 'default', analyticsEnabled: false })
          .onConflictDoUpdate({ target: siteSettings.id, set: { analyticsEnabled: false } })
        const before = await rawCount(utcDay())
        await expect(recordPageView(beaconRequest({ path: RECORDED_PATH })))
          .resolves.toEqual({ recorded: false, reason: 'disabled' })
        expect(await rawCount(utcDay())).toBe(before)
      } finally {
        env.ANALYTICS_ENABLED = previous
        if (beforeSettings) {
          await db.update(siteSettings).set({ analyticsEnabled: beforeSettings.analyticsEnabled })
            .where(eq(siteSettings.id, 'default'))
        } else {
          await db.delete(siteSettings).where(eq(siteSettings.id, 'default'))
        }
      }
    })
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
