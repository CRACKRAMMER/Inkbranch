import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { ContentStatus } from '@/lib/content/schema'

/**
 * One status, one colour, in one place.
 *
 * A draft and an archived document are both "not published" and are not the
 * same thing: the colours separate "waiting to go out" from "deliberately off
 * the site" without a legend.
 */
const VARIANTS: Record<ContentStatus, BadgeProps['variant']> = {
  published: 'success',
  scheduled: 'warning',
  draft: 'secondary',
  archived: 'outline',
}

export function StatusBadge({ status }: { status: ContentStatus }) {
  return <Badge variant={VARIANTS[status]}>{status}</Badge>
}
