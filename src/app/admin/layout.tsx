import type { Metadata } from 'next'
import { Toaster } from '@/components/ui/toaster'

import './admin.css'

/**
 * The admin's only non-negotiable requirement: keep it out of search engines.
 *
 * `noindex` lives here rather than on each page because a page added later must
 * inherit it — the failure mode of forgetting is an admin URL in a search
 * result, and the failure mode of adding it everywhere is one forgotten line.
 *
 * The authenticated chrome is not rendered here. `(dashboard)` owns that so the
 * sign-in page can share this layout without inheriting a sidebar it cannot yet
 * populate.
 */
export const metadata: Metadata = {
  title: {
    default: 'Admin',
    template: '%s · Admin',
  },
  robots: { index: false, follow: false },
}

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  )
}
