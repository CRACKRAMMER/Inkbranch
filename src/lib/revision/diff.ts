/**
 * Line diff for revision comparison.
 *
 * Written here rather than taken from a package because the job is small and
 * exact: compare two versions of one Markdown file and never spend more memory
 * on it than the file itself needs. A dependency would bring a config surface
 * and a character-level diff nobody asked for.
 *
 * The exact pass is Hirschberg's divide-and-conquer LCS. It is the same O(n·m)
 * time as the textbook table, but the table is never materialised: each half is
 * scored with two rolling rows, so memory is O(min(n, m)) and a 2000-line
 * article costs a few kilobytes instead of a four-million-cell allocation on a
 * request thread.
 *
 * Above `MAX_EXACT_DIFF_LINES` on either side even that is more work than a
 * viewer can use, so the middle is reported as one replacement block between
 * the common prefix and suffix, and the result says `strategy: 'coarse'`. A
 * caller that shows diffs to a person should say so rather than present an
 * approximation as the edit that happened.
 */

export type DiffLineKind = 'context' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line number in the older text, null on an addition. */
  oldLine: number | null
  /** 1-based line number in the newer text, null on a removal. */
  newLine: number | null
  /**
   * Set on the placeholder that stands in for unchanged lines dropped from the
   * output. The line numbers are those of the first dropped line and `text` is
   * empty; the count is the only thing a viewer needs from it.
   */
  elided?: number
}

export interface DiffStats {
  additions: number
  deletions: number
  /** Unchanged lines present in `entries`. */
  context: number
  /** Unchanged lines replaced by a placeholder. */
  elided: number
  oldLines: number
  newLines: number
}

/**
 * `exact` is a minimal edit script. `coarse` trims the common prefix and
 * suffix and calls everything between them one replacement, so the line counts
 * are still right but the shape of a large edit is not.
 */
export type DiffStrategy = 'exact' | 'coarse'

export interface DiffResult {
  /**
   * Empty when the two texts are identical — there is nothing to show, and a
   * single "all lines unchanged" placeholder would read as a change.
   */
  entries: DiffLine[]
  stats: DiffStats
  strategy: DiffStrategy
}

/** Unchanged lines shown either side of a change. */
export const DIFF_CONTEXT_LINES = 3

/**
 * Line count above which the exact pass stops being worth its time. Both sides
 * are checked, so the worst case is bounded at roughly `2000 × 2000` line
 * comparisons — tens of milliseconds, and a few kilobytes of working memory.
 */
export const MAX_EXACT_DIFF_LINES = 2000

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export interface DiffOptions {
  /** Unchanged lines kept on each side of a change. */
  context?: number
}

export function diffLines(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): DiffResult {
  const contextLines = Math.max(0, options.context ?? DIFF_CONTEXT_LINES)
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  const strategy: DiffStrategy =
    oldLines.length > MAX_EXACT_DIFF_LINES || newLines.length > MAX_EXACT_DIFF_LINES
      ? 'coarse'
      : 'exact'

  const ops =
    strategy === 'exact'
      ? exactOps(oldLines, newLines)
      : coarseOps(oldLines, newLines)

  let additions = 0
  let deletions = 0
  let unchanged = 0
  for (const op of ops) {
    if (op.kind === 'add') additions += 1
    else if (op.kind === 'remove') deletions += 1
    else unchanged += 1
  }

  const stats: DiffStats = {
    additions,
    deletions,
    context: 0,
    elided: 0,
    oldLines: oldLines.length,
    newLines: newLines.length,
  }

  if (additions === 0 && deletions === 0) {
    return { entries: [], stats, strategy }
  }

  const collapsed = collapseContext(ops, contextLines)
  return {
    entries: collapsed.entries,
    stats: { ...stats, context: unchanged - collapsed.elided, elided: collapsed.elided },
    strategy,
  }
}

/* -------------------------------------------------------------------------- */
/*  Input normalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split text into lines, ignoring the two things that are not edits.
 *
 * CRLF and a lone CR become LF first, so a file saved on Windows does not
 * report every line as changed. A trailing newline is a convention rather than
 * a line of its own, so a file that gained or lost one at the end reports
 * nothing. An empty text is zero lines, not one empty line — otherwise
 * "cleared the file" and "emptied the file" would not compare equal.
 */
export function splitLines(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, '\n')
  if (normalised === '') return []
  const body = normalised.endsWith('\n') ? normalised.slice(0, -1) : normalised
  return body.split('\n')
}

/* -------------------------------------------------------------------------- */
/*  Exact diff                                                                 */
/* -------------------------------------------------------------------------- */

/** A diff entry before context collapsing. */
interface Op {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

function contextOp(text: string, oldIndex: number, newIndex: number): Op {
  return { kind: 'context', text, oldLine: oldIndex + 1, newLine: newIndex + 1 }
}

function addOp(text: string, newIndex: number): Op {
  return { kind: 'add', text, oldLine: null, newLine: newIndex + 1 }
}

function removeOp(text: string, oldIndex: number): Op {
  return { kind: 'remove', text, oldLine: oldIndex + 1, newLine: null }
}

function exactOps(oldLines: readonly string[], newLines: readonly string[]): Op[] {
  const ops: Op[] = []
  walk(oldLines, 0, oldLines.length, newLines, 0, newLines.length, ops)
  return ops
}

/**
 * Emit the edit script for one pair of ranges.
 *
 * The range is halved on the old side; the split point on the new side is the
 * one that maximises the two halves' combined LCS length, which is what makes
 * the two recursive results join into a globally minimal script.
 */
function walk(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  ops: Op[],
): void {
  if (aLo >= aHi) {
    for (let j = bLo; j < bHi; j += 1) ops.push(addOp(b[j] ?? '', j))
    return
  }

  if (bLo >= bHi) {
    for (let i = aLo; i < aHi; i += 1) ops.push(removeOp(a[i] ?? '', i))
    return
  }

  // Halving needs a floor of one line, so the last line is settled directly:
  // keep it if the new side still has it, otherwise remove it, and report the
  // rest of the new side as inserted.
  if (aHi - aLo === 1) {
    const text = a[aLo] ?? ''
    let hit = -1
    for (let j = bLo; j < bHi; j += 1) {
      if (b[j] === text) {
        hit = j
        break
      }
    }

    if (hit === -1) {
      ops.push(removeOp(text, aLo))
      for (let j = bLo; j < bHi; j += 1) ops.push(addOp(b[j] ?? '', j))
      return
    }

    for (let j = bLo; j < hit; j += 1) ops.push(addOp(b[j] ?? '', j))
    ops.push(contextOp(text, aLo, hit))
    for (let j = hit + 1; j < bHi; j += 1) ops.push(addOp(b[j] ?? '', j))
    return
  }

  const mid = aLo + ((aHi - aLo) >> 1)
  const forward = lcsRow(a, aLo, mid, b, bLo, bHi, false)
  const backward = lcsRow(a, mid, aHi, b, bLo, bHi, true)

  const width = bHi - bLo
  let split = 0
  let best = -1
  for (let k = 0; k <= width; k += 1) {
    const total = (forward[k] ?? 0) + (backward[width - k] ?? 0)
    if (total > best) {
      best = total
      split = k
    }
  }

  walk(a, aLo, mid, b, bLo, bLo + split, ops)
  walk(a, mid, aHi, b, bLo + split, bHi, ops)
}

/**
 * LCS lengths of one side of `a` against every prefix of `b[bLo, bHi)`.
 *
 * With `fromEnd`, both sides are read backwards, so index `j` of the result is
 * the LCS against the last `j` lines of `b`. Only the previous row is kept:
 * that is the whole trick, and it is why this costs two arrays rather than a
 * full table.
 */
function lcsRow(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  fromEnd: boolean,
): Int32Array {
  const width = bHi - bLo
  let previous = new Int32Array(width + 1)
  let current = new Int32Array(width + 1)

  const step = fromEnd ? -1 : 1
  const stop = fromEnd ? aLo - 1 : aHi

  for (let i = fromEnd ? aHi - 1 : aLo; i !== stop; i += step) {
    const text = a[i] ?? ''
    current[0] = 0
    for (let j = 1; j <= width; j += 1) {
      const other = fromEnd ? (b[bHi - j] ?? '') : (b[bLo + j - 1] ?? '')
      current[j] =
        text === other
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    const swap = previous
    previous = current
    current = swap
  }

  return previous
}

/* -------------------------------------------------------------------------- */
/*  Coarse diff                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Common prefix, one replacement block, common suffix.
 *
 * Weaker than the exact pass on purpose: for a file this large the alternative
 * is spending a request thread on a diff nobody will read line by line, and a
 * replacement block still tells the reader which region of the document moved.
 */
function coarseOps(a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = []

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  for (let k = 0; k < prefix; k += 1) ops.push(contextOp(a[k] ?? '', k, k))

  const oldEnd = a.length - suffix
  for (let i = prefix; i < oldEnd; i += 1) ops.push(removeOp(a[i] ?? '', i))

  const newEnd = b.length - suffix
  for (let j = prefix; j < newEnd; j += 1) ops.push(addOp(b[j] ?? '', j))

  for (let k = suffix; k > 0; k -= 1) {
    const oldIndex = a.length - k
    const newIndex = b.length - k
    ops.push(contextOp(a[oldIndex] ?? '', oldIndex, newIndex))
  }

  return ops
}

/* -------------------------------------------------------------------------- */
/*  Context collapsing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Keep `contextLines` of unchanged text around each change and replace the rest
 * of a long run with a placeholder. Without this, a one-word edit in a 3000-line
 * file returns 3000 entries and the edit is impossible to find.
 */
function collapseContext(
  ops: readonly Op[],
  contextLines: number,
): { entries: DiffLine[]; elided: number } {
  const entries: DiffLine[] = []
  let elided = 0
  let index = 0

  while (index < ops.length) {
    const op = ops[index]
    if (op === undefined) break

    if (op.kind !== 'context') {
      entries.push(op)
      index += 1
      continue
    }

    let runEnd = index
    while (runEnd < ops.length && ops[runEnd]?.kind === 'context') runEnd += 1
    const runLength = runEnd - index

    if (runLength <= contextLines * 2) {
      for (let k = index; k < runEnd; k += 1) {
        const line = ops[k]
        if (line) entries.push(line)
      }
    } else {
      for (let k = index; k < index + contextLines; k += 1) {
        const line = ops[k]
        if (line) entries.push(line)
      }

      // Both sides are numbered, so a placeholder for a run that only exists in
      // one of the two texts still reads correctly.
      const firstDropped = ops[index + contextLines]
      const dropped = runLength - contextLines * 2
      entries.push({
        kind: 'context',
        text: '',
        oldLine: firstDropped?.oldLine ?? null,
        newLine: firstDropped?.newLine ?? null,
        elided: dropped,
      })
      elided += dropped

      for (let k = runEnd - contextLines; k < runEnd; k += 1) {
        const line = ops[k]
        if (line) entries.push(line)
      }
    }

    index = runEnd
  }

  return { entries, elided }
}
