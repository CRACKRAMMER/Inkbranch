---
title: shell-history
slug: shell-history-viz
description: Six years of zsh history as a dependency graph, and the discovery that I typed the same eleven commands for most of it.
date: 2025-10-09
started: 2025-08-20
tags: [Linux, Data, Visualization]
category: Linux
projectStatus: experiment
stack: [Python, DuckDB, D3]
repo: https://github.com/example/shell-history
---

An experiment rather than a tool. `~/.zsh_history` accumulates for years and
nobody reads it; the premise was that there is a shape in it worth seeing.

## Parsing is most of the work

zsh's extended history format is not line-oriented in the way it looks:

```
: 1698765432:0;git commit -m "fix: handle the empty case
                          with a second line"
```

The timestamp prefix is on the first line, the command may span many, and
neither whitespace nor newlines delimit anything. A line-based parser gets
almost all of it right, which is the dangerous kind of right — it silently
merges the multi-line commands into the record after them.

The parse walks from each `: <ts>:<dur>;` marker to the next one. Roughly
200,000 commands, and about 3% of them are multi-line.

## What showed up

**The top eleven commands were 40% of everything.** `ls`, `cd`, `git status`,
`git diff`, `git add`, `rg`, `pnpm`, `cat`, `vim`, `docker`, `clear`. Six years
of terminal work, and the surface area is a dozen words.

**Directory transitions form a graph, and it has a hub.** The graph of `cd`
from one directory to the next is nearly a star, because almost every move goes
through the project root. Not surprising in hindsight. Not something I would
have guessed.

**The interesting tail is tiny.** Commands typed once are 61% of unique
commands and 4% of invocations. The tool was built to explore that tail and the
tail is where nothing happens.

## What it changed

Two things, neither of them the visualisation. I aliased the transitions that
dominated the graph, and I stopped trusting "I will remember this one-off
command" — it is written down now, in a file, because the data says I will not
run it twice.

## Status

Archived. It answered the question it was built to answer, the notebook runs,
and there is no version two. Left up because the parser is the reusable part
and someone with a large history may want it.
