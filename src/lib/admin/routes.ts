import { CONTENT_TYPES, CONTENT_STATUSES, type ContentStatus, type ContentType } from '@/lib/content/schema'
import { CONTENT_SORTS, type ContentSort } from './queries'

/**
 * The segment a content type occupies in the admin's URLs.
 *
 * The public site routes on the plural (`/posts/...`), so the admin does too —
 * an operator who has the site's URLs in their head should not have to translate
 * when they switch to editing.
 */
const SEGMENTS: Record<ContentType, string> = {
  post: 'posts',
  note: 'notes',
  project: 'projects',
}

const BY_SEGMENT = new Map(CONTENT_TYPES.map((type) => [SEGMENTS[type], type]))

export function segmentForType(type: ContentType): string {
  return SEGMENTS[type]
}

export function typeFromSegment(segment: string): ContentType | null {
  return BY_SEGMENT.get(segment) ?? null
}

export interface TypeCopy {
  singular: string
  plural: string
  description: string
  /** What the create form calls the body, which differs by kind of writing. */
  newLabel: string
}

export const TYPE_COPY: Record<ContentType, TypeCopy> = {
  post: {
    singular: 'Post',
    plural: 'Posts',
    description:
      'Long-form articles. A post needs a title and a date before it can be published.',
    newLabel: 'New post',
  },
  note: {
    singular: 'Note',
    plural: 'Notes',
    description: 'Short entries. A note may have no title at all — the reader derives one.',
    newLabel: 'New note',
  },
  project: {
    singular: 'Project',
    plural: 'Projects',
    description: 'Portfolio entries, with a status, a repository and a stack.',
    newLabel: 'New project',
  },
}

export interface ContentListParams {
  q: string
  status: ContentStatus | 'all'
  sort: ContentSort
  category: string
  tag: string
  page: number
}

/** Read the list query out of a URL, discarding anything unrecognised. */
export function parseContentListParams(
  raw: Record<string, string | string[] | undefined>,
): ContentListParams {
  const one = (key: string): string => {
    const value = raw[key]
    if (Array.isArray(value)) return value[0] ?? ''
    return value ?? ''
  }

  const status = one('status')
  const sort = one('sort')
  const page = Number.parseInt(one('page'), 10)

  return {
    q: one('q').slice(0, 200),
    status: (CONTENT_STATUSES as readonly string[]).includes(status)
      ? (status as ContentStatus)
      : 'all',
    sort: (CONTENT_SORTS as readonly string[]).includes(sort) ? (sort as ContentSort) : 'updated',
    category: one('category').slice(0, 80),
    tag: one('tag').slice(0, 120),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  }
}

/** Rebuild the list URL with one parameter changed, dropping empties. */
export function contentListHref(
  base: string,
  params: Partial<ContentListParams> & { page?: number },
  current: ContentListParams,
): string {
  const merged = { ...current, ...params }
  const search = new URLSearchParams()
  if (merged.q) search.set('q', merged.q)
  if (merged.status !== 'all') search.set('status', merged.status)
  if (merged.sort !== 'updated') search.set('sort', merged.sort)
  if (merged.category) search.set('category', merged.category)
  if (merged.tag) search.set('tag', merged.tag)
  if (merged.page > 1) search.set('page', String(merged.page))
  const query = search.toString()
  return query ? `${base}?${query}` : base
}
