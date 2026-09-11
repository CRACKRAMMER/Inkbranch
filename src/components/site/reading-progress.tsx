'use client'

import { useEffect, useRef } from 'react'

/**
 * Reading progress bar.
 *
 * Scaled with `transform: scaleX()`, never with `width`. Width animates layout
 * on every scroll frame; transform is composited, so this costs no layout work
 * on the one interaction where the main thread is busiest.
 *
 * The measurement is the *article*, not the document. A progress bar that
 * counts the related-posts list and the footer as reading is measuring the page
 * rather than the piece.
 *
 * The scroll listener is passive and the write happens in a `requestAnimationFrame`
 * callback, so a scroll that fires faster than the display refreshes does not
 * queue up one style write per event.
 */
export function ReadingProgress({ targetId }: { targetId: string }) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bar = barRef.current
    const target = document.getElementById(targetId)
    if (!bar || !target) return

    // `prefers-reduced-motion` readers still get the position, just not the
    // easing. The bar is information, so hiding it entirely would be worse.
    let frame = 0

    const measure = () => {
      frame = 0

      const rect = target.getBoundingClientRect()
      const scrollY = window.scrollY
      const top = rect.top + scrollY
      const height = rect.height
      const viewport = window.innerHeight

      // The reader is "done" once the end of the article reaches the bottom of
      // the viewport; before that, progress is how far through it they are.
      const travelled = scrollY - top + viewport
      const total = height
      const ratio = total <= 0 ? 1 : Math.min(1, Math.max(0, travelled / total))

      bar.style.transform = `scaleX(${ratio})`
    }

    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })

    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [targetId])

  return (
    <div
      ref={barRef}
      className="reading-progress no-print w-full"
      // Decorative: the same information is available from the article's own
      // position in the document, and announcing a percentage on every scroll
      // would flood a screen reader.
      aria-hidden="true"
      style={{ transform: 'scaleX(0)' }}
    />
  )
}
