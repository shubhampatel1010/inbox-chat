import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

// Pull-down-to-refresh for the conversation list, TOUCH ONLY. Desktop keeps the
// existing poll and never sees this.
//
// Smoothness: the pull distance is driven DIRECTLY on the DOM via refs — never
// React state — so a drag causes ZERO re-renders. The rows live in a `.ptr-track`
// wrapper that slides down with a GPU `transform: translateY()` (no width/height
// change → no layout), coalesced through requestAnimationFrame. The indicator
// sits behind the track and is revealed in the gap. React state is used only for
// the coarse phase flips (idle ↔ armed ↔ refreshing), which change at most once
// per gesture, and a CSS transition animates the release.

const THRESHOLD = 60 // px pulled before a release triggers a refresh
const MAX_PULL = 90 // clamp on the drag distance
const REFRESH_HOLD = 60 // px the track holds open under the spinner while refreshing
const RESISTANCE = 0.5 // the track moves at half the finger's distance
const SETTLE = 'transform 0.3s ease'

const isTouch =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0)

export default function PullToRefresh({ onRefresh, className = '', children }) {
  const scrollRef = useRef(null)
  const trackRef = useRef(null)

  // Live gesture values — DOM-driven, deliberately NOT state.
  const startY = useRef(null)
  const pull = useRef(0)
  const raf = useRef(0)
  const refreshingRef = useRef(false)

  // Coarse phase, for the indicator text/spinner only (flips ≤ once per gesture).
  const [refreshing, setRefreshing] = useState(false)
  const [armed, setArmed] = useState(false)

  // Latest onRefresh without re-binding the native listeners.
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    if (!isTouch) return undefined
    const scroller = scrollRef.current
    const track = trackRef.current
    if (!scroller || !track) return undefined

    // Push the live pull straight to the compositor — no React render.
    const paint = () => {
      raf.current = 0
      track.style.transform = pull.current ? `translateY(${pull.current}px)` : ''
    }
    const schedule = () => {
      if (!raf.current) raf.current = requestAnimationFrame(paint)
    }

    const onStart = (e) => {
      if (refreshingRef.current) return
      // Arm only when already at the very top; otherwise this is a normal scroll.
      startY.current = scroller.scrollTop <= 0 ? e.touches[0].clientY : null
      track.style.transition = 'none' // track the finger 1:1 during the drag
    }

    const onMove = (e) => {
      if (startY.current == null || refreshingRef.current) return
      if (scroller.scrollTop > 0) {
        // Scrolled up into content — abandon the pull.
        startY.current = null
        if (pull.current) {
          pull.current = 0
          schedule()
        }
        return
      }
      const dy = e.touches[0].clientY - startY.current
      if (dy <= 0) {
        if (pull.current) {
          pull.current = 0
          schedule()
        }
        return
      }
      // We own the gesture: stop the native rubber-band so the track tracks it.
      e.preventDefault()
      pull.current = Math.min(MAX_PULL, dy * RESISTANCE)
      schedule()
      const nowArmed = pull.current >= THRESHOLD
      setArmed((a) => (a === nowArmed ? a : nowArmed))
    }

    const settle = () => {
      track.style.transition = SETTLE
      track.style.transform = ''
      pull.current = 0
    }

    const onEnd = async () => {
      if (startY.current == null) return
      startY.current = null
      if (raf.current) {
        cancelAnimationFrame(raf.current)
        raf.current = 0
      }

      if (pull.current >= THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true
        setRefreshing(true)
        setArmed(false)
        // Hold the track open under the spinner, animated.
        track.style.transition = SETTLE
        track.style.transform = `translateY(${REFRESH_HOLD}px)`
        try {
          await onRefreshRef.current?.()
        } catch {
          /* refresh() swallows its own errors; nothing to surface here */
        }
        refreshingRef.current = false
        setRefreshing(false)
        settle()
      } else {
        setArmed(false)
        settle()
      }
    }

    scroller.addEventListener('touchstart', onStart, { passive: true })
    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd)
    scroller.addEventListener('touchcancel', onEnd)
    return () => {
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [])

  return (
    <div ref={scrollRef} className={className}>
      {isTouch ? (
        <div className="ptr-indicator" aria-hidden={!refreshing && !armed}>
          {refreshing ? (
            <span className="spinner" role="status" aria-label="Refreshing" />
          ) : (
            <span className={`ptr-hint${armed ? ' is-armed' : ''}`}>
              <ArrowDown size={15} className="ptr-arrow" aria-hidden="true" />
              {armed ? 'Release to refresh' : 'Pull to refresh'}
            </span>
          )}
        </div>
      ) : null}
      <div ref={trackRef} className="ptr-track">
        {children}
      </div>
    </div>
  )
}
