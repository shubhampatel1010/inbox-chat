import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Play, CheckCircle2, AlertTriangle, Zap } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useChannel } from '../context/ChannelContext.jsx'
import { useAccounts } from '../context/AccountContext.jsx'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TERMINAL = new Set(['done', 'failed', 'canceled'])

function isoDay(offsetDays = 0) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

/** unix seconds -> a short local date/time. */
function fmtTs(ts) {
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Is this an automatic outage-recovery job? */
const isAuto = (job) => job?.scope?.type === 'auto'

/** Human label for a job's scope. */
function scopeLabel(job) {
  const s = job?.scope || {}
  if (s.type === 'auto') return `${fmtTs(s.from_ts)} → ${fmtTs(s.to_ts)}`
  if (s.type === 'range') return `${s.from} → ${s.to}`
  if (s.type === 'conversation') return `Conversation #${s.conversation_id}`
  return '—'
}

/**
 * Recovery status page — READ-ONLY plus the deferred "Run" action.
 *
 * There are no manual sync controls: gap recovery runs automatically when the
 * channel reconnects (see ChannelContext + functions/_lib/channel-gap.js).
 * Manual date-range / single-conversation syncs were removed — on a large range
 * they could blow the Worker subrequest limit, and auto-recovery covers the
 * real need. The backend sync engine, the step endpoint and the auto-driver are
 * all untouched; this page only observes them, and lets an admin deliberately
 * run a gap that was too long to auto-run.
 */
export default function Sync() {
  const { isAdmin } = useAuth()
  const channel = useChannel()
  // Recovery runs against ONE account's channel, so the page follows the same
  // selection the inbox uses, and lets the admin override it per sync.
  const { accounts, hasMultiple, accountId: selectedAccountId, nameFor } = useAccounts()

  const [job, setJob] = useState(null)
  const [jobs, setJobs] = useState([])
  const [driving, setDriving] = useState(false)
  const [error, setError] = useState(null)
  const [fromDate, setFromDate] = useState(() => isoDay(-1))
  const [toDate, setToDate] = useState(() => isoDay(1))
  const [syncAccountId, setSyncAccountId] = useState(
    () => selectedAccountId ?? null
  )

  const drivingRef = useRef(false)

  const loadJobs = useCallback(async () => {
    try {
      const d = await api.syncStatus()
      setJobs(d.jobs || [])
      return d.jobs || []
    } catch {
      return []
    }
  }, [])

  // Recent jobs, loaded once then polled so auto-recoveries (driven from
  // ChannelContext) and their results show up live.
  useEffect(() => {
    let cancelled = false
    loadJobs()
    const t = setInterval(() => !cancelled && loadJobs(), 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [loadJobs])

  /**
   * Drive a job's bounded steps to completion. Only used to run a DEFERRED
   * auto-recovery an admin chose to run (promote:true flips it from deferred).
   * Auto-recoveries inside the threshold drive themselves from ChannelContext.
   */
  const drive = useCallback(
    async (jobId) => {
      drivingRef.current = true
      setDriving(true)
      setError(null)
      try {
        // eslint-disable-next-line no-constant-condition
        while (drivingRef.current) {
          const res = await api.syncStep(jobId, { promote: true })
          setJob(res.job)
          if (res.done || TERMINAL.has(res.job?.status)) break
          // Lease held elsewhere, a manual/other sync active, or a soft backoff.
          if (res.busy || res.backoff || res.deferred) await sleep(1500)
        }
      } catch (err) {
        if (err.status !== 401) setError(err.message || 'Sync step failed')
      } finally {
        drivingRef.current = false
        setDriving(false)
        loadJobs()
      }
    },
    [loadJobs]
  )

  // Admin runs a deferred (too-long) auto-recovery deliberately.
  const runDeferred = (deferred) => {
    setJob(deferred)
    drive(deferred.id)
  }

  const startRangeSync = async (event) => {
    event.preventDefault()
    if (driving) return
    if (!fromDate || !toDate || fromDate > toDate) {
      setError('Choose a valid date range (the start date must be on or before the end date).')
      return
    }

    setError(null)
    try {
      const result = await api.syncStart({
        type: 'range',
        from: fromDate,
        to: toDate,
        ...(syncAccountId ? { account_id: syncAccountId } : {}),
      })
      setJob(result.job)
      drive(result.job.id)
    } catch (err) {
      if (err.status !== 401) setError(err.message || 'Could not start sync')
    }
  }

  const clearHalt = async () => {
    try {
      await api.clearAutoHalt(channel.accountId)
      channel.recheck?.()
      loadJobs()
    } catch (err) {
      setError(err.message || 'Could not clear the halt')
    }
  }

  if (!isAdmin) return <Navigate to="/inbox" replace />

  const finished = job && TERMINAL.has(job.status)

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <Link to="/inbox" className="btn btn-secondary btn-sm page-back">
          <ArrowLeft size={14} />
          Back to inbox
        </Link>

        {channel.autoHalted ? (
          <div className="alert alert-error sync-halt">
            <AlertTriangle size={15} />
            <span>
              Automatic recovery is paused after an account-level error:{' '}
              <strong>{channel.autoHalted}</strong>. Resolve it with Whapi, then clear this.
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearHalt}>
              Clear
            </button>
          </div>
        ) : null}

        {error ? <div className="alert alert-error">{error}</div> : null}

        {channel.autoRecovering ? (
          <div className="sync-auto-note" role="status">
            <span className="spinner" />
            Auto-recovering messages missed during a disconnection…
          </div>
        ) : null}

        <section className="card">
          <div className="card-head">
            <RefreshCw size={17} style={{ color: 'var(--text-2)' }} />
            <h2 className="card-title">Message recovery</h2>
          </div>
          <div className="card-body">
            <p className="sync-lede">
              Messages missed during a WhatsApp disconnection are recovered automatically when
              the channel reconnects — nothing to start. Recovered messages are marked read,
              never notify, and never reorder your conversations. A recovery in progress and
              recent results appear below; an unusually long outage is recorded but not run
              automatically, so use its Run button to recover it deliberately.
            </p>
            <form className="sync-manual-form" onSubmit={startRangeSync}>
              {/* Which account's history to walk. Only shown when there is a
                  choice; with one account the job is stamped with it anyway. */}
              {hasMultiple ? (
                <label>
                  Account
                  <select
                    className="select"
                    value={syncAccountId ?? (accounts.length ? accounts[0].id : '')}
                    onChange={(event) => setSyncAccountId(Number(event.target.value))}
                    disabled={driving}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                From
                <input
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  disabled={driving}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                  disabled={driving}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={driving}>
                {driving ? <span className="spinner" /> : <Play size={14} />}
                {driving ? 'Syncing…' : 'Run manual sync'}
              </button>
            </form>
          </div>
        </section>

        {job ? (
          <section className="card">
            <div className="card-head">
              {finished ? (
                job.status === 'done' ? (
                  <CheckCircle2 size={17} style={{ color: 'var(--success)' }} />
                ) : (
                  <AlertTriangle size={17} style={{ color: 'var(--danger)' }} />
                )
              ) : (
                <span className="spinner" style={{ color: 'var(--text-3)' }} />
              )}
              <h2 className="card-title">
                {finished
                  ? job.status === 'done'
                    ? 'Recovery complete'
                    : `Recovery ${job.status}`
                  : 'Recovering…'}
              </h2>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                {hasMultiple && nameFor(job.account_id) ? `${nameFor(job.account_id)} — ` : ''}
                {scopeLabel(job)}
              </span>
            </div>

            <div className="card-body">
              <div className="sync-stats">
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.conversations_done ?? 0}</span>
                  <span className="sync-stat-label">Conversations processed</span>
                </div>
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.messages_added ?? 0}</span>
                  <span className="sync-stat-label">Messages added</span>
                </div>
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.media_failed ?? 0}</span>
                  <span className="sync-stat-label">Attachments unavailable</span>
                </div>
              </div>

              {Array.isArray(job.errors) && job.errors.length ? (
                <div className="sync-errors">
                  <div className="sync-errors-title">
                    {job.errors.length} chat{job.errors.length === 1 ? '' : 's'} could not be read
                  </div>
                  <ul className="sync-errors-list">
                    {job.errors.slice(0, 8).map((e, i) => (
                      <li key={i}>
                        <code>{e.chat || '—'}</code> · {e.error}
                      </li>
                    ))}
                    {job.errors.length > 8 ? <li>…and {job.errors.length - 8} more</li> : null}
                  </ul>
                </div>
              ) : null}

              {job.last_error && job.status === 'failed' ? (
                <div className="alert alert-error">{job.last_error}</div>
              ) : null}

              {finished && job.status === 'done' ? (
                <p className="sync-done-note">
                  {job.messages_added
                    ? 'New messages are in the inbox. Attachments marked unavailable had expired on Whapi and cannot be recovered.'
                    : 'Everything was already up to date — nothing needed adding.'}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {jobs.length ? (
          <section className="card">
            <div className="card-head">
              <RefreshCw size={16} style={{ color: 'var(--text-2)' }} />
              <h2 className="card-title">Recent syncs</h2>
            </div>
            <div className="sync-history">
              {jobs.map((j) => {
                const auto = isAuto(j)
                const deferred = j.status === 'deferred'
                return (
                  <div className="sync-history-row" key={j.id}>
                    <span className={`sync-tag${auto ? ' is-auto' : ''}`}>
                      {auto ? <Zap size={11} /> : null}
                      {auto ? 'Auto' : 'Manual'}
                    </span>
                    <span className="sync-history-scope">
                      {/* Which account this job ran against — without it, two
                          accounts' recoveries are indistinguishable in the list. */}
                      {hasMultiple && nameFor(j.account_id) ? (
                        <span className="conv-account" style={{ marginRight: 6 }}>
                          {nameFor(j.account_id)}
                        </span>
                      ) : null}
                      {scopeLabel(j)}
                    </span>
                    <span className={`sync-history-status is-${j.status}`}>
                      {deferred ? 'Needs manual run' : j.status}
                    </span>
                    <span className="sync-history-counts">
                      {TERMINAL.has(j.status) || j.status === 'running'
                        ? `+${j.messages_added ?? 0} msgs`
                        : ''}
                    </span>
                    {deferred ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => runDeferred(j)}
                        disabled={driving}
                      >
                        <Play size={12} />
                        Run
                      </button>
                    ) : (
                      <span className="sync-history-spacer" />
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
