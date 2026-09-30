import { useState } from 'react'
import Modal from './Modal.jsx'
import {
  REASON_CATEGORIES,
  MIN_NOTE_LENGTH,
  isReasonComplete,
} from '../lib/attentionReasons.js'

/**
 * The reason sheet shown before an attention flag is cleared.
 *
 * Clearing a flag used to be a single unexplained tap. This is the friction that
 * replaces it: a category plus a short note, neither optional. It is also the
 * ONLY confirmation step — the sheet is itself the "are you sure", so nothing
 * here asks a second time.
 *
 * It does not call the API. The parent owns the request and the Undo toast that
 * follows; this collects the reason and hands it over. That keeps the dismissal
 * flow in one place (Inbox) rather than splitting it across a modal that
 * half-knows about conversations.
 *
 * Validation here only enables the button. The server re-checks the category,
 * the note length, the caller's role against the flag's severity and the
 * "no response" time window — and a rejection comes back as `error`, rendered
 * in the same alert slot, because several of those checks cannot be made in
 * the browser at all.
 */
export default function DismissReasonModal({ level, error, saving, onCancel, onConfirm }) {
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')

  const selected = REASON_CATEGORIES.find((c) => c.id === category) || null
  const complete = isReasonComplete(category, note)

  const submit = (e) => {
    e.preventDefault()
    if (!complete || saving) return
    onConfirm({ reason_category: category, reason_note: note.trim() })
  }

  // How many more characters the note needs. Shown only once the agent has
  // started typing: displaying "15 more characters" against an untouched empty
  // box reads as a complaint about something they have not done yet.
  const remaining = MIN_NOTE_LENGTH - note.trim().length
  const showRemaining = note.length > 0 && remaining > 0

  return (
    <Modal
      title="Why are you closing this?"
      subtitle={
        level === 'management'
          ? 'This is flagged for management attention. The reason is recorded against your name.'
          : 'The reason is recorded in the audit trail against your name.'
      }
      onClose={onCancel}
      className="overlay--dismiss-reason"
    >
      <form className="modal-form" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="field">
          <span className="label" id="dismiss-reason-label">
            Reason
          </span>
          <div className="dismiss-reasons" role="radiogroup" aria-labelledby="dismiss-reason-label">
            {REASON_CATEGORIES.map((c) => (
              <label
                key={c.id}
                className={`dismiss-reason${category === c.id ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="dismiss-reason"
                  value={c.id}
                  checked={category === c.id}
                  onChange={() => setCategory(c.id)}
                />
                <span className="dismiss-reason-label">{c.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="dismiss-note">
            What happened?
          </label>
          <textarea
            id="dismiss-note"
            className="input dismiss-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={selected ? selected.hint : 'Pick a reason above, then describe what happened.'}
            maxLength={2000}
          />
          {showRemaining ? (
            <p className="field-hint">{remaining} more characters needed.</p>
          ) : null}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!complete || saving}>
            {saving ? <span className="spinner" /> : null}
            Close flag
          </button>
        </div>
      </form>
    </Modal>
  )
}
