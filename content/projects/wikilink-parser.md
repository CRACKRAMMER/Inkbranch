---
title: wikilink
slug: wikilink-parser
description: A 400-line parser for [[wiki links]] that keeps the source positions, so an editor can underline broken links without re-parsing the file.
date: 2026-03-18
started: 2025-11-02
updated: 2026-05-04
tags: [TypeScript, Parsing, Markdown]
category: Engineering
projectStatus: maintained
stack: [TypeScript, remark]
repo: https://github.com/example/wikilink
---

Extracting `[[Target]]` from Markdown with a regular expression is easy and
wrong. It breaks on escaped brackets (`\[[not a link]]`), on code spans and
fenced blocks (where `[[x]]` is content, not a link), and on nested brackets
(`[[A [B] C]]`).

It also throws away the one thing an editor needs: **where the link was**.

## Positions, not just names

```ts
interface WikiLink {
  target: string
  alias: string | null
  anchor: string | null
  /** UTF-16 offset into the source string. */
  start: number
  end: number
}
```

With offsets, the editor can underline precisely the broken links, jump to
precisely the right column, and rewrite one link in place without touching a
byte elsewhere in the file. Without them, every one of those features is a
second parse and a search for the substring, which finds the wrong occurrence
the moment a document mentions the same target twice.

## Built on remark, not beside it

The parser is a remark plugin, so it inherits the parts that are genuinely hard
and would otherwise be reimplemented badly: code fences, escapes, HTML blocks
and the interaction between them. Running before the standard Markdown parser
would mean re-deriving all of that, and getting it subtly wrong in the cases
nobody tests.

## Resolution is separate

The parser reports what was written. Whether the target *exists* is a different
question, answered against the content index and cached per build. Keeping them
apart is what lets the same parser serve both the site (which resolves targets
to URLs) and the editor (which does not resolve anything and only reports).

## Status

Maintained, not growing. It does one thing, the test suite covers the escaping
and nesting cases with 60-odd fixtures, and the useful work now is refusing
feature requests that would make it a Markdown engine.
