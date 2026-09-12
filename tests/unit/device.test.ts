import { describe, expect, it } from 'vitest'
import { describeDevice, deviceLabel } from '@/lib/utils/device'

/**
 * The device label on the session list.
 *
 * ## Why the assertions are these strings and not others
 *
 * Every user agent below is a real header, abbreviated only where the middle is
 * irrelevant. The interesting ones are the four that a naive parser gets wrong,
 * and each of them is here because the wrong answer is *plausible* rather than
 * obviously broken — Edge reporting as Chrome, an iPhone reporting as a Mac,
 * an Android phone reporting as Linux, and Safari reporting as the answer to
 * every browser on earth. A test that asserted only "Chrome on Linux" would
 * pass against a parser that had all four backwards, so the file is mostly
 * about the impostors.
 *
 * The labels are not a security control and nothing branches on them — see the
 * module doc in `src/lib/utils/device.ts`. What is asserted here is only that a
 * person reading the list gets the right two words.
 */

/** The four real headers the traps live in, plus the ordinary cases. */
const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
const FIREFOX_MACOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
const FIREFOX_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
const OPERA_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0'

describe('deviceLabel', () => {
  it('names the browser rather than the one it claims to be', () => {
    // Edge says Chrome and Safari; Opera says Chrome and Safari; Chrome on iOS
    // says Safari. Each of these would come out as the wrong browser from a
    // search for the most common token.
    expect(deviceLabel(EDGE_WINDOWS)).toBe('Edge on Windows')
    expect(deviceLabel(OPERA_WINDOWS)).toBe('Opera on Windows')
    expect(deviceLabel(CHROME_IOS)).toBe('Chrome on iPhone')
    expect(deviceLabel(FIREFOX_IPHONE)).toBe('Firefox on iPhone')

    // And the honest one, which claims all three tokens and is Chrome.
    expect(deviceLabel(CHROME_LINUX)).toBe('Chrome on Linux')
  })

  it('reads the phone out of a header that names a desktop in the middle', () => {
    // Both of these carry `like Mac OS X`, because that is what iOS reports.
    // A parser that checks for the desktop string first calls them Macs.
    expect(deviceLabel(SAFARI_IPHONE)).toBe('Safari on iPhone')

    // And this one carries `Linux`, because Android is Linux. Checking `Linux`
    // first calls a Pixel a desktop.
    expect(deviceLabel(CHROME_ANDROID)).toBe('Chrome on Android')
  })

  it('reads the ordinary desktop cases', () => {
    expect(deviceLabel(FIREFOX_MACOS)).toBe('Firefox on macOS')
  })

  it('answers with whichever half the header names', () => {
    // A client that names a platform and no browser still has a useful row.
    expect(deviceLabel('Mozilla/5.0 (compatible; SomeTool/1.0; Linux)')).toBe('Linux')

    // And one that names neither — a command-line client's own header, which is
    // exactly the shape of a session an owner did not create from a browser.
    expect(deviceLabel('curl/8.5.0')).toBe('Unrecognised device')
  })

  it('says it does not know rather than guessing', () => {
    // The two cases are different facts — a client that sent nothing and a
    // client that sent something unrecognisable — and both are the operator's
    // to read rather than a cell that looks broken.
    expect(deviceLabel(null)).toBe('Unrecognised device')
    expect(deviceLabel(undefined)).toBe('Unrecognised device')
    expect(deviceLabel('')).toBe('Unrecognised device')
    expect(deviceLabel('my-custom-client/2.1')).toBe('Unrecognised device')
  })

  it('reports the two halves separately for a caller that wants them', () => {
    expect(describeDevice(SAFARI_IPHONE)).toEqual({ browser: 'Safari', platform: 'iPhone' })
    expect(describeDevice('my-custom-client/2.1')).toEqual({ browser: null, platform: null })
  })
})
