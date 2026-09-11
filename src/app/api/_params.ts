/**
 * Query-string list parsing, shared by the API routes.
 *
 * `/api/search` and `/api/graph` both read a set out of the query string —
 * `?type=post&type=note` and `?types=post,note` name the same filter — and a
 * client that writes one spelling against one endpoint should not have to learn
 * the other for the next one. Naming the rule once is also what keeps the two
 * routes answering the same URL the same way.
 *
 * Private to the app directory: the leading underscore is Next's convention for
 * a file that is not a route, so this is compiled and imported but never served.
 * It is not in `@/lib` because it is a property of how these endpoints read a
 * URL, not of anything the library layer owns or should know about.
 */

/**
 * Repeated and/or comma-separated values, trimmed, deduplicated, in first-seen
 * order.
 *
 * Both spellings are accepted because both are natural — a form with several
 * checkboxes submits a repeated key, and a hand-written URL reads better with
 * commas — and accepting them here rather than at each call site is the whole
 * point of this file. Empty pieces are dropped: `?types=` names no types, and
 * an empty filter that matched nothing would be a different answer from the one
 * the client is expressing.
 */
export function listParam(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    for (const part of value.split(',')) {
      const trimmed = part.trim()
      if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    }
  }
  return out
}
