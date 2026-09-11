'use client'

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { ContentStatus, ContentType } from '@/lib/content/schema'
import { bulkContentAction, deleteContentAction } from '@/app/admin/actions/content'
import { ActionButton } from './action-button'
import { ConfirmAction } from './confirm-action'
import { StatusBadge } from './status-badge'

/**
 * The document list.
 *
 * A client component because selection is client state, but the rows arrive as
 * plain data rather than as rendered children: one request renders the list and
 * the bulk bar together, and a selected row does not cost a round trip.
 */

export interface ContentListRow {
  path: string
  slug: string
  title: string
  status: ContentStatus
  category: string | null
  tags: string[]
  updatedAt: string
  publishedAt: string | null
  viewCount: number
  wordCount: number
}

/** Dates render as their UTC day: identical on the server and in the browser. */
function day(iso: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

export function ContentList({
  type,
  segment,
  rows,
}: {
  type: ContentType
  /** URL segment of the type (`posts`), used to build the public link. */
  segment: string
  rows: ContentListRow[]
}) {
  // Built here rather than passed down: a function prop cannot cross from a
  // Server Component into a Client Component, and a string prefix can.
  const publicHref = (slug: string) => `/${segment}/${encodeURIComponent(slug)}`
  const [selected, setSelected] = useState<string[]>([])
  const [tag, setTag] = useState('')

  const allSelected = rows.length > 0 && selected.length === rows.length
  const clear = () => setSelected([])

  return (
    <div className="flex flex-col gap-4">
      {/*
        A live region, so a screen reader learns that the bulk actions exist the
        moment a row is selected rather than having to hunt for them.
      */}
      <div aria-live="polite" className="min-h-9">
        {selected.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-ink-muted">
              {selected.length} selected
              <button
                type="button"
                onClick={clear}
                className="ml-2 underline decoration-line-strong underline-offset-2 hover:decoration-ink"
              >
                Clear
              </button>
            </p>

            <ActionButton
              action={bulkContentAction}
              payload={{ paths: selected, action: 'publish' as const }}
              label="Publish"
              variant="outline"
              onSuccess={(data) => {
                reportBulk(data)
                clear()
              }}
            />
            <ActionButton
              action={bulkContentAction}
              payload={{ paths: selected, action: 'unpublish' as const }}
              label="Unpublish"
              variant="outline"
              onSuccess={(data) => {
                reportBulk(data)
                clear()
              }}
            />

            <span className="flex items-center gap-2">
              <Input
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                placeholder="tag name"
                aria-label={`Tag to add to the selected ${type}s`}
                className="h-8 w-40 text-sm"
              />
              <ActionButton
                action={bulkContentAction}
                payload={{ paths: selected, action: 'add-tag' as const, tag: tag.trim() }}
                label="Add tag"
                variant="outline"
                disabled={tag.trim() === ''}
                onSuccess={(data) => {
                  reportBulk(data)
                  setTag('')
                }}
              />
            </span>

            <ConfirmAction
              action={bulkContentAction}
              payload={{ paths: selected, action: 'delete' as const }}
              triggerLabel="Delete"
              triggerVariant="outline"
              title={`Delete ${selected.length} document${selected.length === 1 ? '' : 's'}?`}
              confirmLabel="Delete permanently"
              onSuccess={(data) => {
                reportBulk(data)
                clear()
              }}
              description={
                <>
                  <p>
                    Each file is removed from disk and its index row is deleted. The articles stop
                    being served immediately.
                  </p>
                  <p className="mt-2">
                    Their revision histories are deleted with them, so this cannot be undone from
                    the admin. Recovery means restoring the files from git or a backup.
                  </p>
                </>
              }
            />
          </div>
        ) : (
          <p className="text-sm text-ink-subtle">
            {rows.length === 0 ? 'No documents match.' : 'Select rows to act on them in bulk.'}
          </p>
        )}
      </div>

      <div className="overflow-x-auto border-y border-line">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            {type}s with status, taxonomy and counts
          </caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="w-8 py-2 pr-2">
                <Checkbox
                  aria-label={allSelected ? 'Clear selection' : 'Select all rows'}
                  checked={allSelected}
                  onCheckedChange={(value) =>
                    setSelected(value === true ? rows.map((row) => row.path) : [])
                  }
                />
              </th>
              <th scope="col" className="py-2 pr-4 font-medium text-ink-muted">
                Title
              </th>
              <th scope="col" className="hidden py-2 pr-4 font-medium text-ink-muted sm:table-cell">
                Status
              </th>
              <th scope="col" className="hidden py-2 pr-4 font-medium text-ink-muted lg:table-cell">
                Taxonomy
              </th>
              <th scope="col" className="hidden py-2 pr-4 font-medium text-ink-muted md:table-cell">
                Updated
              </th>
              <th
                scope="col"
                className="hidden py-2 pr-4 font-medium text-ink-muted md:table-cell"
              >
                Published
              </th>
              {/*
                `title` because the number needs a scope and the column has no
                room for one: the analytics page reports views *in a range*, and
                this reports all of them. Left unsaid, the two look like they
                disagree about a document.
              */}
              <th
                scope="col"
                title="Views, all time — from the daily analytics totals"
                className="hidden py-2 pr-4 text-right font-medium text-ink-muted sm:table-cell"
              >
                Views
              </th>
              <th scope="col" className="py-2 pl-4 text-right font-medium text-ink-muted">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const editHref = `/admin/${type}s/${row.slug}/edit`
              return (
                <tr key={row.path} className="align-top">
                  <td className="py-3 pr-2">
                    <Checkbox
                      aria-label={`Select ${row.title || row.slug}`}
                      checked={selected.includes(row.path)}
                      onCheckedChange={(value) =>
                        setSelected((current) =>
                          value === true
                            ? [...new Set([...current, row.path])]
                            : current.filter((entry) => entry !== row.path),
                        )
                      }
                    />
                  </td>
                  <td className="min-w-0 py-3 pr-4">
                    <Link href={editHref} className="block font-medium text-ink hover:underline">
                      {row.title || '(untitled)'}
                    </Link>
                    <p className="mt-0.5 font-mono text-xs text-ink-subtle">/{row.slug}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                      <StatusBadge status={row.status} />
                      <span className="text-xs text-ink-subtle">{row.wordCount} words</span>
                    </p>
                  </td>
                  <td className="hidden py-3 pr-4 sm:table-cell">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="hidden py-3 pr-4 lg:table-cell">
                    <span className="block text-xs text-ink-muted">{row.category ?? '—'}</span>
                    {row.tags.length > 0 ? (
                      <span className="mt-0.5 block font-mono text-xs text-ink-subtle">
                        {row.tags.map((name) => `#${name}`).join(' ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden py-3 pr-4 text-xs tabular text-ink-muted md:table-cell">
                    <time dateTime={row.updatedAt}>{day(row.updatedAt)}</time>
                  </td>
                  <td className="hidden py-3 pr-4 text-xs tabular text-ink-muted md:table-cell">
                    <time dateTime={row.publishedAt ?? undefined}>{day(row.publishedAt)}</time>
                  </td>
                  <td className="hidden py-3 pr-4 text-right text-xs tabular text-ink-muted sm:table-cell">
                    {row.viewCount}
                  </td>
                  <td className="py-3 pl-4">
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={editHref}>Edit</Link>
                      </Button>
                      {row.status === 'published' ? (
                        <Button asChild variant="ghost" size="sm">
                          <a href={publicHref(row.slug)}>View</a>
                        </Button>
                      ) : null}
                      <ConfirmAction
                        action={deleteContentAction}
                        payload={{ path: row.path }}
                        triggerLabel="Delete"
                        successMessage="Document deleted"
                        triggerVariant="ghost"
                        title={`Delete “${row.title || row.slug}”?`}
                        confirmLabel="Delete permanently"
                        description={
                          <>
                            <p>
                              The file is removed from disk and its index row is deleted, so the
                              article stops being served immediately.
                            </p>
                            <p className="mt-2">
                              Its revision history is deleted with it — revisions cascade from the
                              content row — so this cannot be undone from the admin.
                            </p>
                            <p className="mt-2">
                              To take it off the site without destroying it, set its status to{' '}
                              <span className="font-mono">archived</span> instead.
                            </p>
                          </>
                        }
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface BulkReportShape {
  action: string
  changed: { path: string; slug: string; note?: string }[]
  failed: { path: string; error: string }[]
}

/**
 * Report a bulk run in terms of what happened, not what was attempted.
 *
 * Each document is written on its own, so a partial result is a real outcome:
 * "12 of 14 changed, these two did not, here is why" is the only statement that
 * is true, and the only one an operator can act on.
 */
function reportBulk(data: unknown): void {
  const report = asReport(data)
  if (!report) {
    toast.success('Done.')
    return
  }

  const skipped = report.changed.filter((entry) => entry.note).length
  const applied = report.changed.length - skipped

  if (report.failed.length === 0) {
    toast.success(
      `${applied} document${applied === 1 ? '' : 's'} ${pastTense(report.action)}` +
        (skipped > 0 ? `, ${skipped} already in that state.` : '.'),
    )
    return
  }

  toast.warning(`${applied} ${pastTense(report.action)}, ${report.failed.length} failed.`, {
    description: report.failed
      .slice(0, 3)
      .map((entry) => `${entry.path}: ${entry.error}`)
      .join(' · '),
  })
}

function asReport(data: unknown): BulkReportShape | null {
  if (typeof data !== 'object' || data === null) return null
  const candidate = data as Partial<BulkReportShape>
  if (!Array.isArray(candidate.changed) || !Array.isArray(candidate.failed)) return null
  return {
    action: typeof candidate.action === 'string' ? candidate.action : '',
    changed: candidate.changed,
    failed: candidate.failed,
  }
}

function pastTense(action: string): string {
  switch (action) {
    case 'publish':
      return 'published'
    case 'unpublish':
      return 'unpublished'
    case 'delete':
      return 'deleted'
    case 'add-tag':
      return 'tagged'
    default:
      return 'updated'
  }
}
