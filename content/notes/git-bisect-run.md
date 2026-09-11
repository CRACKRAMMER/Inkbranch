---
title: git bisect run
date: 2026-09-08
updated: 2026-09-10
tags: [Git, Linux]
category: Engineering
---

`git bisect` is the manual version — you mark good and bad commits and check out
the middle by hand. `git bisect run` takes a command and does the checking
itself, which turns a twenty-step binary search into one command.

```sh
git bisect start
git bisect bad
git bisect good v2.3.0
git bisect run pnpm test -- --run tests/unit/parser.test.ts
```

Exit code 0 means good, 1–127 means bad, 125 means *skip this commit* — the
useful one. Skip is for a commit that cannot be tested (a broken build, a fix
that depends on a migration that has not run). Bisect moves on and accounts for
it rather than aborting.

## The part worth knowing

A test that fails for an unrelated reason poisons the search. If the suite has a
flaky test, bisect will happily report a flaky failure as the regression and you
will spend an afternoon on the wrong commit. Run the suspect test a few times on
`HEAD` first; if it is not reliably failing there, no bisect result means
anything.

`git bisect reset` when done — including after a failure, or the repo stays in
detached-HEAD bisect mode.

Note the cost is logarithmic: 1000 commits is 10 steps. It is almost always
faster than reading the log.
