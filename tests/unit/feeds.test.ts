import { describe, expect, it } from 'vitest'

import { feedSlug } from '@/app/rss/_feeds'

/**
 * What a feed URL names.
 *
 * The one piece of the feed routes that is pure, and the one piece both topic
 * routes depend on: `/rss/linux.xml` and `/rss/category/linux.xml` read their
 * segment with this, so a rule that drifts here is a tag feed and a category
 * feed disagreeing about what a feed address looks like.
 *
 * Imported from the app directory rather than from `@/lib`, which is where it
 * lives and why: which segment names a topic is a property of the address, and
 * the address is the route's. The rest of `_feeds.ts` needs settings and the
 * index and is covered end to end, in `tests/e2e/feeds.spec.ts`.
 */

describe('feedSlug', () => {
  it('reads the topic out of a feed address', () => {
    expect(feedSlug('linux.xml')).toBe('linux')
    expect(feedSlug('docker-and-kubernetes.xml')).toBe('docker-and-kubernetes')
    // A category is a free-form string, so its probe arrives with whatever the
    // URL carried: a space, a CJK name, a dot that is not the suffix.
    expect(feedSlug('Network Debugging.xml')).toBe('Network Debugging')
    expect(feedSlug('网络.xml')).toBe('网络')
    expect(feedSlug('v1.2.xml')).toBe('v1.2')
  })

  it('refuses a segment that is not a feed address', () => {
    // The URL is not a feed, which is a different answer from a feed with
    // nothing in it: the first is a 404 and the second is an empty feed, and a
    // reader handed the second may unsubscribe from a topic that never existed.
    expect(feedSlug('linux')).toBeNull()
    expect(feedSlug('linux.rss')).toBeNull()
    expect(feedSlug('.xml')).toBeNull()
    expect(feedSlug('')).toBeNull()
  })

  it('does not decode what the router already decoded', () => {
    // Next hands a route the decoded segment, so `%20` here would be a literal
    // per-cent sign in the topic's name. Encoding is the caller's business:
    // `serveTopicFeed` is given the path it was reached by, and the pages that
    // link to a feed percent-encode the topic themselves.
    expect(feedSlug('Network%20Debugging.xml')).toBe('Network%20Debugging')
  })

  it('takes only the last suffix, so a topic may be called `xml`', () => {
    // The suffix is part of the address rather than an extension a client asks
    // for. A category genuinely called `linux.xml` is served from
    // `/rss/category/linux.xml.xml` — absurd, and better than a rule that
    // guesses which `.xml` was meant.
    expect(feedSlug('linux.xml.xml')).toBe('linux.xml')
    expect(feedSlug('xml.xml')).toBe('xml')
  })
})
