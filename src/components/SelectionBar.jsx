import { Forward } from 'lucide-react'

/**
 * Bottom action bar shown while the thread is in selection mode. Replaces the
 * reply box rather than stacking above it — the two are mutually exclusive
 * modes, and on a phone there is not room for both.
 */
export default function SelectionBar({ count, onCancel, onForward }) {
  return (
    <div className="sel-bar" role="toolbar" aria-label="Message selection">
      <span className="sel-count" aria-live="polite">
        {count} selected
      </span>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={count === 0}
        onClick={onForward}
      >
        <Forward size={16} aria-hidden="true" />
        Forward
      </button>
    </div>
  )
}
