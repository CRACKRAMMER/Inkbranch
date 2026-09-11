'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Ask before throwing away work that was never written.
 *
 * Three separate exits, because a browser gives three and only one of them fires
 * `beforeunload`:
 *
 * - A reload, a tab close and an external link go through `beforeunload`.
 * - An internal link goes through Next's client router, which is the History
 *   API and never unloads the document. The listener therefore runs in the
 *   capture phase on `document`, which sees the click before the router's own
 *   handler, and cancels it rather than letting the route change underneath.
 * - Back and forward buttons fire `popstate` *after* the history has already
 *   moved, so the current entry is pushed back on top first — which is what
 *   keeps the address bar pointing at the document that is still on screen —
 *   and only then is the reader asked.
 *
 * The dirty flag is a ref rather than a boolean prop for a reason: these
 * listeners are registered once, and a closure over a state value would still
 * be reading the value from the render that registered them. Callers keep the
 * ref current.
 *
 * This is best effort on purpose. Nothing here can stop a hard navigation that
 * the browser itself initiates, and the honest protection is the one the save
 * path already gives: work that matters is saved, and the buffer is not the
 * only copy.
 */
export function useUnsavedGuard(dirtyRef: RefObject<boolean>, message: string): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirtyRef, message])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return

      const anchor = (event.target as Element | null)?.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || anchor.target === '_blank') return
      if (!href.startsWith('/')) return

      if (!window.confirm(message)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirtyRef, message])

  useEffect(() => {
    const onPopState = () => {
      if (!dirtyRef.current) return
      window.history.pushState(null, '', window.location.pathname)
      if (window.confirm(message)) {
        dirtyRef.current = false
        window.history.back()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [dirtyRef, message])
}
