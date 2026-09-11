---
title: MyBlog
slug: myblog
description: The site you are reading. Markdown files as the source of truth, a Postgres index, and no CMS in the critical path.
date: 2026-09-11
started: 2026-06-01
tags: [Next.js, Postgres, TypeScript, Search]
category: Engineering
projectStatus: active
stack: [Next.js, TypeScript, PostgreSQL, Drizzle, Tailwind]
repo: https://github.com/example/myblog
featured: true
---

A personal site whose content lives in files. The database indexes them and
tracks state; it never holds an article.

## Why files

The alternative — a `posts` table with a `body text` column — is easier to
build and worse to own. The body ends up in exactly one place, that place is a
database, and getting it out again is a migration project rather than `cp -r`.
Files survive the framework. They diff, they grep, they move through `git` with
a history that says what changed and when.

The trade is real: every read has to resolve file to index row, and the two can
disagree. Most of the design below exists to make that disagreement impossible
to reach silently.

## The shape

```
content/
  posts/      bundles of writing
  notes/      short, continuously updated
  projects/   things that are built
```

Each file carries YAML frontmatter and a Markdown body. The body is rendered
per request — Shiki runs on the server, so syntax highlighting costs the client
nothing.

## What is hard about it

**Atomicity.** A save either replaces the file completely or leaves it alone.
There is no state in which the reader gets half a document. Temp file, `fsync`,
`rename`, directory `fsync`, plus a PID lock so a concurrent writer cannot
quietly win.

**Sync.** The index has to survive the file tree changing underneath it — a file
added in an editor, a rename, a deletion from the shell. `content:sync` walks
the tree, diffs against the index, and reports exactly what it changed.

**Search.** Local, in-process, BM25F over five weighted fields, with CJK bigram
tokenisation so Chinese queries are not silently zero-result. Written up in
[[searching-chinese]].

**Writes.** Every save goes through a temp file, an `fsync` on both the file and
the directory, and a `rename`. The details, and the failure modes that survive
even that, are in [[atomic-writes]].

## Stack

Next.js App Router with React Server Components first. Postgres through Drizzle.
Tailwind v4. Shiki, remark and rehype for the pipeline. Vitest and Playwright.
No client state library, because the pages that need state are few and small.

## What it is not

Not a platform. One author, no registration, no comments, no multi-tenancy.
Every one of those would be a reasonable thing to add and each would change what
the code has to do; leaving them out is what makes the rest of it small enough
to keep correct.
