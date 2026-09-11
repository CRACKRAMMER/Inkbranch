import { cn } from '@/lib/utils/cn'

/**
 * The horizontal frame every public page sits in.
 *
 * Two widths, and the difference between them is a decision rather than a
 * leftover. `wide` is the dashboard and the knowledge graph, which are
 * genuinely two-dimensional and use the extra room. `default` is every list and
 * every form: a list of dates and titles stops being scannable once the eye has
 * to travel more than about 900px from the date to the end of the title, so the
 * extra width would be empty space on the right of every row.
 *
 * Padding is on the container rather than on each page so the left edge of a
 * heading and the left edge of the text below it are the same line everywhere
 * on the site — the thing that most visibly separates a laid-out page from an
 * assembled one.
 */
export function Container({
  size = 'default',
  className,
  children,
}: {
  size?: 'default' | 'wide'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-5 sm:px-8',
        size === 'wide' ? 'max-w-[76rem]' : 'max-w-[60rem]',
        className,
      )}
    >
      {children}
    </div>
  )
}
