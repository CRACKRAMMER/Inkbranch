---
date: 2026-04-11
updated: 2026-08-19
tags: [TypeScript, Engineering]
category: Engineering
---

`strict: true` is not one option, it is a bundle, and turning it on wholesale in
an existing project produces a wall of errors that makes it easy to give up.
The order below turns on the checks that find real bugs first.

## The ones that find bugs

`strictNullChecks` — the big one. Without it, `null` and `undefined` are
assignable to everything and every property access is a potential crash. This
is the option worth the entire migration cost on its own.

`noUncheckedIndexedAccess` — not in the `strict` bundle, and should be. Makes
`arr[0]` have type `T | undefined`, which is *true*, and which catches the
entire class of "the list was empty and we read the first element".

`noImplicitOverride` — forces `override` on a method that shadows a base class.
Cheap, and it catches the rename-the-base-method bug that otherwise fails
silently at runtime.

## The one people fight

`exactOptionalPropertyTypes` distinguishes `{ a?: string }` from
`{ a: string | undefined }`. It is correct and it is annoying: passing an
optional prop through requires `...(value !== undefined ? { a: value } : {})`
rather than `{ a: value }`. Worth it in a codebase that builds objects
conditionally; skip it in one that does not.

## The trap

Turning on `strict` in a project with `skipLibCheck: false` will surface errors
inside `node_modules` that you cannot fix. Set `skipLibCheck: true` and leave it
— you are not going to patch a dependency's types, and the check only re-verifies
what its authors already published.
