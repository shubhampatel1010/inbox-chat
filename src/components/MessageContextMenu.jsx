import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Forward, Copy, Reply } from 'lucide-react'

// Distance kept between the menu and the viewport edge when it has to be
// nudged back inside.
const EDGE_GAP = 8

/**
 * Context menu for a single message — long-press on touch, right-click on
 * desktop. Positioned at the pointer, then clamped so it can never open
 * partially offscreen (which on mobile is the difference between usable and
 * not, since there is no way to scroll a fixed overlay back into view).
 */
export default function MessageContextMenu({ x, y, message, onForward, onReply, onClose }) {
  const ref = useRef(null)
  // Start at the raw pointer position and correct after measuring: the menu's
  // size depends on which items render, so it cannot be known before layout.
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()

    setPos({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      // Prefer opening below the finger; flip above only when there is no room,
      // so the menu does not cover the message being acted on.
      top: y + height + EDGE_GAP > window.innerHeight
        ? Math.max(EDGE_GAP, y - height)
        : y,
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    // Capture phase: close before anything underneath can treat the scroll or
    // click as its own interaction.
    const onDismiss = () => onClose()

    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [onClose])

  const text = message?.body || message?.media_caption || ''

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard is permission-gated and unavailable on insecure origins.
      // Copy is a convenience here, so a failure closes the menu quietly
      // rather than raising an error the user cannot act on.
    }
    onClose()
  }

  return (
    <button
      type="button"
      className="ctx-backdrop"
      aria-label="Dismiss menu"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        // A second right-click anywhere dismisses rather than opening the
        // browser's own menu on top of ours.
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        // The backdrop closes on mousedown; without this the menu's own
        // buttons would never receive their click.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {onReply ? (
          <button type="button" className="ctx-item" role="menuitem" onClick={onReply}>
            <Reply size={16} aria-hidden="true" />
            Reply
          </button>
        ) : null}
        <button type="button" className="ctx-item" role="menuitem" onClick={onForward}>
          <Forward size={16} aria-hidden="true" />
          Forward
        </button>
        {text ? (
          <button type="button" className="ctx-item" role="menuitem" onClick={copyText}>
            <Copy size={16} aria-hidden="true" />
            Copy text
          </button>
        ) : null}
      </div>
    </button>
  )
}
