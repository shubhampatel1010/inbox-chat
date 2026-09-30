import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'

/**
 * Wraps the thread area and accepts files dragged in from the desktop.
 *
 * Dropped files go to the same handler the paperclip button uses, so there is
 * one validation path and one upload path — this component only decides WHEN
 * files arrive, never what happens to them.
 *
 * The counter is the crux: dragenter/dragleave fire for every descendant the
 * pointer crosses, so tracking a boolean makes the overlay strobe as the cursor
 * moves over bubbles. Counting enters minus leaves is stable regardless of how
 * many children the thread has. relatedTarget alone is unreliable here — it is
 * null when the pointer leaves the window entirely in several browsers.
 */
export default function DropZone({ onFiles, disabled = false, className = '', children }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setActive(false)
  }, [])

  // A drop released outside the zone (or a drag abandoned with Escape) never
  // fires our own dragleave, which would strand the overlay on screen.
  useEffect(() => {
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [reset])

  // Only a drag carrying actual FILES should light up the zone. Dragging
  // selected text, a link, or an image within the page must not offer to send.
  const hasFiles = (event) => {
    const types = event.dataTransfer?.types
    return types ? [...types].includes('Files') : false
  }

  if (disabled) return <div className={className}>{children}</div>

  return (
    <div
      className={className}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        setActive(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        // Without preventDefault on EVERY dragover the browser refuses the
        // drop and opens the file in a new tab instead.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current -= 1
        if (depth.current <= 0) reset()
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        reset()
        const files = [...(e.dataTransfer?.files || [])]
        if (files.length) onFiles?.(files)
      }}
    >
      {children}

      {active ? (
        <div className="dropzone-overlay" aria-hidden="true">
          <div className="dropzone-inner">
            <Upload size={28} />
            <span className="dropzone-text">Drop files to send</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
