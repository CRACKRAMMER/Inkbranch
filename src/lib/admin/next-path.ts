import { LOGIN_PATH } from '@/lib/auth/session'

/**
 * The destination to send someone to after signing in.
 *
 * Only same-site paths are accepted. `//evil.com` is a valid relative URL as far
 * as the browser is concerned — it resolves to `https://evil.com` — which is
 * exactly how an open redirect is built out of a `next` parameter, and the
 * sign-in page is the most attractive place to put one.
 *
 * It lives outside the `'use server'` module that uses it because every export of
 * such a module becomes a callable endpoint, and this is a pure function with no
 * business being one.
 */
export function safeNext(value: string | undefined | null): string {
  if (!value) return '/admin'
  if (!value.startsWith('/') || value.startsWith('//')) return '/admin'
  // Signing in and landing back on the sign-in page is a loop, not a redirect.
  if (value.startsWith(LOGIN_PATH)) return '/admin'
  return value
}
