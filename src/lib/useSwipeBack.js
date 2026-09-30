import { useEffect, useRef } from 'react'

// iOS gives an installed PWA no native edge-swipe, so this reimplements it.
// It will not match Safari's native feel exactly — no rubber-banding of the
// underlying view, no interactive cross-fade — but it tracks the finger and
// completes or cancels on the same signals.

const EDGE_ZONE_PX = 30
const THRESHOLD_RATIO = 0.25
// A short, fast flick should complete even well under the distance threshold.
const FLICK_VELOCITY = 0.5 // px per ms
const DIRECTION_LOCK_PX = 10
const MOBILE_MAX_WIDTH = 720

/** Anything that scrolls sideways, or takes text, owns the gesture instead. */
function gestureBlocked(target) {
  if (!(target instanceof Element)) return false

  // The composer and any input must keep native caret dragging.
  if (target.closest('textarea, input, select, [contenteditable="true"]')) return true
  // The lightbox is a full-screen overlay with its own dismissal.
  if (target.closest('.lightbox')) return true

  // Walk up looking for a horizontally scrollable ancestor with room to move.
  let el = target
  while (el && el !== document.body) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflowX = getComputedStyle(el).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    el = el.parentElement
  }
  return false
}

/**
 * Edge-swipe-right to go back, on mobile only.
 *
 * @param paneRef  the element to translate during the drag
 * @param enabled  only true when a thread is open on a phone
 * @param onBack   called once the gesture completes
 */
export function useSwipeBack(paneRef, enabled, onBack) {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  useEffect(() => {
    const pane = paneRef.current
    if (!enabled || !pane) return undefined
    if (typeof window === 'undefined') return undefined
    if (window.innerWidth > MOBILE_MAX_WIDTH) return undefined

    let startX = 0
    let startY = 0
    let startedAt = 0
    let currentX = 0
    let tracking = false // inside the edge zone, direction not yet decided
    let dragging = false // horizontal intent confirmed; we own the gesture

    const setTransform = (x, animate) => {
      pane.style.transition = animate ? 'transform 0.22s ease-out' : 'none'
      pane.style.transform = x ? `translateX(${x}px)` : ''
    }

    const clearInline = () => {
      pane.style.transition = ''
      pane.style.transform = ''
    }

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      // Only from the left edge, matching the iOS affordance.
      if (touch.clientX > EDGE_ZONE_PX) return
      if (gestureBlocked(e.target)) return

      startX = touch.clientX
      startY = touch.clientY
      startedAt = Date.now()
      currentX = 0
      tracking = true
      dragging = false
    }

    const onTouchMove = (e) => {
      if (!tracking || e.touches.length !== 1) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      if (!dragging) {
        // Decide once, then stick with it — otherwise a diagonal drag flickers
        // between scrolling and swiping.
        if (Math.abs(dy) > DIRECTION_LOCK_PX && Math.abs(dy) > Math.abs(dx)) {
          tracking = false
          return
        }
        if (dx > DIRECTION_LOCK_PX && Math.abs(dx) > Math.abs(dy)) {
          dragging = true
        } else {
          return
        }
      }

      // Now that we own it, stop the thread scrolling underneath.
      if (e.cancelable) e.preventDefault()
      currentX = Math.max(0, dx)
      setTransform(currentX, false)
    }

    const onTouchEnd = () => {
      if (!dragging) {
        tracking = false
        return
      }

      const elapsed = Math.max(1, Date.now() - startedAt)
      const velocity = currentX / elapsed
      const passed =
        currentX > window.innerWidth * THRESHOLD_RATIO || velocity > FLICK_VELOCITY

      tracking = false
      dragging = false

      if (passed) {
        // Slide the rest of the way out, then hand over.
        setTransform(window.innerWidth, true)
        setTimeout(() => {
          clearInline()
          onBackRef.current?.()
        }, 200)
      } else {
        // Cancelled — animate home, then drop the inline styles.
        setTransform(0, true)
        setTimeout(clearInline, 240)
      }
    }

    // passive:false on move only — it is the one handler that preventDefaults.
    pane.addEventListener('touchstart', onTouchStart, { passive: true })
    pane.addEventListener('touchmove', onTouchMove, { passive: false })
    pane.addEventListener('touchend', onTouchEnd, { passive: true })
    pane.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      pane.removeEventListener('touchstart', onTouchStart)
      pane.removeEventListener('touchmove', onTouchMove)
      pane.removeEventListener('touchend', onTouchEnd)
      pane.removeEventListener('touchcancel', onTouchEnd)
      clearInline()
    }
  }, [paneRef, enabled])
}
