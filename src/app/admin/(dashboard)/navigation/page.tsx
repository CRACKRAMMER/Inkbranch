import type { Metadata } from 'next'

import { requireUser } from '@/lib/auth/session'
import { NAVIGATION_LOCATIONS, getNavigation, type NavigationLocation } from '@/lib/navigation'
import { Page, Section } from '@/components/admin/page'
import {
  NavigationEditor,
  SOCIAL_ICON_SUGGESTIONS,
  type NavigationEditorItem,
} from '@/components/admin/navigation-editor'

export const metadata: Metadata = { title: 'Navigation' }

/**
 * The three menus the site shell renders.
 *
 * They are edited one at a time and saved one at a time, because that is what
 * `saveNavigation` does: a menu is replaced whole, in a transaction, so there is
 * never a moment when the header is half a header.
 *
 * Hidden items are shown here and nowhere else. A menu row that is switched off
 * is still a row an editor wants to see — it is how a link is parked for later
 * rather than deleted and retyped.
 */

const MENUS: { location: NavigationLocation; title: string; description: string }[] = [
  {
    location: 'header',
    title: 'Header',
    description:
      'The site-wide menu. Order is the order it renders in; a hidden item stays in the list and out of the page.',
  },
  {
    location: 'footer',
    title: 'Footer',
    description:
      'Section links under the footer. These are usually the same destinations as the header, so a reader who has scrolled to the bottom does not have to scroll back up.',
  },
  {
    location: 'social',
    title: 'Social',
    description:
      'Outbound profiles. These are normally marked external, which is what makes them render with the icon rather than as an internal route.',
  },
]

export default async function NavigationPage() {
  await requireUser()

  const menus = await Promise.all(
    NAVIGATION_LOCATIONS.map(async (location) => ({
      location,
      items: await getNavigation(location, { includeHidden: true }),
    })),
  )

  const byLocation = new Map(menus.map((menu) => [menu.location, menu.items]))

  return (
    <Page
      title="Navigation"
      description="Every menu is stored as rows in one table and saved as a whole. Nothing here is written to a file."
    >
      <Section
        title="Menus"
        description="An item with no destination is refused when the menu is saved — a link that goes nowhere is worse than no link."
      >
        <div className="space-y-8">
          {MENUS.map((menu) => {
            const rows = byLocation.get(menu.location) ?? []
            const items: NavigationEditorItem[] = rows.map((row) => ({
              label: row.label,
              href: row.href,
              visible: row.visible,
              external: row.external,
              icon: row.icon,
            }))

            return (
              <NavigationEditor
                key={menu.location}
                location={menu.location}
                title={menu.title}
                description={menu.description}
                items={items}
                iconSuggestions={menu.location === 'social' ? SOCIAL_ICON_SUGGESTIONS : []}
              />
            )
          })}
        </div>
      </Section>
    </Page>
  )
}
