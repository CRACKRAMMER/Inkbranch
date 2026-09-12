import { headers } from 'next/headers'

// The editor preview and the revision view both render article Markdown, and
// both render it with KaTeX. Imported here so the two admin surfaces that show
// a document body get the stylesheet and no other admin page does.
import 'katex/dist/katex.min.css'

import { AdminShell } from '@/components/admin/admin-shell'
import { safeNext } from '@/lib/admin/next-path'
import { requireUser } from '@/lib/auth/session'
import { getSettings } from '@/lib/settings'
import { logoutAction } from '../actions/auth'

/**
 * The authenticated frame.
 *
 * `requireUser()` is called here *and* in every page below, which is redundant
 * on purpose: layouts and pages can render in separate passes, a page can be
 * reached through a different layout after a route move, and the cost of the
 * second check is one cached session lookup. The cost of missing one is an
 * unauthenticated admin screen.
 *
 * This is the only call site that passes a return destination. It is the one
 * that actually redirects an anonymous visitor, so it is the only one where the
 * destination is a question anyone is asking — the pages' checks run after the
 * layout has already let an authenticated user through, and the parameter would
 * be dead weight there.
 *
 * The path comes from the `x-pathname` request header that `src/middleware.ts`
 * sets. It is read back through `safeNext` rather than trusted: the header is
 * written by our own middleware, but the value it carries is derived from a URL
 * a stranger chose, and `safeNext` is the function that decides whether such a
 * value is a destination or an open redirect.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requested = (await headers()).get('x-pathname')
  const user = await requireUser(safeNext(requested))
  const settings = await getSettings()

  return (
    <AdminShell
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        siteName: settings.siteName,
      }}
      signOut={logoutAction}
    >
      {children}
    </AdminShell>
  )
}
