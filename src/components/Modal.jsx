import { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * `className` is appended to the overlay, not the panel — the one thing a
 * caller has ever needed to vary is the stacking level, and that belongs to the
 * backdrop. Optional, so every existing call site is unaffected.
 */
export default function Modal({ title, subtitle, onClose, className = '', children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={`overlay${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
