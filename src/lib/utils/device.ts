/**
 * A user agent, said in words a person recognises.
 *
 * ## Why this exists at all
 *
 * The session list in settings shows one row per device, and a row has to say
 * which device it is. The stored value is the raw header, which is a hundred
 * and fifty characters of platform boilerplate wrapped around the two facts
 * that matter, and neither end of it is the informative one — truncation loses
 * whichever half you cut.
 *
 * ## What this is not
 *
 * The user agent is a claim the client makes, not a fact. It is not parsed here
 * for any security decision and must never be: everything this returns is a
 * label for a human, and the unrecognised branch is the correct answer for a
 * client that did not feel like identifying itself. The list's actual security
 * — which row gets signed out, and whether a row is really the caller's — rests
 * on the session id and the scoping of the delete, neither of which touches
 * anything in this file.
 *
 * ## The traps, which are why the order of the checks matters
 *
 * Every browser lies about being its ancestor, so the matching runs most
 * specific first and the patterns are the ones that name a browser rather than
 * the ones it claims:
 *
 *   - Edge and Opera both carry `Chrome/`, and all three carry `Safari/` — a
 *     naive search for "Chrome" reports Edge as Chrome, and one for "Safari"
 *     reports every browser on the web as Safari.
 *   - Chrome and Firefox on iOS carry `CriOS/` and `FxiOS/`, not `Chrome/` and
 *     `Firefox/`, and they too carry `Safari/` — as does every browser on iOS,
 *     since they are all WebKit.
 *   - An iPhone and an iPad report `like Mac OS X`, so the mobile platforms are
 *     checked before the desktop one or every iPhone reads as a Mac.
 *   - An Android phone reports `Linux`, for the same reason and with the same
 *     consequence.
 *
 * A UA that names no browser is not reported as an unknown browser on a known
 * system: the two are decided separately, and either half may be missing. The
 * caller joins whatever it gets.
 */

interface Pattern {
  label: string
  pattern: RegExp
}

/**
 * Browsers, most specific first. `Edg/` is Edge — the older `Edge/` spelling is
 * the pre-Chromium browser and carries neither `Chrome/` nor `Safari/`.
 */
const BROWSERS: Pattern[] = [
  { label: 'Edge', pattern: /Edg(?:e|A|iOS)?\// },
  { label: 'Opera', pattern: /OPR\/|Opera[ /]/ },
  { label: 'Samsung Internet', pattern: /SamsungBrowser\// },
  { label: 'Chrome', pattern: /CriOS\/|Chrome\/|Chromium\// },
  { label: 'Firefox', pattern: /FxiOS\/|Firefox\/|Firefox$/ },
  { label: 'Safari', pattern: /Safari\// },
]

/** Platforms, mobile and tablet first — see the traps above. */
const PLATFORMS: Pattern[] = [
  { label: 'iPhone', pattern: /iPhone/ },
  { label: 'iPad', pattern: /iPad/ },
  { label: 'Android', pattern: /Android/ },
  { label: 'Windows', pattern: /Windows|Win(?:dows )?Phone/ },
  { label: 'macOS', pattern: /Mac OS X|Macintosh/ },
  { label: 'ChromeOS', pattern: /CrOS/ },
  { label: 'Linux', pattern: /Linux|X11|FreeBSD|OpenBSD/ },
]

function firstMatch(patterns: Pattern[], userAgent: string): string | null {
  return patterns.find(({ pattern }) => pattern.test(userAgent))?.label ?? null
}

/**
 * The two halves, separately, each null when the header does not name it.
 *
 * Separate rather than a single formatted string so a caller can decide what to
 * do with a half it did not get — the session list prints the one it has.
 */
export function describeDevice(userAgent: string | null | undefined): {
  browser: string | null
  platform: string | null
} {
  if (!userAgent) return { browser: null, platform: null }

  return {
    browser: firstMatch(BROWSERS, userAgent),
    platform: firstMatch(PLATFORMS, userAgent),
  }
}

/**
 * The device as one line: "Chrome on Linux", "Safari on iPhone".
 *
 * A session with no user agent at all — a client that sent none — says so
 * rather than rendering as an empty cell, because "we were not told" and "we
 * were told something we did not recognise" are different facts and only one of
 * them is the operator's to act on.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unrecognised device'

  const { browser, platform } = describeDevice(userAgent)
  if (browser && platform) return `${browser} on ${platform}`
  if (browser) return browser
  if (platform) return platform
  return 'Unrecognised device'
}
