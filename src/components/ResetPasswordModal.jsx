import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { api } from '../lib/api.js'
import { useToast } from '../context/ToastContext.jsx'
import Modal from './Modal.jsx'

export default function ResetPasswordModal({ user, onClose }) {
  const toast = useToast()
  const [mode, setMode] = useState('generate') // 'generate' | 'manual'
  const [manual, setManual] = useState('')
  const [tempPassword, setTempPassword] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)

    if (mode === 'manual' && manual.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setSaving(true)
    try {
      const data = await api.resetPassword(user.id, mode === 'manual' ? manual : null)
      if (data.temp_password) {
        // Only shown once — the admin has to hand it over now.
        setTempPassword(data.temp_password)
      } else {
        toast.success('Password reset', `${user.name} can sign in with the new password.`)
        onClose()
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy', 'Select the password and copy it manually.')
    }
  }

  if (tempPassword) {
    return (
      <Modal
        title="Temporary password"
        subtitle={`Share this with ${user.name}. It will not be shown again.`}
        onClose={onClose}
      >
        <div className="modal-form">
          <div className="code-box">
            <span>{tempPassword}</span>
            <button type="button" className="icon-btn" aria-label="Copy password" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div className="alert alert-info">
            Ask them to change it after signing in.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Reset password" subtitle={`For ${user.name} · ${user.email}`} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="field">
          <label className="label" htmlFor="rp-mode">
            Method
          </label>
          <select
            id="rp-mode"
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="generate">Generate a temporary password</option>
            <option value="manual">Set a specific password</option>
          </select>
        </div>

        {mode === 'manual' ? (
          <div className="field">
            <label className="label" htmlFor="rp-password">
              New password
            </label>
            <input
              id="rp-password"
              className="input"
              type="text"
              autoComplete="off"
              placeholder="At least 8 characters"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              required
            />
          </div>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <span className="spinner" /> : null}
            Reset password
          </button>
        </div>
      </form>
    </Modal>
  )
}
