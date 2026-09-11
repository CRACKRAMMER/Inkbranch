/**
 * Revision history.
 *
 * `store.ts` is database- and filesystem-facing and carries `server-only`;
 * `diff.ts` is pure and can be reasoned about (and tested) on its own.
 */

export * from './diff'
export * from './store'
