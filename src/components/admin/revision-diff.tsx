import type { DiffResult } from '@/lib/revision/diff'
import { cn } from '@/lib/utils/cn'

/**
 * A line diff, rendered as a table.
 *
 * Two gutters, because a diff of a file that has two line-number spaces is how
 * you find the line you are about to edit. Additions and removals are marked by
 * a sign in the gutter as well as a background tint — the tint alone is a
 * distinction that disappears in a screenshot, in print, and for a reader who
 * cannot separate the two hues.
 */
export function RevisionDiff({ diff }: { diff: DiffResult }) {
  if (diff.entries.length === 0) {
    return (
      <p className="border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
        These two revisions are identical — there is nothing between them to show.
      </p>
    )
  }

  return (
    <div className="border border-line">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-sunken px-3 py-2 font-mono text-[11px] text-ink-muted">
        <span className="text-success">+{diff.stats.additions} added</span>
        <span className="text-danger">−{diff.stats.deletions} removed</span>
        <span>
          {diff.stats.oldLines} → {diff.stats.newLines} lines
        </span>
        {diff.strategy === 'coarse' ? (
          // Honest about the algorithm: past a couple of thousand lines the
          // minimal edit script is not worth its cost, and the hunk shown is a
          // whole replacement rather than a line-by-line account of the edit.
          <span title="The file is large enough that the diff reports the edit as one replacement">
            coarse diff
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <caption className="sr-only">
            Differences between the two revisions: added lines, removed lines and unchanged context
          </caption>
          <tbody>
            {diff.entries.map((entry, index) => (
              <tr
                key={`${entry.kind}-${index}-${entry.oldLine ?? ''}-${entry.newLine ?? ''}`}
                className={cn(
                  entry.kind === 'add' && 'bg-success/5',
                  entry.kind === 'remove' && 'bg-danger/5',
                )}
              >
                <td className="w-10 select-none border-r border-line px-2 text-right align-top text-ink-subtle">
                  {entry.oldLine ?? ''}
                </td>
                <td className="w-10 select-none border-r border-line px-2 text-right align-top text-ink-subtle">
                  {entry.newLine ?? ''}
                </td>
                <td className="w-6 select-none px-1 align-top text-center">
                  {entry.kind === 'add' ? (
                    <span className="text-success">+</span>
                  ) : entry.kind === 'remove' ? (
                    <span className="text-danger">−</span>
                  ) : null}
                </td>
                <td className="whitespace-pre-wrap break-words py-0.5 pr-3 align-top text-ink">
                  {entry.elided
                    ? `⋯ ${entry.elided} unchanged line${entry.elided === 1 ? '' : 's'} ⋯`
                    : entry.text || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
