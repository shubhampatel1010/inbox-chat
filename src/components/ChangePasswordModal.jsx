import { useState } from 'react'
import { api } from '../lib/api.js'
import { useToast } from '../context/ToastContext.jsx'
import Modal from './Modal.jsx'

export default function ChangePasswordModal({ onClose }) {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)

    if (next.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }
    if (next !== confirm) {
      setError('The two new passwords do not match')
      return
    }

    setSaving(true)
    try {
      await api.changePassword(current, next)
      toast.success('Password changed', 'Use your new password next time you sign in.')
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Change password"
      subtitle="Choose a new password of at least 8 characters."
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="field">
          <label className="label" htmlFor="cp-current">
            Current password
          </label>
          <input
            id="cp-current"
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="cp-new">
            New password
          </label>
          <input
            id="cp-new"
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="cp-confirm">
            Confirm new password
          </label>
          <input
            id="cp-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <span className="spinner" /> : null}
            Update password
          </button>
        </div>
      </form>
    </Modal>
  )
}
