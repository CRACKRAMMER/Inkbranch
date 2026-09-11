---
title: Finding what actually filled the disk
date: 2026-08-30
updated: 2026-09-09
tags: [Linux, Systems]
category: Linux
---

`df -h` says the disk is full. It does not say *what* filled it, and the mental
model of "one big directory" is usually wrong — it is forty medium ones.

```sh terminal
du -xh --max-depth=1 / | sort -h | tail -20
```

- `-x` stays on one filesystem. Without it, `du` walks into every mount under
  the path and reports the total of an entirely different disk.
- `--max-depth=1` stops at one level. Full recursion takes minutes on a large
  tree and produces a wall of numbers nobody reads.
- `sort -h` sorts human-readable sizes, so `1.2G` lands after `900M`. Plain
  `sort` puts `1.2G` before `900M`, because `1` is less than `9`.

Then descend into the biggest and repeat.

## Deleted-but-open

A file that a process still holds open does not free its space when unlinked.
`du` cannot see it — there is no directory entry — but `df` counts it, so the
numbers disagree:

```sh terminal
lsof +L1          # unlinked files still open
```

Restarting the holder is the fix. Truncating the file is not, for anything that
has it mmapped.

## inodes

`df -i` when `df -h` shows free space but writes still fail with `ENOSPC`. A
directory with millions of tiny files exhausts inodes long before bytes.
