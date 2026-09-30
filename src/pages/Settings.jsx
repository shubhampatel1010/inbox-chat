import { useCallback, useEffect, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Building2,
  KeyRound,
  Plus,
  Users,
  Webhook,
  Wifi,
  Copy,
  Check,
  AlertTriangle,
  Lock,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useAccounts } from '../context/AccountContext.jsx'

/**
 * Admin settings — accounts, their credentials, and who can reach them.
 *
 * The page is organised around ONE selected account, because that is how the
 * admin thinks about it: pick the account, then configure everything about it.
 * The system-wide credentials are shown read-only at the bottom so it is clear
 * they are deliberately shared rather than missing from the per-account form.
 */
export default function Settings() {
  const { isAdmin } = useAuth()
  const { reload: reloadAccounts } = useAccounts()

  const [accounts, setAccounts] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)

  const [settings, setSettings] = useState(null)
  const [system, setSystem] = useState(null)
  const [members, setMembers] = useState([])

  const [form, setForm] = useState({ name: '', business_number: '', whapi_api_url: '', whapi_token: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)

  const [newAccountName, setNewAccountName] = useState('')
  const [creating, setCreating] = useState(false)

  // ---- loaders -------------------------------------------------------

  const loadAccounts = useCallback(async () => {
    try {
      const data = await api.accounts({ all: true })
      const rows = data.accounts || []
      setAccounts(rows)
      // Select the first account on a cold start so the page is never an empty
      // shell waiting for a click.
      setSelectedId((current) => current ?? (rows.length ? rows[0].id : null))
      return rows
    } catch (err) {
      setError(err.message || 'Failed to load accounts')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAccount = useCallback(async (accountId) => {
    if (!accountId) return
    setError(null)
    setTestResult(null)
    try {
      const [detail, roster] = await Promise.all([
        api.accountSettings(accountId),
        api.accountUsers(accountId),
      ])
      setSettings(detail.settings)
      setSystem(detail.system)
      setMembers(roster.users || [])
      setForm({
        name: detail.account?.name || '',
        business_number: detail.settings?.business_number || '',
        whapi_api_url: detail.settings?.whapi_api_url || '',
        // Always blank: the stored token is never sent to the browser, and a
        // blank field means "leave it as it is" on save.
        whapi_token: '',
      })
    } catch (err) {
      setError(err.message || 'Failed to load account settings')
    }
  }, [])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    loadAccount(selectedId)
  }, [selectedId, loadAccount])

  if (!isAdmin) return <Navigate to="/inbox" replace />

  const selected = accounts.find((a) => String(a.id) === String(selectedId)) || null

  // ---- actions -------------------------------------------------------

  const createAccount = async (event) => {
    event.preventDefault()
    const name = newAccountName.trim()
    if (!name) return

    setCreating(true)
    setError(null)
    try {
      const data = await api.createAccount({ name })
      setNewAccountName('')
      await loadAccounts()
      // Jump straight to the new account — creating one is always followed by
      // configuring it.
      setSelectedId(data.account.id)
      setNotice(`Account "${data.account.name}" created. Configure its channel below.`)
      reloadAccounts()
    } catch (err) {
      setError(err.message || 'Failed to create account')
    } finally {
      setCreating(false)
    }
  }

  const saveSettings = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const payload = {
        account_id: selectedId,
        name: form.name,
        business_number: form.business_number,
        whapi_api_url: form.whapi_api_url,
      }
      // Only send the token when one was actually typed — an empty field must
      // not wipe the stored credential.
      if (form.whapi_token.trim()) payload.whapi_token = form.whapi_token.trim()

      await api.saveAccountSettings(payload)
      setNotice('Settings saved.')
      await loadAccounts()
      await loadAccount(selectedId)
      reloadAccounts()
    } catch (err) {
      setError(err.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const rotateWebhook = async () => {
    // Rotating breaks inbound delivery until the new URL is pasted into Whapi,
    // so it is always confirmed rather than being a one-click surprise.
    const existing = settings?.webhook_url
    if (
      existing &&
      !window.confirm(
        'Generate a new webhook URL?\n\nThe current URL stops working immediately, and inbound messages will not arrive until you paste the new one into this account’s Whapi channel.'
      )
    ) {
      return
    }

    setSaving(true)
    setError(null)
    try {
      await api.saveAccountSettings({ account_id: selectedId, rotate_webhook_secret: true })
      await loadAccount(selectedId)
      setNotice('New webhook URL generated. Paste it into this account’s Whapi channel.')
    } catch (err) {
      setError(err.message || 'Failed to generate a webhook URL')
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.testAccount(selectedId))
    } catch (err) {
      setTestResult({ connected: false, error: err.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const toggleActive = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      await api.saveAccountSettings({ account_id: selectedId, is_active: !selected.is_active })
      await loadAccounts()
      reloadAccounts()
    } catch (err) {
      setError(err.message || 'Failed to update the account')
    } finally {
      setSaving(false)
    }
  }

  /** Optimistic membership toggle — reverted on failure. */
  const toggleMember = async (user) => {
    if (user.locked) return

    const next = members.map((m) => (m.id === user.id ? { ...m, assigned: !m.assigned } : m))
    setMembers(next)

    try {
      await api.setAccountUsers(
        selectedId,
        next.filter((m) => m.assigned && !m.locked).map((m) => m.id)
      )
    } catch (err) {
      setMembers(members)
      setError(err.message || 'Failed to update user assignment')
    }
  }

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(settings.webhook_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked — the field is selectable, so this is recoverable.
    }
  }

  const update = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }))

  // ---- render --------------------------------------------------------

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <Link to="/inbox" className="btn btn-secondary btn-sm page-back">
          <ArrowLeft size={14} />
          Back to inbox
        </Link>

        <header className="page-head">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            Manage accounts, their WhatsApp channels, and who can reach them.
          </p>
        </header>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {notice ? <div className="alert alert-info">{notice}</div> : null}

        {/* ---- Account picker + create ---- */}
        <section className="card">
          <div className="card-head">
            <Building2 size={17} className="card-icon" />
            <h2 className="card-title">Accounts</h2>
            <span className="card-meta">
              {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
            </span>
          </div>

          <div className="card-body">
            {loading ? (
              <span className="spinner" style={{ color: 'var(--text-3)' }} />
            ) : (
              <>
                <div className="field">
                  <label className="label" htmlFor="account-select">
                    Selected account
                  </label>
                  <select
                    id="account-select"
                    className="select"
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(Number(e.target.value))}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.business_number ? ` (+${a.business_number})` : ''}
                        {a.is_active ? '' : ' — inactive'}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    Everything in the next section applies to this account only. Each account has
                    its own WhatsApp number, credentials, chats and users.
                  </p>
                </div>

                <form className="settings-inline-form" onSubmit={createAccount}>
                  <input
                    className="input"
                    placeholder="New account name"
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                  />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
                    {creating ? <span className="spinner" /> : <Plus size={14} />}
                    Add account
                  </button>
                </form>
              </>
            )}
          </div>
        </section>

        {selected ? (
          /* The three cards below all configure the ONE selected account. The
             group heading and left rule say so visually, so switching accounts
             obviously re-points all of them at once. */
          <div className="settings-group">
            <div className="settings-group-head">
              <h2 className="settings-group-title">Configuring</h2>
              <span className="settings-group-name">
                {selected.name}
                {selected.business_number ? ` · +${selected.business_number}` : ''}
              </span>
            </div>

            {/* ---- Per-account channel credentials ---- */}
            <section className="card">
              <div className="card-head">
                <KeyRound size={17} className="card-icon" />
                <h2 className="card-title">Channel &amp; credentials</h2>
                <span className={`pill ${selected.configured ? 'pill-active' : 'pill-inactive'}`}>
                  {selected.configured ? 'Configured' : 'Not configured'}
                </span>
              </div>

              <div className="card-body">
                <form className="form-grid" onSubmit={saveSettings}>
                  <div className="field">
                    <label className="label" htmlFor="acct-name">Account name</label>
                    <input id="acct-name" className="input" value={form.name} onChange={update('name')} />
                  </div>

                  <div className="field">
                    <label className="label" htmlFor="acct-number">WhatsApp business number</label>
                    <input
                      id="acct-number"
                      className="input"
                      placeholder="6580119456"
                      value={form.business_number}
                      onChange={update('business_number')}
                    />
                    <p className="field-hint">
                      Digits only, including the country code. This is the number this account
                      sends from.
                    </p>
                  </div>

                  <div className="field">
                    <label className="label" htmlFor="acct-token">Whapi API token</label>
                    <input
                      id="acct-token"
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        settings?.whapi_token_masked
                          ? `Currently ${settings.whapi_token_masked} — leave blank to keep`
                          : 'Paste this account’s Whapi token'
                      }
                      value={form.whapi_token}
                      onChange={update('whapi_token')}
                    />
                    <p className="field-hint">
                      Encrypted before storage and never shown again. Leave blank to keep the
                      current token.
                      {settings?.sources?.whapi_token === 'environment' ? (
                        <> This account is currently using the system environment token.</>
                      ) : null}
                    </p>
                  </div>

                  <div className="field">
                    <label className="label" htmlFor="acct-url">Whapi API URL</label>
                    <input
                      id="acct-url"
                      className="input"
                      placeholder="https://gate.whapi.cloud"
                      value={form.whapi_api_url}
                      onChange={update('whapi_api_url')}
                    />
                    <p className="field-hint">Optional. Defaults to https://gate.whapi.cloud.</p>
                  </div>

                  <div className="settings-actions form-grid-full">
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                      {saving ? <span className="spinner" /> : null}
                      Save settings
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={testConnection}
                      disabled={testing}
                    >
                      {testing ? <span className="spinner" /> : <Wifi size={14} />}
                      Test connection
                    </button>

                    <button type="button" className="btn btn-secondary" onClick={toggleActive} disabled={saving}>
                      {selected.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </form>

                {testResult ? (
                  <div className={`alert ${testResult.connected ? 'alert-info' : 'alert-error'}`}>
                    {testResult.connected
                      ? `Connected${testResult.status ? ` — ${testResult.status}` : ''}`
                      : `Not connected${testResult.status ? ` — ${testResult.status}` : ''}${
                          testResult.error ? `: ${testResult.error}` : ''
                        }`}
                  </div>
                ) : null}
              </div>
            </section>

            {/* ---- Webhook ---- */}
            <section className="card">
              <div className="card-head">
                <Webhook size={17} className="card-icon" />
                <h2 className="card-title">Inbound webhook</h2>
              </div>

              <div className="card-body">
                <p className="sync-lede">
                  Paste this URL into this account&rsquo;s Whapi channel so its messages arrive
                  here. Each account has its own URL — that is how an incoming message is matched
                  to the right account.
                </p>

                {settings?.webhook_url ? (
                  <div className="settings-inline-form">
                    <input
                      className="input settings-webhook-url"
                      readOnly
                      value={settings.webhook_url}
                      onFocus={(e) => e.target.select()}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={copyWebhook}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : (
                  <div className="alert alert-warn">
                    <AlertTriangle size={15} />
                    <span>
                      No webhook URL yet.
                      {settings?.sources?.webhook_secret === 'environment'
                        ? ' This account is using the original system webhook, which still works. Generate a dedicated URL when you are ready.'
                        : ' Generate one and paste it into Whapi.'}
                    </span>
                  </div>
                )}

                <div className="settings-actions">
                  <button type="button" className="btn btn-secondary" onClick={rotateWebhook} disabled={saving}>
                    <KeyRound size={14} />
                    {settings?.webhook_url ? 'Generate a new URL' : 'Generate webhook URL'}
                  </button>
                </div>
              </div>
            </section>

            {/* ---- Users on this account ---- */}
            <section className="card">
              <div className="card-head">
                <Users size={17} className="card-icon" />
                <h2 className="card-title">Users on this account</h2>
                <span className="card-meta">
                  {members.filter((m) => m.assigned).length} of {members.length} assigned
                </span>
              </div>

              <div className="card-body">
                <p className="sync-lede">
                  Assigned users see this account&rsquo;s chats. Admins always have access to every
                  account, so they cannot be unassigned here.
                </p>
              </div>

              {/* Scrolls within the card past ~6 rows so a long roster cannot
                  push the sections below it off the page. */}
              <div className="settings-user-list">
                {members.length ? (
                  members.map((user) => (
                    <div key={user.id} className="user-row">
                      <div className="user-row-id">
                        <div className="user-row-name">{user.name}</div>
                        <div className="user-row-email">{user.email}</div>
                      </div>

                      <div className="user-row-tags">
                        <span className={`pill ${user.role === 'admin' ? 'pill-admin' : 'pill-agent'}`}>
                          {user.role === 'admin' ? 'Admin' : 'Agent'}
                        </span>
                        {user.department ? <span className="pill">{user.department}</span> : null}
                        {user.is_active ? null : <span className="pill pill-inactive">Inactive</span>}
                      </div>

                      <div className="user-row-actions">
                        <label className="settings-toggle">
                          <input
                            type="checkbox"
                            checked={user.assigned}
                            disabled={user.locked}
                            onChange={() => toggleMember(user)}
                          />
                          <span>
                            {user.locked ? (
                              <>
                                <Lock size={12} /> All accounts
                              </>
                            ) : (
                              'Assigned'
                            )}
                          </span>
                        </label>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="settings-empty">No users yet.</p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {/* ---- System-wide, read-only ---- */}
        <section className="card">
          <div className="card-head">
            <Lock size={17} className="card-icon" />
            <h2 className="card-title">System-wide credentials</h2>
            <span className="card-meta">Shared by every account</span>
          </div>

          <div className="card-body">
            <p className="sync-lede">
              These are shared by every account and are set as environment variables on the
              deployment, not here. They are shown so you can confirm they are present.
            </p>

            <div className="settings-system-grid">
              {[
                ['Supabase URL', system?.supabase_url],
                ['Supabase service role key', system?.supabase_service_role_key],
                ['OpenRouter API key', system?.openrouter_api_key],
                ['Encryption key', system?.encryption_key],
              ].map(([label, state]) => (
                <div key={label} className="settings-system-row">
                  <span>{label}</span>
                  <span className={`pill ${state === 'configured' ? 'pill-active' : 'pill-inactive'}`}>
                    {state === 'configured' ? 'Configured' : 'Not set'}
                  </span>
                </div>
              ))}
            </div>

            {system && system.encryption_key !== 'configured' ? (
              <div className="alert alert-warn">
                <AlertTriangle size={15} />
                <span>
                  ENCRYPTION_KEY is not set, so per-account tokens cannot be stored. Accounts will
                  keep using the system environment credentials until you add it.
                </span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
