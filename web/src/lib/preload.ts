import type { QueryClient } from '@tanstack/react-query'
import type { ContentDetailBody, HomeBody, PreloadEnvelope, SiteInfo } from './types'

declare global {
  interface Window {
    __INKBRANCH_DATA__?: PreloadEnvelope
  }
}

const DEFAULT_SITE: SiteInfo = {
  name: 'Inkbranch · 墨枝',
  description: 'Personal Knowledge System & Modern Publishing Platform',
  url: '',
}

let cachedPreload: PreloadEnvelope | undefined

function readPreloadOnce(): PreloadEnvelope | undefined {
  if (cachedPreload !== undefined) {
    return cachedPreload
  }
  if (typeof window !== 'undefined' && window.__INKBRANCH_DATA__) {
    cachedPreload = window.__INKBRANCH_DATA__
  }
  return cachedPreload
}

export function getInitialSiteInfo(): SiteInfo {
  const pre = readPreloadOnce()
  if (pre?.site?.name) {
    return pre.site
  }
  return DEFAULT_SITE
}

export function hydratePreloadCache(queryClient: QueryClient): void {
  const pre = readPreloadOnce()
  if (!pre?.data) return

  if (pre.routeKind === 'home') {
    const homeData = pre.data as HomeBody
    if (homeData && Array.isArray(homeData.recentPosts)) {
      queryClient.setQueryData(['home'], homeData)
    }
    return
  }

  if (pre.routeKind === 'document') {
    const detail = pre.data as ContentDetailBody
    if (detail?.document?.type && detail?.document?.slug) {
      queryClient.setQueryData(
        ['content-detail', detail.document.type, detail.document.slug],
        detail,
      )
    }
  }
}
