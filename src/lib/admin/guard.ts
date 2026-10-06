import 'server-only'

import { ZodError, type ZodType } from 'zod'

import { AssetInUseError, AssetNotFoundError, AssetQueryError } from '@/lib/assets/manage'
import { AssetStoreError, AssetTooLargeError, UnsupportedAssetError } from '@/lib/assets/storage'
import { CsrfError, verifyCsrfRequest } from '@/lib/auth/csrf'
import { UnauthorizedError, requireActionContext, type ActionContext } from '@/lib/auth/session'
import { ContentLockError, ContentWriteError } from '@/lib/content/writer'
import { NavigationError } from '@/lib/navigation'
import { RedirectError } from '@/lib/redirects'
import {
  RevisionCompareError,
  RevisionCorruptError,
  RevisionNotFoundError,
  RevisionSlugMismatchError,
} from '@/lib/revision/store'
import { SettingsError } from '@/lib/settings'
import { actionFailure, type ActionFailure } from './result'

/**
 * The three guarantees every mutating Server Action in this admin must make:
 * an authenticated session, a verified request, and a validated payload.
 *
 * They are gathered here rather than repeated per action because the failure
 * mode of getting one wrong is silent — a forgotten CSRF check still mutates.
 */

/**
 * Authenticate and verify the request in one step.
 *
 * Order matters: `requireActionContext` resolves the session the CSRF token is
 * bound to, so the token check cannot run first.
 */
export async function guardAction(): Promise<ActionContext> {
  const context = await requireActionContext()
  await verifyCsrfRequest(context.session)
  return context
}

/**
 * Authenticate only, for an action that reads.
 *
 * The CSRF check exists to stop a third-party page from *changing* something
 * using the browser's session. A read-only action has nothing for it to protect,
 * and the editor's preview fires on a typing pause, which would put a token
 * verification on the path of every half-typed paragraph. Authentication is
 * still required: the preview runs a Markdown pipeline on the caller's behalf.
 */
export async function guardRead(): Promise<ActionContext> {
  return requireActionContext()
}

export interface ParsedInput<T> {
  ok: true
  value: T
}

/**
 * Validate action input, narrowing Zod's issue list into per-field messages so a
 * form can put each one next to the input that caused it.
 */
export function parseActionInput<T>(
  schema: ZodType<T>,
  input: unknown,
): ParsedInput<T> | ActionFailure {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }

  const fieldErrors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.')
    if (path && !fieldErrors[path]) fieldErrors[path] = issue.message
  }
  return actionFailure('Some fields need attention.', {
    fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    detail: result.error.issues.map((issue) => issue.message).join('; '),
  })
}

/**
 * The honest half of error handling.
 *
 * Anything that says "the write did not happen" keeps that sentence, verbatim,
 * because that is the only thing the admin actually needs to know before
 * deciding whether to retype their work. The wrapped `cause` is deliberately
 * not forwarded: it can carry a filesystem path, and the client is a browser.
 */
export function describeActionError(error: unknown): ActionFailure {
  if (error instanceof UnauthorizedError) {
    return actionFailure('Your session ended. Sign in again — nothing was saved.', {
      detail: error.message,
    })
  }

  if (error instanceof CsrfError) {
    return actionFailure('This request could not be verified. Reload the page and try again.', {
      detail: error.message,
    })
  }

  if (error instanceof ContentLockError) {
    return actionFailure(
      `Another write holds the lock on ${error.relativePath}. The file was not modified.`,
      { detail: error.message, retryable: true },
    )
  }

  if (error instanceof ContentWriteError) {
    return actionFailure(`Writing ${error.relativePath} failed. The original file was not modified.`, {
      detail: error.message,
      retryable: true,
    })
  }

  if (error instanceof RevisionNotFoundError || error instanceof RevisionCorruptError) {
    return actionFailure('That revision is no longer readable.', { detail: error.message })
  }

  if (error instanceof RevisionSlugMismatchError) {
    return actionFailure(
      `This revision belongs to slug “${error.revisionSlug}”, but the document is now “${error.documentSlug}”. Nothing was written.`,
      { detail: error.message },
    )
  }

  if (error instanceof RevisionCompareError) {
    return actionFailure('Those revisions belong to different documents.', {
      detail: error.message,
    })
  }

  if (error instanceof AssetInUseError) {
    const documents = error.usage.documents
      .map((document) => `${document.type}/${document.slug}`)
      .join(', ')
    const avatar = error.usage.usedAsSiteAvatar ? ' It is also the configured site avatar.' : ''
    return actionFailure(
      documents
        ? `Still referenced by ${documents}, so it was not deleted.${avatar}`
        : `Still referenced, so it was not deleted.${avatar}`,
      { detail: error.message },
    )
  }

  if (error instanceof AssetNotFoundError) {
    return actionFailure('That asset no longer exists.')
  }

  if (error instanceof AssetTooLargeError) {
    return actionFailure(error.message)
  }

  if (error instanceof UnsupportedAssetError) {
    return actionFailure(error.message)
  }

  if (error instanceof AssetStoreError || error instanceof AssetQueryError) {
    return actionFailure('The asset store refused the operation.', { detail: error.message })
  }

  if (error instanceof NavigationError) {
    return actionFailure(
      error.message,
      error.issues.length > 0 ? { detail: error.issues.join('; ') } : undefined,
    )
  }

  if (error instanceof RedirectError) {
    return actionFailure(
      error.message,
      error.issues.length > 0 ? { detail: error.issues.join('; ') } : undefined,
    )
  }

  if (error instanceof SettingsError) {
    return actionFailure(
      error.message,
      error.issues.length > 0 ? { detail: error.issues.join('; ') } : undefined,
    )
  }

  if (error instanceof ZodError) {
    return actionFailure('A value was rejected by validation.', {
      detail: error.issues.map((issue) => issue.message).join('; '),
    })
  }

  if (isNextRedirect(error)) throw error

  // Genuinely unexpected. The action still returns a usable failure rather than
  // an opaque digest, and the throw is written to the server log in full — the
  // browser is told the error's name and nothing more, because a stack can
  // carry a filesystem path.
  console.error(
    '[admin] unexpected action error:',
    error instanceof Error ? (error.stack ?? error.message) : error,
  )
  return actionFailure('The server hit an unexpected error. The operation could not be confirmed.', {
    detail: error instanceof Error ? error.name : undefined,
    retryable: true,
  })
}

/**
 * Next implements `redirect()` by throwing a sentinel. Catching it and turning
 * it into a form error would swallow a navigation the action intended.
 */
function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  )
}
