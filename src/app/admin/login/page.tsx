import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getCurrentUser, LOGIN_PATH } from '@/lib/auth/session'
import { hasAnyUser } from '@/lib/admin/queries'
import { safeNext } from '@/lib/admin/next-path'
import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/**
 * Sign in.
 *
 * There is no registration route, and that is a deliberate absence rather than
 * an unfinished one: this admin has exactly the accounts `pnpm db:seed`
 * creates, and a public "create account" form on a single-author blog is an
 * attack surface with no user. When the database has no users at all the page
 * says so and names the command, instead of offering a signup that does not
 * exist.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const params = await searchParams
  const next = safeNext(params.next)

  const user = await getCurrentUser()
  if (user) redirect(next)

  const seeded = await hasAnyUser()

  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[22rem] flex-col justify-center px-6 py-16"
    >
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink-subtle">Admin</p>
        <h1 className="mt-3 font-serif text-2xl tracking-tight text-ink">Sign in</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Content is authored in Markdown on disk. Signing in gives you the editor, the revision
          history and the site&rsquo;s settings.
        </p>
      </header>

      {seeded ? (
        <LoginForm next={next === '/admin' ? undefined : next} />
      ) : (
        <NoAccounts />
      )}

      <p className="mt-8 border-t border-line pt-4 font-mono text-xs text-ink-subtle">
        {LOGIN_PATH}
      </p>
    </main>
  )
}

/**
 * Shown when the users table is empty.
 *
 * Rendered as a statement of fact rather than an error: nothing has gone wrong,
 * the installation has simply not been seeded yet.
 */
function NoAccounts() {
  return (
    <div className="border border-line bg-sunken px-4 py-4">
      <h2 className="text-sm font-medium text-ink">No account exists yet</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        This blog has no sign-up route. The first account is created from the command line, where
        whoever runs it already has access to the server:
      </p>
      <pre className="mt-3 overflow-x-auto border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
        <code>pnpm db:seed</code>
      </pre>
      <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
        It creates the first owner account and prints the address it used. Reload this page
        afterwards.
      </p>
    </div>
  )
}
