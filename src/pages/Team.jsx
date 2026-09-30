import { useCallback, useEffect, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { UserPlus, KeyRound, Users, ArrowLeft } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import ResetPasswordModal from '../components/ResetPasswordModal.jsx'

const EMPTY_FORM = { name: '', email: '', password: '', role: 'agent', department: '' }

const DEPARTMENT_LABEL = { sales: 'Sales', operations: 'Operations' }

export default function Team() {
  const { isAdmin } = useAuth()
  const toast = useToast()

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [resetTarget, setResetTarget] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = await api.users()
      setUsers(data.users || [])
    } catch (err) {
      if (err.status !== 401) toast.error('Could not load the team', err.message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  // Agents never reach this page — the server enforces it too.
  if (!isAdmin) return <Navigate to="/inbox" replace />

  const createUser = async (e) => {
    e.preventDefault()
    setFormError(null)

    if (form.password.length < 8) {
      setFormError('Password must be at least 8 characters')
      return
    }
    if (form.role === 'agent' && !DEPARTMENT_LABEL[form.department]) {
      setFormError('Choose a department for the agent')
      return
    }

    setCreating(true)
    try {
      await api.createUser({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        department: form.role === 'agent' ? form.department : null,
      })
      toast.success('Agent added', `${form.name.trim()} can now sign in.`)
      setForm(EMPTY_FORM)
      load()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setCreating(false)
    }
  }

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  // Inline department edit from the team list. Optimistic, with revert on error.
  const changeDepartment = async (user, department) => {
    const previous = user.department ?? null
    if (previous === department) return
    setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, department } : u)))
    try {
      await api.setUserDepartment(user.id, department)
      toast.success('Department updated', `${user.name} is now in ${DEPARTMENT_LABEL[department]}.`)
    } catch (err) {
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, department: previous } : u)))
      toast.error('Could not update department', err.message)
    }
  }

  return (
    <div className="page-scroll">
      <div className="page-inner">
        {/* The mobile bottom nav is gone, so this is the way back to the inbox. */}
        <Link to="/inbox" className="btn btn-secondary btn-sm page-back">
          <ArrowLeft size={14} />
          Back to inbox
        </Link>

        <section className="card">
          <div className="card-head">
            <Users size={17} style={{ color: 'var(--text-2)' }} />
            <h2 className="card-title">Team</h2>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
              {users.length} {users.length === 1 ? 'member' : 'members'}
            </span>
          </div>

          {loading ? (
            <div className="card-body">
              <span className="spinner" style={{ color: 'var(--text-3)' }} />
            </div>
          ) : (
            users.map((user) => (
              <div key={user.id} className="user-row">
                <div className="user-row-id">
                  <div className="user-row-name">{user.name}</div>
                  <div className="user-row-email">{user.email}</div>
                </div>

                <div className="user-row-tags">
                  <span className={`pill ${user.role === 'admin' ? 'pill-admin' : 'pill-agent'}`}>
                    {user.role === 'admin' ? 'Admin' : 'Agent'}
                  </span>
                  <span className={`pill ${user.is_active ? 'pill-active' : 'pill-inactive'}`}>
                    {user.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>

                {/* Admins have no department, so no control. An agent shows and
                    edits theirs inline; a department-less agent starts on the
                    disabled placeholder. */}
                {user.role === 'agent' ? (
                  <select
                    className="select user-dept-select"
                    aria-label={`Department for ${user.name}`}
                    value={user.department || ''}
                    onChange={(e) => changeDepartment(user, e.target.value)}
                  >
                    <option value="" disabled>
                      No department
                    </option>
                    <option value="sales">Sales</option>
                    <option value="operations">Operations</option>
                  </select>
                ) : null}

                <div className="user-row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setResetTarget(user)}
                  >
                    <KeyRound size={14} />
                    Reset password
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <UserPlus size={17} style={{ color: 'var(--text-2)' }} />
            <h2 className="card-title">Add an agent</h2>
          </div>

          <div className="card-body">
            <form className="form-grid" onSubmit={createUser}>
              {formError ? (
                <div className="alert alert-error" style={{ gridColumn: '1 / -1' }}>
                  {formError}
                </div>
              ) : null}

              <div className="field">
                <label className="label" htmlFor="new-name">
                  Name
                </label>
                <input
                  id="new-name"
                  className="input"
                  value={form.name}
                  onChange={update('name')}
                  placeholder="Priya Sharma"
                  required
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="new-email">
                  Email
                </label>
                <input
                  id="new-email"
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={form.email}
                  onChange={update('email')}
                  placeholder="priya@company.com"
                  required
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="new-password">
                  Password
                </label>
                <input
                  id="new-password"
                  className="input"
                  type="text"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={update('password')}
                  placeholder="At least 8 characters"
                  required
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="new-role">
                  Role
                </label>
                <select
                  id="new-role"
                  className="select"
                  value={form.role}
                  onChange={update('role')}
                >
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {/* Department is required for agents; admins have none, so the
                  selector is hidden when the role is Admin. */}
              {form.role === 'agent' ? (
                <div className="field">
                  <label className="label" htmlFor="new-department">
                    Department
                  </label>
                  <select
                    id="new-department"
                    className="select"
                    value={form.department}
                    onChange={update('department')}
                    required
                  >
                    <option value="" disabled>
                      Select department
                    </option>
                    <option value="sales">Sales</option>
                    <option value="operations">Operations</option>
                  </select>
                </div>
              ) : null}

              <div className="form-grid-actions">
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? <span className="spinner" /> : <UserPlus size={15} />}
                  Add agent
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>

      {resetTarget ? (
        <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />
      ) : null}
    </div>
  )
}
