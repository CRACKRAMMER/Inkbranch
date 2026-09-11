/**
 * Offset pagination for the public list pages.
 *
 * Deliberately not cursor pagination. Cursors exist to keep a page stable while
 * rows are inserted underneath it, which matters for a feed that is being
 * appended to continuously. A personal site publishes a few times a month, and
 * the archive, the tag pages and the section indexes all want to say "page 3 of
 * 9" — which a cursor cannot do without a second counting query anyway.
 *
 * The page number is the only input, and it arrives from the URL. Everything
 * here treats it as hostile: `?page=0`, `?page=-4`, `?page=abc`, `?page=1e9`
 * and `?page=` all have to produce a usable page rather than an exception, a
 * negative `OFFSET`, or a query that scans the whole table.
 */

/** Rows per page. One number, shared by every list, so they cannot drift. */
export const PAGE_SIZE = 20

/**
 * The page number from a search parameter.
 *
 * `Next.js` hands a repeated parameter through as an array (`?page=1&page=2`),
 * which is why this accepts both. Anything that is not a positive integer
 * becomes page 1: a reader who mistypes a URL should land on the first page,
 * not on a 400.
 */
export function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return 1

  // `Number.parseInt` would accept "3abc" as 3 and " 3 " as 3. A page number
  // with trailing junk in it is a malformed URL, and silently reading it as a
  // smaller number hides that.
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) return 1

  return Number.parseInt(raw, 10)
}

/** How many pages a total divides into, never fewer than one. */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  if (total <= 0) return 1
  return Math.ceil(total / size)
}

/**
 * The `limit`/`offset` pair for a page, clamped to the last page that exists.
 *
 * The clamp is the part worth explaining. Without it, `?page=99999` asks
 * Postgres for `OFFSET 1999980`, which it satisfies by walking and discarding
 * every row — a request a stranger can make, repeatedly, for free. Clamping to
 * a real page means the offset is always inside the table.
 */
export function pageSlice(
  page: number,
  total: number,
  size: number = PAGE_SIZE,
): { limit: number; offset: number; page: number } {
  const last = pageCount(total, size)
  const current = Math.min(Math.max(page, 1), last)

  return { limit: size, offset: (current - 1) * size, page: current }
}
