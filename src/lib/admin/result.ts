/**
 * The shape every admin Server Action returns.
 *
 * Server Actions have no status code: a thrown error becomes an opaque digest in
 * production and the client sees a rejected promise with no message. Returning a
 * discriminated result instead means a failed save can say *what* failed and
 * *what state the file is in*, which is the difference between an admin who
 * retries and an admin who reloads the page and loses their buffer.
 *
 * This module is deliberately free of imports: client components import the
 * type, and anything with a server dependency would drag it into the browser
 * bundle. The mapping from thrown errors onto these shapes lives in `guard.ts`.
 */

export interface ActionSuccess<T> {
  ok: true
  data: T
}

export interface ActionFailure {
  ok: false
  /** One sentence, already fit to render. */
  error: string
  /** Per-field messages, keyed by the form field's `name`. */
  fieldErrors?: Record<string, string>
  /**
   * A second line for the cases where the first one is alarming: a refused write
   * says so explicitly, and the identifier of the thing that was not written is
   * worth repeating.
   */
  detail?: string
  /**
   * True when retrying the same request unchanged is pointless — a lock timed
   * out, an asset is in use, the document moved on disk. The UI turns this into
   * an explicit override rather than a generic "try again".
   */
  retryable?: boolean
  /**
   * A stable discriminator for the few failures a UI reacts to differently.
   * Messages are for people and will be reworded; this is what a component is
   * allowed to branch on. `content-committed` confirms a filesystem mutation
   * even when the index, history or another follow-up step failed.
   */
  code?: 'stale' | 'content-committed'
  committed?: CommittedContentChange[]
}

/** A filesystem change already completed before an action's later failure. */
export interface CommittedContentChange {
  path: string
  slug: string
  operation: 'write' | 'delete'
  /** The bytes this action wrote. Deleted files have no current checksum. */
  checksum: string | null
  /** Exact previous bytes, relative to the private content root, after failure. */
  recoveryPath?: string
}

export type ActionResult<T> = ActionSuccess<T> | ActionFailure

export function actionOk(): ActionSuccess<undefined>
export function actionOk<T>(data: T): ActionSuccess<T>
export function actionOk<T>(data?: T): ActionSuccess<T | undefined> {
  return { ok: true, data }
}

export function actionFailure(
  error: string,
  extra: Omit<ActionFailure, 'ok' | 'error'> = {},
): ActionFailure {
  return { ok: false, error, ...extra }
}
