---
title: Atomic File Writes, and Why rename() Is the Whole Trick
slug: atomic-writes
description: How to replace a file without ever leaving it half-written, why fsync sits on both sides of the rename, and the failure modes that survive even then.
date: 2026-09-11
tags: [Linux, Systems, Data]
category: Engineering
featured: true
---

A blog engine that stores its content as Markdown files has exactly one
unforgivable bug: corrupting a file the author spent an evening on. Everything
else is recoverable. That is not.

The naive save looks harmless:

```ts
await fs.writeFile(path, next)
```

It is not. `writeFile` opens with `O_TRUNC`, which discards the old contents
*before* writing the new ones. Two things can go wrong, and both are common:

- The process dies between the truncate and the write. The file is now empty.
- The write is partially flushed. The file is now half of one version and half
  of another, which for Markdown means a broken frontmatter fence and a document
  that no longer parses.

## The pattern

Write somewhere else, then move it into place. On POSIX, `rename(2)` is atomic:
readers see either the old file or the new one, and there is no instant at which
they see neither.

```ts title="src/lib/content/writer.ts" showLineNumbers {12-14}
async function writeAtomically(target: string, data: string): Promise<void> {
  const dir = path.dirname(target)
  const temp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`)

  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(data, 'utf8')
    // The data must reach the disk before the rename, or a crash can leave the
    // rename durable and the contents not.
    await handle.sync()
  } finally {
    await handle.close()
  }

  await fs.rename(temp, target)
}
```

The temp file is created in the *same directory*, not in `/tmp`. This is not
tidiness: `rename` is only atomic within a filesystem, and `/tmp` is routinely a
different mount. Across devices, `rename` fails with `EXDEV`, and the fallback
everyone reaches for — copy, then delete — is exactly the non-atomic behaviour
the whole exercise was meant to avoid.

## fsync is on both sides

Synchronising the file is the obvious half. The non-obvious half is the
directory:

```ts
// After the rename: without this the *directory entry* may not be durable,
// so a crash can leave the old name pointing at the old inode.
const dirHandle = await fs.open(dir, 'r')
try {
  await dirHandle.sync()
} finally {
  await dirHandle.close()
}
```

A directory is a file whose contents are its entries. `fsync` on it is what
makes the rename itself survive a power cut, as opposed to surviving a process
crash — a distinction that only matters when it matters.

:::warning[Not every filesystem honours this]
`rename` is atomic on ext4, XFS, Btrfs and APFS. It is *not* guaranteed on
network filesystems, and on some it is genuinely not atomic — NFSv3 in
particular. If `CONTENT_DIR` is a network mount, the pattern degrades to
"usually fine", and no amount of `fsync` fixes that.
:::

## What atomicity does not buy you

The rename guarantees the file is never *torn*. It guarantees nothing about
whether the new contents are what you meant to write. Two failure modes remain:

1. **A concurrent writer.** Two requests read, both modify, both rename. The
   second silently discards the first. Atomicity is about each write, not about
   the read-modify-write cycle around it.
2. **A logic error.** You computed the wrong next state. It lands cleanly and
   completely.

The first needs a lock, and the second needs revisions. Both are separate
mechanisms, sitting in front of the same primitive.

:::note[Optimistic concurrency, cheaply]
The lock this project uses is a file, created with `O_EXCL`, containing the
writer's *PID*. Stale locks are detected by asking whether that PID is still
alive rather than by a timeout — a timeout cannot tell "the holder is slow" from
"the holder is gone", and choosing wrong either blocks a save or breaks a lock
that was doing its job.
:::

## Failure is a state, not an exception

The important consequence for the UI: because the original file is untouched
until the rename succeeds, a failed save has a definite, statable outcome. Not
"something went wrong" but "your file was not modified" — which is what the
author actually needs to know before deciding whether to retry.

That is worth more than the atomicity itself. A save that fails loudly and
changes nothing is a nuisance. A save that fails quietly and changes something
is a data loss incident.

Which is the same argument as [[why-not-catch]], applied one level down. A
failure that is recorded as a failure can be acted on; a failure that is
swallowed has to be rediscovered from its symptoms.

This is the write path under [[MyBlog]] — see the project page for how the lock,
the revision store and the rename fit together.
