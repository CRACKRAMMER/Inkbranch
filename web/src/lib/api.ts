import type {
  ArchiveBody,
  CommentsResponse,
  ContentDetailBody,
  ContentListBody,
  ContentType,
  FriendsResponse,
  GlobalGraph,
  HomeBody,
  PreviewResponse,
  ReactionEmoji,
  ReactionsResponse,
  SearchResponse,
  SeriesListBody,
  SeriesSummary,
  TagListBody,
} from './types'

export class APIError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, message: string, detail = '') {
    super(message)
    this.name = 'APIError'
    this.status = status
    this.detail = detail
  }
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    let message = `HTTP ${res.status}`
    let detail = ''
    try {
      const errBody = (await res.json()) as { title?: string; detail?: string; error?: string }
      message = errBody.title ?? errBody.error ?? message
      detail = errBody.detail ?? ''
    } catch {
      // Ignore non-JSON error payloads
    }
    throw new APIError(res.status, message, detail)
  }

  return (await res.json()) as T
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) {
      sp.set(k, String(v))
    }
  }
  const q = sp.toString()
  return q ? `?${q}` : ''
}

export function getHome(): Promise<HomeBody> {
  return fetchJSON<HomeBody>('/api/v1/home')
}

export interface ListContentParams {
  type?: ContentType | ''
  tag?: string
  category?: string
  series?: string
  lang?: string
  featured?: boolean
  limit?: number
  offset?: number
}

export function listContent(params: ListContentParams = {}): Promise<ContentListBody> {
  return fetchJSON<ContentListBody>(
    `/api/v1/content${buildQuery({
      type: params.type,
      tag: params.tag,
      category: params.category,
      series: params.series,
      lang: params.lang,
      featured: params.featured !== undefined ? String(params.featured) : undefined,
      limit: params.limit,
      offset: params.offset,
    })}`,
  )
}

export function getContentDetail(type: ContentType, slug: string): Promise<ContentDetailBody> {
  return fetchJSON<ContentDetailBody>(
    `/api/v1/content/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`,
  )
}

export function listTags(): Promise<TagListBody> {
  return fetchJSON<TagListBody>('/api/v1/tags')
}

export function listSeries(): Promise<SeriesListBody> {
  return fetchJSON<SeriesListBody>('/api/v1/series')
}

export function getSeriesDetail(series: string): Promise<SeriesSummary> {
  return fetchJSON<SeriesSummary>(`/api/v1/series/${encodeURIComponent(series)}`)
}

export function getArchive(): Promise<ArchiveBody> {
  return fetchJSON<ArchiveBody>('/api/v1/archive')
}

export interface SearchParams {
  q: string
  type?: ContentType | ''
  tag?: string
  category?: string
  lang?: string
  limit?: number
  offset?: number
}

export function searchContent(params: SearchParams): Promise<SearchResponse> {
  return fetchJSON<SearchResponse>(
    `/api/v1/search${buildQuery({
      q: params.q,
      type: params.type,
      tag: params.tag,
      category: params.category,
      lang: params.lang,
      limit: params.limit,
      offset: params.offset,
    })}`,
  )
}

export function getGraph(params: { type?: ContentType | ''; tag?: string } = {}): Promise<GlobalGraph> {
  return fetchJSON<GlobalGraph>(
    `/api/v1/graph${buildQuery({
      type: params.type,
      tag: params.tag,
    })}`,
  )
}

export async function fetchRawMarkdown(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'text/markdown, text/plain' } })
  if (!res.ok) {
    throw new APIError(res.status, 'Failed to fetch raw markdown')
  }
  return res.text()
}

const DEFAULT_EMOJIS: ReactionEmoji[] = ['👍', '🔥', '💡', '❤️', '🎉']

export async function getReactions(
  contentType: ContentType,
  slug: string,
): Promise<ReactionsResponse> {
  try {
    return await fetchJSON<ReactionsResponse>(
      `/api/v1/reactions${buildQuery({ type: contentType, slug })}`,
    )
  } catch (err) {
    if (err instanceof APIError && err.status === 404) {
      return {
        counts: DEFAULT_EMOJIS.map((emoji) => ({ emoji, count: 0, reacted: false })),
      }
    }
    throw err
  }
}

export function toggleReaction(payload: {
  type: ContentType
  slug: string
  emoji: ReactionEmoji
}): Promise<ReactionsResponse> {
  return fetchJSON<ReactionsResponse>('/api/v1/reactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getComments(
  contentType: ContentType,
  slug: string,
): Promise<CommentsResponse> {
  try {
    return await fetchJSON<CommentsResponse>(
      `/api/v1/comments${buildQuery({ type: contentType, slug })}`,
    )
  } catch (err) {
    if (err instanceof APIError && err.status === 404) {
      return {
        mode: 'builtin',
        commentsEnabled: true,
        items: [],
      }
    }
    throw err
  }
}

export function postComment(payload: {
  type: ContentType
  slug: string
  parentId?: string
  authorName: string
  authorEmail: string
  authorUrl?: string
  bodyMarkdown: string
  notifyOnReply?: boolean
  turnstileToken?: string
}): Promise<{ ok: boolean; status: string; message?: string }> {
  return fetchJSON('/api/v1/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getFriends(): Promise<FriendsResponse> {
  try {
    return await fetchJSON<FriendsResponse>('/api/v1/friends')
  } catch (err) {
    if (err instanceof APIError && err.status === 404) {
      return { links: [], feeds: [] }
    }
    throw err
  }
}

export function applyFriendLink(payload: {
  name: string
  url: string
  feedUrl?: string
  avatarUrl?: string
  description: string
  contactEmail?: string
  turnstileToken?: string
}): Promise<{ ok: boolean; message?: string }> {
  return fetchJSON('/api/v1/friends/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function subscribeNewsletter(payload: {
  email: string
  lang?: string
  turnstileToken?: string
}): Promise<{ ok: boolean; status?: string; message?: string }> {
  return fetchJSON('/api/v1/newsletter/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function getPreview(token: string): Promise<PreviewResponse> {
  return fetchJSON<PreviewResponse>(`/api/v1/preview/${encodeURIComponent(token)}`)
}

export function sendAnalyticsBeacon(payload: {
  eventType: 'pageview' | 'read_depth'
  contentType?: string
  slug?: string
  path: string
  referrer?: string
  maxDepth?: number
  dwellSeconds?: number
}): void {
  try {
    const body = JSON.stringify(payload)
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/v1/analytics/collect', blob)
      return
    }
    void fetch('/api/v1/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Analytics must never interrupt reader flow
  }
}
