import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ContentList, type ContentListRow } from '@/components/admin/content-list'
import { Pagination } from '@/components/admin/pagination'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { listAdminContent, listCategories, listTagOptions } from '@/lib/admin/queries'
import { TYPE_COPY, contentListHref, parseContentListParams, typeFromSegment } from '@/lib/admin/routes'
import { CONTENT_STATUSES } from '@/lib/content/schema'
import { requireUser } from '@/lib/auth/session'

/**
 * The document list for one type: `/admin/posts`, `/admin/notes`,
 * `/admin/projects`.
 *
 * One route rather than three near-identical ones. The three differ only in the
 * copy, the fields their editor shows and their public URL prefix, and all three
 * of those are already functions of the type everywhere else in the codebase.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>
}): Promise<Metadata> {
  const type = typeFromSegment((await params).type)
  return { title: type ? TYPE_COPY[type].plural : 'Content' }
}

export default async function ContentListPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()

  const segment = (await params).type
  const type = typeFromSegment(segment)
  if (!type) notFound()

  const copy = TYPE_COPY[type]
  const query = parseContentListParams(await searchParams)
  const base = `/admin/${segment}`

  const [page, categories, tagOptions] = await Promise.all([
    listAdminContent({
      type,
      ...(query.q ? { search: query.q } : {}),
      status: query.status,
      ...(query.category ? { category: query.category } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      sort: query.sort,
      page: query.page,
    }),
    listCategories(type),
    listTagOptions(),
  ])

  const rows: ContentListRow[] = page.items.map((item) => ({
    path: item.path,
    slug: item.slug,
    title: item.title,
    status: item.status,
    category: item.category,
    tags: item.tags.map((tag) => tag.name),
    updatedAt: item.updatedAt.toISOString(),
    publishedAt: (item.publishedAt ?? item.scheduledAt)?.toISOString() ?? null,
    viewCount: item.viewCount,
    wordCount: item.wordCount,
  }))

  const filtered = query.q || query.status !== 'all' || query.category || query.tag

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl tracking-tight text-ink">{copy.plural}</h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
            {copy.description}
          </p>
        </div>
        <Button asChild>
          <Link href={`${base}/new`}>{copy.newLabel}</Link>
        </Button>
      </header>

      <form method="get" action={base} className="flex flex-col gap-3 border-y border-line py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder="Title or slug"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={query.status}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              <option value="all">All</option>
              {CONTENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sort">Sort</Label>
            <select
              id="sort"
              name="sort"
              defaultValue={query.sort}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              <option value="updated">Recently updated</option>
              <option value="published">Recently published</option>
              <option value="views">Most viewed</option>
              <option value="title">Title</option>
            </select>
          </div>

          {categories.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category">Category</Label>
              <select
                id="category"
                name="category"
                defaultValue={query.category}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Any</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {tagOptions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tag">Tag</Label>
              <select
                id="tag"
                name="tag"
                defaultValue={query.tag}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Any</option>
                {tagOptions.map((tag) => (
                  <option key={tag.slug} value={tag.slug}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <Button type="submit" variant="outline">
            Apply
          </Button>
          {filtered ? (
            <Button asChild variant="ghost">
              <Link href={base}>Reset</Link>
            </Button>
          ) : null}
        </div>
      </form>

      <ContentList type={type} segment={segment} rows={rows} />

      <Pagination
        page={page.page}
        pageCount={page.pageCount}
        total={page.total}
        hrefFor={(next) => contentListHref(base, { page: next }, query)}
      />
    </div>
  )
}
