import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

// WhatsApp/email-style swipe-right to reveal a dismiss action, TOUCH ONLY and
// used only on flagged conversation rows. The row (children) slides right on a
// GPU transform, uncovering a coloured panel with a ✕ on the left; tapping the
// ✕ dismisses. Below THRESHOLD the row snaps back; at or above it, the row rests
// open and auto-closes after AUTO_CLOSE_MS if nothing is tapped.
//
// The gesture is horizontal-right only: the first few pixels decide the axis and
// a vertical intent is handed straight back to the list scroller untouched. It
// never fights useSwipeBack, which arms on a screen-EDGE drag over the THREAD
// pane — a different element entirely. Desktop keeps its hover ✕ and never
// swipes: no mouse events touch this.

const THRESHOLD = 80 // px of right-swipe needed to rest open
const REVEAL = 72 // resting offset once open (= width of the ✕ area)
const MAX = 100 // hard cap on the drag distance
const AXIS_LOCK = 8 // px of movement before the axis is decided
const AUTO_CLOSE_MS = 3000

export default function SwipeToDismiss({ level, onDismiss, children }) {
  const sliderRef = useRef(null)

  // Live gesture values — DOM-driven, deliberately NOT state (zero re-renders
  // per move). `open` state exists only to toggle the ✕'s focusability/aria.
  const startX = useRef(0)
  const startY = useRef(0)
  const dx = useRef(0)
  const axis = useRef(null) // null | 'x' | 'y', locked after AXIS_LOCK px
  const openRef = useRef(false)
  const swiped = useRef(false) // a horizontal drag happened this gesture
  const autoTimer = useRef(null)

  const [open, setOpen] = useState(false)

  const clearAuto = () => {
    if (autoTimer.current) {
      clearTimeout(autoTimer.current)
      autoTimer.current = null
    }
  }

  useEffect(() => {
    const el = sliderRef.current
    if (!el) return undefined

    const paint = (x, animate) => {
      el.style.transition = animate ? 'transform 0.25s ease' : 'none'
      el.style.transform = x ? `translateX(${x}px)` : ''
    }

    const close = () => {
      clearAuto()
      dx.current = 0
      openRef.current = false
      setOpen(false)
      el.classList.remove('is-swiping')
      paint(0, true)
    }

    const openReveal = () => {
      dx.current = REVEAL
      openRef.current = true
      setOpen(true)
      el.classList.remove('is-swiping')
      paint(REVEAL, true)
      clearAuto()
      autoTimer.current = setTimeout(close, AUTO_CLOSE_MS)
    }

    const onStart = (e) => {
      axis.current = null
      swiped.current = false
      startX.current = e.touches[0].clientX
      startY.current = e.touches[0].clientY
      // Take over any in-flight snap from wherever it currently sits.
      paint(dx.current, false)
    }

    const onMove = (e) => {
      const mx = e.touches[0].clientX - startX.current
      const my = e.touches[0].clientY - startY.current

      if (axis.current == null) {
        if (Math.abs(mx) < AXIS_LOCK && Math.abs(my) < AXIS_LOCK) return
        axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
        if (axis.current === 'x') {
          swiped.current = true
          clearAuto()
          el.classList.add('is-swiping')
        }
      }
      if (axis.current !== 'x') return // vertical → let the list scroll

      // Right-swipe only. From an open state a leftward drag pulls it shut.
      const base = openRef.current ? REVEAL : 0
      let next = base + mx
      if (next < 0) next = 0
      if (next > MAX) next = MAX
      dx.current = next
      // We own the gesture now — stop the scroll and iOS text selection.
      e.preventDefault()
      paint(next, false)
    }

    const onEnd = () => {
      if (axis.current !== 'x') return
      if (dx.current >= THRESHOLD) openReveal()
      else close()
    }

    // Expose close() to the React click/dismiss handlers below.
    el._swipeClose = close

    el.addEventListener('touchstart', onStart, { passive: true })
    // Non-passive so preventDefault() actually blocks scroll + text selection.
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      clearAuto()
      el._swipeClose = null
    }
  }, [])

  // A tap that concludes a swipe — or any tap while open — must not open the
  // conversation: swallow it here, and if open, snap shut instead.
  const onClickCapture = (e) => {
    if (openRef.current) {
      e.preventDefault()
      e.stopPropagation()
      sliderRef.current?._swipeClose?.()
    } else if (swiped.current) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const handleDismiss = (e) => {
    e.stopPropagation()
    clearAuto()
    // Snap shut with no animation — the row is about to lose its flag.
    const el = sliderRef.current
    if (el) {
      el.classList.remove('is-swiping')
      el.style.transition = 'none'
      el.style.transform = ''
    }
    dx.current = 0
    openRef.current = false
    setOpen(false)
    onDismiss()
  }

  return (
    <div className="conv-swipe">
      <div className={`conv-swipe-action conv-swipe-action--${level}`} aria-hidden={!open}>
        <button
          type="button"
          className="conv-swipe-x"
          aria-label="Dismiss attention flag"
          title="Dismiss attention flag"
          tabIndex={open ? 0 : -1}
          onClick={handleDismiss}
        >
          <X size={18} />
        </button>
      </div>
      <div ref={sliderRef} className="conv-swipe-slider" onClickCapture={onClickCapture}>
        {children}
      </div>
    </div>
  )
}
