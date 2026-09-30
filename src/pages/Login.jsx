import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'

export default function Login() {
  const { login, isAuthenticated } = useAuth()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  if (isAuthenticated) {
    return <Navigate to={location.state?.from || '/inbox'} replace />
  }

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-mark">
          <MessageSquare size={20} />
        </div>

        <h1 className="login-title">Team Inbox</h1>
        <p className="login-sub">Sign in to reply to customer WhatsApp messages.</p>

        <form className="login-form" onSubmit={submit}>
          {error ? <div className="alert alert-error">{error}</div> : null}

          <div className="field">
            <label className="label" htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Sign in
          </button>
        </form>
      </div>
    </div>
  )
}
