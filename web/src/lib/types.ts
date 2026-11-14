export type ContentType = 'post' | 'note' | 'project'
export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'archived' | 'unlisted'
export type ProjectStatus = 'active' | 'maintained' | 'experiment' | 'archived'

export interface SiteInfo {
  name: string
  description: string
  url: string
}

export interface Heading {
  id: string
  text: string
  level: number
}

export interface OutgoingLink {
  targetType?: string
  targetSlug: string
  linkText: string
  contextSnippet: string
  href: string
}

export interface SEOMetadata {
  title?: string
  description?: string
  canonical?: string
  ogImage?: string
  noindex?: boolean
}

export interface ContentSummary {
  type: ContentType
  slug: string
  title: string
  description: string
  summary?: string
  status: ContentStatus
  category?: string
  tags: string[]
  series?: string
  seriesOrder?: number
  lang: string
  translationKey?: string
  publishedAt?: string
  updatedAt: string
  cover?: string
  featured: boolean
  wordCount: number
  readingMinutes: number
  url: string
  markdownUrl: string
  projectStatus?: ProjectStatus
  repoUrl?: string
  websiteUrl?: string
  stack?: string[]
}

export interface ContentDetail extends ContentSummary {
  renderedHtml: string
  rawMarkdown?: string
  headings: Heading[]
  tocEnabled: boolean
  commentsEnabled: boolean
  seo: SEOMetadata
  outgoingLinks: OutgoingLink[]
}

export interface GraphNode {
  id: string
  type: ContentType
  slug: string
  title: string
  category?: string
  tags: string[]
  url: string
  featured: boolean
  degree: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: 'wikilink' | 'series' | 'shared-tag' | string
  weight: number
}

export interface GlobalGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface BacklinkItem {
  type: ContentType
  slug: string
  title: string
  url: string
  contextSnippet: string
}

export interface RelatedItem {
  type: ContentType
  slug: string
  title: string
  description: string
  url: string
  readingMinutes: number
  score: number
}

export interface TranslationSibling {
  lang: string
  title: string
  url: string
}

export interface SeriesEntry {
  slug: string
  type: ContentType
  title: string
  url: string
  order: number
  readingMinutes: number
}

export interface SeriesNav {
  name: string
  slug: string
  currentIndex: number
  total: number
  items: SeriesEntry[]
  prev?: SeriesEntry
  next?: SeriesEntry
}

export interface DocumentContext {
  localGraph: GlobalGraph
  backlinks: BacklinkItem[]
  related: RelatedItem[]
  translations: TranslationSibling[]
  seriesNav?: SeriesNav
}

export interface ContentDetailBody {
  document: ContentDetail
  context: DocumentContext
}

export interface ContentListBody {
  total: number
  limit: number
  offset: number
  items: ContentSummary[]
}

export interface TagSummary {
  name: string
  slug: string
  count: number
}

export interface TagListBody {
  items: TagSummary[]
}

export interface HomeCounts {
  posts: number
  notes: number
  projects: number
  tags: number
  series: number
}

export interface HomeBody {
  site: SiteInfo
  featuredPost?: ContentSummary
  recentPosts: ContentSummary[]
  recentNotes: ContentSummary[]
  activeProjects: ContentSummary[]
  popularTags: TagSummary[]
  counts: HomeCounts
}

export interface SeriesSummary {
  name: string
  slug: string
  count: number
  latestAt?: string
  items: SeriesEntry[]
}

export interface SeriesListBody {
  items: SeriesSummary[]
}

export interface ArchiveYearGroup {
  year: number
  items: ContentSummary[]
}

export interface ArchiveBody {
  total: number
  years: ArchiveYearGroup[]
}

export interface SearchHit {
  type: ContentType
  slug: string
  title: string
  description: string
  category?: string
  tags: string[]
  lang: string
  url: string
  snippetHtml: string
  publishedAt?: string
  readingMinutes: number
  score: number
}

export interface SearchResponse {
  query: string
  total: number
  hits: SearchHit[]
}

export interface PreloadEnvelope {
  routeKind: string
  site: SiteInfo
  data?: unknown
}

/* Forward-compatible Phase 3/4 DTOs */
export type ReactionEmoji = '👍' | '🔥' | '💡' | '❤️' | '🎉'

export interface ReactionCount {
  emoji: ReactionEmoji
  count: number
  reacted?: boolean
}

export interface ReactionsResponse {
  counts: ReactionCount[]
}

export interface CommentNode {
  id: string
  parentId?: string
  authorName: string
  authorUrl?: string
  avatarUrl?: string
  isAuthor?: boolean
  bodyHtml: string
  createdAt: string
  replies?: CommentNode[]
}

export interface CommentsResponse {
  mode: 'builtin' | 'giscus' | 'off'
  commentsEnabled: boolean
  turnstileSiteKey?: string
  giscus?: {
    repo?: string
    repoId?: string
    category?: string
    categoryId?: string
  }
  items: CommentNode[]
}

export interface FriendLinkItem {
  id: string
  name: string
  url: string
  feedUrl?: string
  avatarUrl?: string
  description: string
  category?: string
  healthStatus?: 'healthy' | 'degraded' | 'unknown'
  lastCheckedAt?: string
}

export interface FriendFeedItem {
  id: string
  friendName: string
  friendUrl: string
  friendAvatar?: string
  title: string
  url: string
  summary?: string
  publishedAt: string
}

export interface FriendsResponse {
  links: FriendLinkItem[]
  feeds: FriendFeedItem[]
}

export interface PreviewResponse {
  expiresAt: string
  document: ContentDetail
  context?: DocumentContext
}
