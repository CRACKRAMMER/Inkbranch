---
title: An empty catch block is a claim that nothing can go wrong
date: 2026-05-19
updated: 2026-08-22
tags: [Engineering, TypeScript]
category: Engineering
---

```ts
try {
  await revalidateTag('content')
} catch {}
```

This reads as "I know this can fail and I have decided it does not matter". It
usually means "I hit an error I did not want to deal with at 1am".

The two are distinguishable, and the second one is the problem. If failure
genuinely does not matter, say so and say **why**, because the next reader has
no way to tell a deliberate swallow from an oversight:

```ts
try {
  await revalidateTag('content')
} catch (error) {
  // Revalidation needs a request context. This runs from CLI scripts too, and
  // by the time it is called the write has already committed — throwing here
  // would report a saved document as a failed one.
  logger.warn('cache not revalidated; pages may be stale', { error })
}
```

## Why it matters more than it looks

An empty `catch` deletes information at the exact point where the information
is rarest. The stack trace exists once, right there, and nothing else will ever
reconstruct it. Afterwards the only evidence is a symptom — stale pages, a
missing row — with no path back to the cause.

## The lint rule is not the point

`no-empty` catches `catch {}` and misses `catch { return null }`, which loses
the same information. The rule is a reminder, not the standard. The standard is:
every catch either **handles** the error, **rethrows** it, or **logs it with a
reason it was not fatal**. There is no fourth option, and `catch {}` is a
fourth option.

[[atomic-writes]] makes the same point about the write path: a failure the UI
can state precisely is worth more than one it merely survives.
