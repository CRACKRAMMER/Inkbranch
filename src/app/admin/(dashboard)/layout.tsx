import { AdminShell } from '@/components/admin/admin-shell'
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
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
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
