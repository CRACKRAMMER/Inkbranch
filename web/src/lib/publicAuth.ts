import { useQuery } from '@tanstack/react-query'

export interface PublicAuthUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
  globalRole?: string
  appRole?: string
  allowAdmin?: boolean
}

export interface PublicAuthMeResponse {
  authMode: 'local' | 'hybrid' | 'citadel_only' | string
  usesCitadel: boolean
  citadelPublicUrl?: string
  studioUrl?: string
  authenticated: boolean
  user?: PublicAuthUser
}

export async function getPublicAuthMe(): Promise<PublicAuthMeResponse> {
  const res = await fetch('/api/v1/public/auth/me', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    return {
      authMode: 'local',
      usesCitadel: false,
      studioUrl: '/admin',
      authenticated: false,
    }
  }
  return (await res.json()) as PublicAuthMeResponse
}

export async function logoutPublicReader(): Promise<{ ok?: boolean; citadelLogoutUrl?: string }> {
  const res = await fetch('/api/v1/public/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as { ok?: boolean; citadelLogoutUrl?: string }
}

export function buildPublicLoginUrl(rd?: string): string {
  const target =
    rd ||
    (typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : '/')
  return `/api/v1/public/auth/login?rd=${encodeURIComponent(target)}`
}

export function usePublicAuth() {
  return useQuery({
    queryKey: ['public-auth-me'],
    queryFn: getPublicAuthMe,
    staleTime: 60_000,
  })
}
