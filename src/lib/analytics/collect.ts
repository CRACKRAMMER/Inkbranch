import 'server-only'
import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { env, siteOrigin } from '@/env'
import { parseInternalTarget } from '@/lib/content/links'
import { db } from '@/lib/db'
import { analyticsEvents, contentIndex, type DeviceType } from '@/lib/db/schema'
import { MAX_DURATION_MS, MAX_REFERRER_LENGTH, NAVIGATION_TYPES, type BeaconPayload } from './beacon'
import { utcDay } from './day'

/**
 * Page-view collection.
 *
 * A cookieless-by-default beacon. The client sends three optional fields — the
 * page that linked here, how long the reader stayed, and how they arrived — and
 * nothing else, because everything else is either derivable from the request or
 * is something this project does not want to know:
 *
 * - **No address, ever.** No header carrying one is read. `x-forwarded-for`,
 *   `x-real-ip` and the socket are not consulted, so there is nothing to strip
 *   later and nothing to get wrong in a debug branch.
 * - **No full referrer.** Only the host survives. A referrer is very often a
 *   search results page, and the query string in it is what the reader typed.
 * - **No user agent.** It is read to classify the device and to spot crawlers,
 *   then dropped: not stored, not hashed, not logged.
 * - **No durable identity.** Unique visitors are counted with a random value in
 *   a first-party cookie that expires at UTC midnight — not a fingerprint, not
 *   anything derived from the machine, nothing that survives the day.
 *
 * The beacon contract is `beaconSchema` below, which is built from the shape in
 * `./beacon` — the one module the browser and the server both import, and the
 * only place the two halves of the contract are written down. It is deliberately
 * strict: a payload this server does not recognise is dropped, because a dropped
 * beacon is invisible while a half-understood one is a wrong number on a
 * dashboard.
 */

/* -------------------------------------------------------------------------- */
/*  Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Column width of `analytics_events.path`. */
const MAX_PATH_LENGTH = 512
/** Column width of `referrer_domain`; a DNS name cannot exceed 253 characters. */
const MAX_DOMAIN_LENGTH = 255
/**
 * A body larger than this is not a beacon.
 *
 * `MAX_REFERRER_LENGTH` and `MAX_DURATION_MS` are not here: they belong to the
 * shape the client has to respect before it sends, so they live in `./beacon`
 * with the rest of the contract.
 */
const MAX_BEACON_BYTES = 4096

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/* -------------------------------------------------------------------------- */
/*  The beacon                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the client is allowed to say.
 *
 * Strict rather than lenient: an unknown key means the client and this server
 * disagree about the contract, and there is no honest way to guess what an
 * unknown field meant. The cost is that a stale client's beacons are dropped
 * until its bundle is replaced, which is the failure this endpoint is allowed to
 * have.
 *
 * `satisfies` rather than a declared type, so the schema's inferred type is what
 * `BeaconPayload` means while the shared interface is still checked against it
 * here: a field added to the contract in `./beacon` but not accepted below
 * becomes a compile error in this file, rather than a beacon the client sends
 * and the server drops for the rest of the deployment's life.
 */
export const beaconSchema = z.strictObject({
  /** `document.referrer`: the page that linked here, if any. */
  referrer: z.string().max(MAX_REFERRER_LENGTH).optional(),
  /** Milliseconds the page was visible. Bounded by the schema, never trusted. */
  durationMs: z.number().int().min(0).max(MAX_DURATION_MS).optional(),
  navigationType: z.enum(NAVIGATION_TYPES).optional(),
}) satisfies z.ZodType<BeaconPayload>

/** The part of a page view that can be derived without touching the database. */
export interface CollectedPageView {
  path: string
  referrerDomain: string
  device: HumanDevice
  navigationType: string
  durationMs: number
}

export type PageViewDropReason =
  | 'disabled'
  | 'invalid-payload'
  | 'no-path'
  | 'bot'
  | 'error'

export type CollectionResult =
  | { ok: true; view: CollectedPageView }
  | { ok: false; reason: PageViewDropReason }

/* -------------------------------------------------------------------------- */
/*  Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a URL path to the one string the tables store.
 *
 * The query is dropped because it is not part of a path: `/posts/x?utm_source=x`
 * and `/posts/x` are one page, and keeping it would split a single article into
 * a row per campaign. The fragment is dropped for the reason it is never sent to
 * a server in the first place. One trailing slash is removed because `/posts/x`
 * and `/posts/x/` are the same page in every router this site uses, while the
 * root stays `/`.
 *
 * Nothing else is touched. Path segments are never collapsed or dropped, so
 * `/posts/a/b` stays `/posts/a/b` and keeps failing on its own row — that row is
 * how a broken link gets noticed. The path stays percent-encoded exactly as the
 * browser sent it: decoding `%2F` would turn a separator back on and merge two
 * different routes into one.
 *
 * `null` means "not a usable path", which the caller treats as a dropped beacon.
 */
export function normalizePath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const pathOnly = (trimmed.split('#')[0] ?? '').split('?')[0] ?? ''
  // Repeated slashes name the same resource in HTTP, so they are folded.
  const collapsed = pathOnly.replace(/\/{2,}/g, '/')
  const path = collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed

  if (!path || path.length > MAX_PATH_LENGTH) return null
  if (CONTROL_CHARS.test(path)) return null

  return path
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    // A referrer that is not a URL at all — a bare word, a relative path, a
    // header truncated by a proxy — has no host or path worth keeping.
    return null
  }
}

/** Lowercase, without a trailing dot or a leading `www.`. */
function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

function isSameOrigin(url: URL, origin: string): boolean {
  const site = parseUrl(origin)
  if (!site) return false
  return (
    url.protocol === site.protocol &&
    canonicalHost(url.hostname) === canonicalHost(site.hostname)
  )
}

/**
 * The page a beacon was sent from, read from the beacon request's own
 * `Referer`.
 *
 * The client is not asked for its path and would not be believed if it were:
 * the browser already reports the page URL here, and a client-supplied path is a
 * value the client chooses. A beacon with no usable referrer is dropped rather
 * than recorded as `/` — an unattributable view is not a view of the home page,
 * and counting it as one is how a dashboard's busiest page becomes a page nobody
 * read.
 *
 * `www.` and case are ignored on both sides, so a beacon from
 * `https://www.example.com/posts/x` counts for a site configured as
 * `https://example.com`. Anything else — a preview deployment, a proxy on
 * another host — is a different origin and is dropped.
 */
export function pathFromReferer(
  referer: string | null,
  origin: string = siteOrigin,
): string | null {
  const url = parseUrl(referer)
  if (!url) return null
  if (!isSameOrigin(url, origin)) return null
  return normalizePath(url.pathname)
}

/**
 * The host of an external referrer, or `''` when there is not one.
 *
 * Only the host is kept. The full URL is not stored and not looked at further,
 * because a referrer is very often a search results page whose query string is
 * the reader's search terms.
 *
 * `''` covers every case that is not an external web referrer: no referrer at
 * all, a same-origin one, a scheme that is not HTTP, or a value that is not a
 * URL. An internal referrer is not a referrer in the sense this column means — a
 * reader moving from `/posts/a` to `/posts/b` was not referred by the site they
 * are already on, and counting it would put the site's own domain at the top of
 * its own referrer list, which is the most common way this number is read wrong.
 */
export function referrerHost(
  referrer: string | null | undefined,
  origin: string = siteOrigin,
): string {
  const url = parseUrl(referrer)
  if (!url) return ''
  // Only pages refer. `mailto:`, `android-app:` and friends leave the reader in
  // a client, not on a host that can be named and visited.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (isSameOrigin(url, origin)) return ''

  // The port is not part of a domain and would split one referrer into two rows.
  const host = canonicalHost(url.hostname)

  // A referrer whose host is a bare address is dropped rather than stored: an
  // address is not a domain, no reader navigated to it by name, and the one
  // thing that must never end up in a column is an address.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return ''
  if (!host || host.length > MAX_DOMAIN_LENGTH) return ''

  return host
}

/* -------------------------------------------------------------------------- */
/*  User agent                                                                 */
/* -------------------------------------------------------------------------- */

/** Device classes a reader can be in. Crawlers are dropped, not labelled. */
export type HumanDevice = Exclude<DeviceType, 'bot'>

export interface UserAgentInfo {
  device: HumanDevice
  bot: boolean
}

/**
 * Bot detection, best effort.
 *
 * Short on purpose. A long list of exotic crawlers is a maintenance burden that
 * still misses the next one, while these cover the families that actually visit
 * a blog, and every one of them is a token a crawler cannot help advertising.
 * `bot\b` carries the whole `*bot` family — Googlebot, bingbot, GPTBot — and,
 * like every analytics package that uses it, also matches any word ending in
 * "bot": the `Cubot` phone brand is the known false positive, accepted rather
 * than special-cased.
 *
 * A user agent is a claim, not a fact, so none of this is a security control. It
 * decides whether a beacon is counted, and that is all it decides.
 */
const BOT_PATTERN =
  /bot\b|crawler|spider|slurp|headless|externalhit|preview|monitor|uptime|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\/|lighthouse|pagespeed/i

/**
 * iPadOS reports itself as `Macintosh` in Safari, so a tablet running it is
 * counted as a desktop. Nothing in the header tells the two apart, and the
 * beacon is not asked to report its own class, because that is a value the
 * client chooses.
 */
const TABLET_PATTERN = /ipad|tablet|playbook|silk|android(?!.*mobile)/i
const MOBILE_PATTERN =
  /mobi|iphone|ipod|android|windows phone|blackberry|opera mini|iemobile|kaios/i
const DESKTOP_PATTERN =
  /windows nt|macintosh|mac os x|x11|cros|linux|freebsd|openbsd|sunos/i

/** Device class and crawler flag, both from the user agent, both best effort. */
export function classifyUserAgent(
  userAgent: string | null | undefined,
): UserAgentInfo {
  const ua = userAgent ?? ''
  const bot = BOT_PATTERN.test(ua)

  // Tablets before phones: an Android tablet is where the two patterns overlap,
  // and it is the case that matters, since a phone UA is the one that adds
  // `Mobile`.
  if (TABLET_PATTERN.test(ua)) return { device: 'tablet', bot }
  if (MOBILE_PATTERN.test(ua)) return { device: 'mobile', bot }
  if (DESKTOP_PATTERN.test(ua)) return { device: 'desktop', bot }

  // A missing or unrecognised user agent is not evidence of a crawler: a privacy
  // tool strips it for a reader. It lands in `other`, which is what the column is
  // for.
  return { device: 'other', bot }
}

/* -------------------------------------------------------------------------- */
/*  Visitor identity                                                           */
/* -------------------------------------------------------------------------- */

/** The first-party cookie that makes one reader one visitor for one day. */
export const VISITOR_COOKIE_NAME = 'myblog_vid'

/** 16 random bytes, hex — the only shape this module accepts or mints. */
const VISITOR_VALUE_PATTERN = /^[0-9a-f]{32}$/

/** A fresh visitor value. Random, with nothing about the machine in it. */
export function mintVisitorValue(): string {
  return randomBytes(16).toString('hex')
}

function decodeCookieValue(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    // A `%` that begins no escape sequence is a malformed cookie, not a value to
    // guess at.
    return null
  }
}

/**
 * Read our visitor cookie out of a `Cookie` header.
 *
 * Returns `null` for anything that is not exactly the value this module mints,
 * so a cookie left by an older name, a truncated copy or another application on
 * the same host is replaced instead of being hashed into the day's visitor
 * counts.
 */
export function readVisitorCookie(
  cookieHeader: string | null | undefined,
  name: string = VISITOR_COOKIE_NAME,
): string | null {
  if (!cookieHeader) return null

  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== name) continue

    const value = decodeCookieValue(pair.slice(separator + 1).trim())
    return value && VISITOR_VALUE_PATTERN.test(value) ? value : null
  }

  return null
}

/**
 * The per-day visitor identifier stored on an event.
 *
 * The input is the cookie's random value and nothing else: no address, no user
 * agent, no fingerprint. The day is inside the digest, so the same cookie hashes
 * differently tomorrow and yesterday's rows cannot be joined to today's. Hashing
 * rather than storing the value verbatim means the database never holds
 * something that is also a live cookie.
 */
export function hashVisitor(
  value: string,
  day: string,
  secret: string = env.SESSION_SECRET,
): string {
  return createHmac('sha256', secret)
    .update(`analytics:${day}:${value}`)
    .digest('hex')
}

/**
 * Seconds from `now` until the next UTC midnight.
 *
 * This is the visitor cookie's `Max-Age`, and it is the same boundary the hash
 * uses: a reader is countable within the day they were seen and is a new visitor
 * tomorrow. No cookie written here outlives its day.
 */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

/** What the route handler must attach to the beacon response. */
export interface VisitorCookie {
  name: string
  value: string
  maxAge: number
  path: string
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
}

function visitorCookie(value: string, now: Date): VisitorCookie {
  return {
    name: VISITOR_COOKIE_NAME,
    value,
    maxAge: secondsUntilUtcMidnight(now),
    path: '/',
    // Only the server reads it, so the page cannot.
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
  }
}

/* -------------------------------------------------------------------------- */
/*  Collection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turn a beacon and its request headers into the fields of an event.
 *
 * Split out from `recordPageView` so the whole decision — which path, which
 * referrer, whether this is a crawler at all — is answerable without a database.
 */
export function collectPageView(
  headers: { referer: string | null; userAgent: string | null },
  beacon: BeaconPayload,
  origin: string = siteOrigin,
): CollectionResult {
  const path = pathFromReferer(headers.referer, origin)
  if (!path) return { ok: false, reason: 'no-path' }

  const agent = classifyUserAgent(headers.userAgent)
  // Crawlers are dropped at the door rather than stored with `device = 'bot'`.
  // The raw table exists to be summed into `analytics_daily`; a stored crawler
  // row would have to be excluded again by every query that reads it, and one
  // query that forgets is a dashboard that lies. Nothing else reads raw events,
  // so nothing is lost by not writing them.
  if (agent.bot) return { ok: false, reason: 'bot' }

  return {
    ok: true,
    view: {
      path,
      referrerDomain: referrerHost(beacon.referrer, origin),
      device: agent.device,
      navigationType: beacon.navigationType ?? 'navigate',
      durationMs: beacon.durationMs ?? 0,
    },
  }
}

export interface PageViewOutcome {
  recorded: boolean
  /** Why the beacon was dropped. Absent when it was recorded. */
  reason?: PageViewDropReason
  /** Set when the response must carry a new visitor cookie. */
  setVisitorCookie?: VisitorCookie
}

/** Whether this install records page views at all. */
export function analyticsEnabled(): boolean {
  return env.ANALYTICS_ENABLED
}

async function readBeacon(request: Request): Promise<BeaconPayload | null> {
  // A body larger than a beacon is refused before it is read. This only bounds
  // what the client declares — a chunked body declares nothing — but the
  // endpoint is public, and a request that overstates its own size is a probe
  // rather than a reader.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BEACON_BYTES) return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    // A body that is not JSON — an empty POST from a probe, a truncated request
    // — is a dropped beacon, not an error. It is not logged either: nobody can
    // act on it, and logging it would let a stranger fill the logs.
    return null
  }

  const parsed = beaconSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}

/**
 * The content row a path belongs to, or `null` when nothing matches.
 *
 * A miss is recorded, not rejected. A path with no document is either a 404 that
 * readers keep hitting or a document that has since been deleted, and both are
 * what `getTopContent` reports in its unresolved bucket instead of dropping.
 */
async function resolveContentId(path: string): Promise<string | null> {
  const target = parseInternalTarget(path)
  if (!target) return null

  const rows = await db
    .select({ id: contentIndex.id })
    .from(contentIndex)
    .where(
      and(eq(contentIndex.type, target.type), eq(contentIndex.slug, target.slug)),
    )
    .limit(1)

  return rows[0]?.id ?? null
}

/**
 * Record one page view from a beacon request.
 *
 * Takes the `Request` rather than parsed fields so that nothing derived from it
 * can be supplied by the caller: the path comes from the request's `Referer`, and
 * the device class and crawler decision come from its `User-Agent`.
 *
 * Never throws. A beacon arrives from a page the reader has already been given;
 * nobody should see a 500 or a retried request because the analytics behind it
 * were unhappy, so every failure ends as a dropped beacon with a reason. The one
 * thing that is logged is a database failure, because that is the operator's to
 * fix and nobody else can see it.
 */
export async function recordPageView(
  request: Request,
  now: Date = new Date(),
): Promise<PageViewOutcome> {
  // First statement in the function: with analytics off this must do no work at
  // all — no body read, no header read, no query — rather than write rows that
  // the read layer later filters out.
  if (!env.ANALYTICS_ENABLED) return { recorded: false, reason: 'disabled' }

  const beacon = await readBeacon(request)
  if (!beacon) return { recorded: false, reason: 'invalid-payload' }

  const collected = collectPageView(
    {
      referer: request.headers.get('referer'),
      userAgent: request.headers.get('user-agent'),
    },
    beacon,
  )
  if (!collected.ok) return { recorded: false, reason: collected.reason }

  const existing = readVisitorCookie(request.headers.get('cookie'))
  const value = existing ?? mintVisitorValue()
  // Taken once and used for both the hash and the cookie's lifetime, so the two
  // cannot disagree about which day this visitor belongs to.
  const day = utcDay(now)

  try {
    const contentId = await resolveContentId(collected.view.path)

    await db.insert(analyticsEvents).values({
      path: collected.view.path,
      contentId,
      referrerDomain: collected.view.referrerDomain,
      device: collected.view.device,
      // Written out rather than left to the column's default, because it is a
      // decision and not an omission. Filling it means reading the reader's
      // address, which this project does not do, and `project.md` lists the
      // field as optional — an empty column is the honest value, not a missing
      // feature. Nothing else inserts into this table, so every row is empty.
      country: '',
      navigationType: collected.view.navigationType,
      durationMs: collected.view.durationMs,
      visitorHash: hashVisitor(value, day),
    })
  } catch (error) {
    console.error(
      '[analytics] page view was not recorded:',
      error instanceof Error ? error.message : error,
    )
    return { recorded: false, reason: 'error' }
  }

  return {
    recorded: true,
    setVisitorCookie: existing ? undefined : visitorCookie(value, now),
  }
}
