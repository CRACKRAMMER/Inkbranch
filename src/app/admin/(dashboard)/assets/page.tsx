import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth/session'
import { ASSET_TYPES, findUnusedAssets, listAssets, type AssetTypeFilter } from '@/lib/assets/manage'
import { formatDate } from '@/lib/utils/date'
import { getSettings } from '@/lib/settings'
import { InlineNote, Page, Section, Stat, StatCell, StatRow } from '@/components/admin/page'
import { CopyUrlButton, DeleteAssetButton } from '@/components/admin/asset-controls'
import { AssetUpload } from '@/components/admin/asset-upload'
import { Pagination } from '@/components/admin/pagination'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = { title: 'Assets' }

const PER_PAGE = 24

/**
 * The asset library.
 *
 * Every row is a file on disk with a row in `assets`; the database is the
 * manifest, which is why the list can show dimensions and sizes without touching
 * the filesystem. Thumbnails are the stored image itself at a fixed box rather
 * than a generated preview — the derivatives already exist, and a second
 * thumbnail cache would be another thing to keep in step with the originals.
 *
 * The unused view is deliberately a separate mode rather than a filter chip
 * beside the others: it is the only view whose purpose is deletion, and its rows
 * come from `findUnusedAssets`, which asks a different question — "does anything
 * point at this?" — than the type and search filters do.
 */
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()

  const query = await searchParams
  const single = (key: string): string | undefined => {
    const value = query[key]
    return Array.isArray(value) ? value[0] : value
  }

  const unusedView = single('view') === 'unused'
  const layout = single('layout') === 'list' ? 'list' : 'grid'
  const search = single('q')?.trim() || undefined
  const rawType = single('type')
  const type: AssetTypeFilter =
    rawType && (ASSET_TYPES as readonly string[]).includes(rawType)
      ? (rawType as AssetTypeFilter)
      : 'all'
  const page = clampPage(single('page'))

  const [{ items, total }, settings] = await Promise.all([
    listAssets({
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
      ...(search ? { search } : {}),
      type,
    }),
    getSettings(),
  ])

  const unused = unusedView ? await findUnusedAssets({ limit: 200 }) : null
  const context = { locale: settings.locale, timeZone: settings.timezone, now: new Date() }
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE))
  const bytes = items.reduce((sum, asset) => sum + asset.size, 0)

  function hrefFor(overrides: Record<string, string | undefined>): string {
    const params = new URLSearchParams()
    const base: Record<string, string | undefined> = {
      q: search,
      type: type === 'all' ? undefined : type,
      layout: layout === 'list' ? 'list' : undefined,
      page: page > 1 ? String(page) : undefined,
      ...overrides,
    }
    for (const [key, value] of Object.entries(base)) {
      if (value) params.set(key, value)
    }
    const suffix = params.toString()
    return suffix ? `/admin/assets?${suffix}` : '/admin/assets'
  }

  return (
    <Page
      title="Assets"
      description="Uploaded files, as the database records them. Deleting one here removes the row and the files on disk."
    >
      <StatRow>
        <StatCell>
          <Stat label="Files" value={total} note={search || type !== 'all' ? 'matching filters' : undefined} />
        </StatCell>
        <StatCell>
          <Stat label="On this page" value={formatBytes(bytes)} />
        </StatCell>
        <StatCell>
          <Stat label="Unused" value={unused ? unused.length : '—'} note={unused ? 'nothing points at them' : 'see the unused view'} />
        </StatCell>
        <StatCell>
          <Stat label="Largest here" value={formatBytes(Math.max(0, ...items.map((a) => a.size)))} />
        </StatCell>
      </StatRow>

      <Section title="Upload" description="Files are re-encoded where that helps and deduplicated by content hash.">
        <AssetUpload />
      </Section>

      <Section
        title={unusedView ? 'Unused assets' : 'Library'}
        description={
          unusedView
            ? 'Nothing in the index, in any frontmatter or in settings points at these files. Oldest first.'
            : 'Newest first. The grid shows the image; the list is easier to scan for a filename.'
        }
        actions={
          <>
            <Link
              href={
                unusedView
                  ? hrefFor({ view: undefined, page: undefined })
                  : hrefFor({ view: 'unused', page: undefined })
              }
              className="text-xs text-brand underline underline-offset-2"
            >
              {unusedView ? 'Back to the library' : 'Show unused'}
            </Link>
            {!unusedView ? (
              <Link
                href={hrefFor({ layout: layout === 'list' ? undefined : 'list', page: undefined })}
                className="text-xs text-ink-muted underline underline-offset-2 hover:text-brand"
              >
                {layout === 'list' ? 'Grid view' : 'List view'}
              </Link>
            ) : null}
          </>
        }
      >
        {!unusedView ? (
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-ink-muted">Search</span>
              <input
                name="q"
                defaultValue={search ?? ''}
                placeholder="Filename or alt text"
                className="h-9 w-56 rounded-md border border-input bg-transparent px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-ink-muted">Kind</span>
              <select
                name="type"
                defaultValue={type}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ASSET_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option === 'all' ? 'Any kind' : option}
                  </option>
                ))}
              </select>
            </label>
            {layout === 'list' ? <input type="hidden" name="layout" value="list" /> : null}
            <button
              type="submit"
              className="h-9 rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-sunken"
            >
              Apply
            </button>
            {search || type !== 'all' ? (
              <Link href="/admin/assets" className="pb-2 text-xs text-ink-muted hover:text-brand">
                Clear
              </Link>
            ) : null}
          </form>
        ) : null}

        {unusedView ? (
          unused && unused.length > 0 ? (
            <>
              <InlineNote tone="warning">
                These are candidates, not mistakes. An asset referenced only from a document that is
                not in the index — a file someone edited over SSH — looks unused here. Deleting one
                is still checked against every reference before it happens.
              </InlineNote>
              <AssetTable assets={unused} context={context} />
            </>
          ) : (
            <InlineNote>Nothing is unused. Every stored asset is referenced somewhere.</InlineNote>
          )
        ) : items.length === 0 ? (
          <InlineNote>
            {search || type !== 'all'
              ? 'No asset matches those filters.'
              : 'No assets have been uploaded yet. Drop a file above, or paste one into the editor.'}
          </InlineNote>
        ) : layout === 'list' ? (
          <AssetTable assets={items} context={context} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((asset) => (
              <figure key={asset.id} className="border border-line">
                <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-line bg-sunken">
                  {asset.mime.startsWith('image/') ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={asset.url}
                      alt={asset.alt ?? ''}
                      loading="lazy"
                      decoding="async"
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="font-mono text-xs text-ink-subtle">{asset.mime}</span>
                  )}
                </div>
                <figcaption className="space-y-1 p-2">
                  <Link
                    href={`/admin/assets/${asset.id}`}
                    className="block truncate text-sm text-ink hover:text-brand"
                    title={asset.filename}
                  >
                    {asset.filename}
                  </Link>
                  <p className="text-xs text-ink-subtle">
                    {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
                    {formatBytes(asset.size)}
                  </p>
                  {asset.alt ? (
                    <p className="line-clamp-2 text-xs text-ink-muted">{asset.alt}</p>
                  ) : (
                    <p className="text-xs text-ink-subtle">No alt text</p>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {!unusedView ? (
          <div className="mt-6">
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              noun="asset"
              hrefFor={(next) => hrefFor({ page: next > 1 ? String(next) : undefined })}
            />
          </div>
        ) : null}
      </Section>
    </Page>
  )
}

function AssetTable({
  assets,
  context,
}: {
  assets: {
    id: string
    filename: string
    url: string
    path: string
    mime: string
    size: number
    width: number | null
    height: number | null
    alt: string | null
    createdAt: Date
    variants: { format: string; url: string; size: number }[]
  }[]
  context: { locale: string; timeZone: string; now: Date }
}) {
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Stored assets with their dimensions, size and alt text</caption>
        <thead>
          <tr className="border-b border-line text-left">
            <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
              File
            </th>
            <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
              Dimensions
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium text-ink-muted">
              Size
            </th>
            <th scope="col" className="py-2 pr-3 font-medium text-ink-muted">
              Added
            </th>
            <th scope="col" className="py-2 text-right font-medium text-ink-muted">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.id} className="border-b border-line align-top last:border-0">
              <th scope="row" className="py-3 pr-3 text-left font-normal">
                <Link href={`/admin/assets/${asset.id}`} className="text-ink hover:text-brand">
                  {asset.filename}
                </Link>
                <span className="mt-0.5 block font-mono text-xs text-ink-subtle">{asset.mime}</span>
                {asset.variants.length > 0 ? (
                  <span className="mt-1 block">
                    {asset.variants.map((variant) => (
                      <Badge key={variant.format} variant="outline">
                        {variant.format} {formatBytes(variant.size)}
                      </Badge>
                    ))}
                  </span>
                ) : null}
              </th>
              <td className="py-3 pr-3 text-ink-muted">
                {asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'}
              </td>
              <td className="py-3 pr-3 text-right tabular-nums text-ink-muted">
                {formatBytes(asset.size)}
              </td>
              <td className="py-3 pr-3 text-ink-muted">
                {formatDate(asset.createdAt, context, 'short')}
              </td>
              <td className="py-3">
                <div className="flex flex-wrap items-start justify-end gap-1">
                  <CopyUrlButton url={asset.url} />
                  <DeleteAssetButton id={asset.id} filename={asset.filename} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function clampPage(value: string | undefined): number {
  const parsed = Number(value ?? 1)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.trunc(parsed))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
