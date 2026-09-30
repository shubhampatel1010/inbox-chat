import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useAuth } from './AuthContext.jsx'
import { useAccounts } from './AccountContext.jsx'

const ChannelContext = createContext(null)

// Deliberately slow — this is infrastructure state, not message data. It must
// never join the 4s/5s message polling cycle.
const CHANNEL_POLL_MS = 60000

// Between auto-recovery steps when the server says to back off (a manual sync
// is running, or another tab holds the lease). Slower than the manual driver —
// auto-recovery is never in a hurry.
const AUTO_STEP_BACKOFF_MS = 3000

const TERMINAL = new Set(['done', 'failed', 'canceled'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ChannelProvider({ children }) {
  const { isAdmin } = useAuth()
  // Channel health belongs to ONE account, so the poll follows the selection.
  // In the "All accounts" view there is no single channel to report, so
  // `accountId` is null and the server answers for the user's first account —
  // which is the existing behaviour for anyone with one account.
  const { accountId, accounts } = useAccounts()

  const [state, setState] = useState({
    connected: true, // optimistic: never flash a disconnect banner on cold start
    status: null,
    uptime: null,
    checkedAt: null,
    known: false,
    // Whether the selected account has Whapi credentials at all. A freshly
    // created account is not "disconnected" — it is not set up yet, and the
    // banner must say so rather than urging a reconnect that cannot work.
    configured: true,
  })
  // Surfaced so the UI can show an auto-recovery in progress / a halt.
  const [autoRecovering, setAutoRecovering] = useState(false)
  const [autoHalted, setAutoHalted] = useState(null)

  const checkRef = useRef(null)
  const isAdminRef = useRef(isAdmin)
  isAdminRef.current = isAdmin
  const accountIdRef = useRef(accountId)
  accountIdRef.current = accountId
  // Single-flight: one auto-recovery drive per tab at a time.
  const drivingAutoRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    /**
     * Drive an auto-recovery job to completion — the same bounded-step loop the
     * manual Sync page uses. Admin-only (the step endpoint is admin-gated), and
     * wrapped so a FAILING auto-sync can never affect the app or the poll.
     */
    const driveAuto = async (jobId) => {
      if (drivingAutoRef.current) return
      drivingAutoRef.current = true
      setAutoRecovering(true)
      try {
        while (!cancelled) {
          const res = await api.syncStep(jobId)
          if (res.accountError) { setAutoHalted(res.job?.last_error || 'Account error'); break }
          if (res.done || TERMINAL.has(res.job?.status)) break
          if (res.busy || res.backoff || res.deferred) await sleep(AUTO_STEP_BACKOFF_MS)
        }
      } catch {
        // Auto-recovery is best-effort: swallow everything.
      } finally {
        drivingAutoRef.current = false
        if (!cancelled) setAutoRecovering(false)
      }
    }

    const check = async () => {
      try {
        const data = await api.channelStatus(accountIdRef.current, controller.signal)
        if (cancelled) return
        setState({
          connected: data.connected !== false,
          status: data.status ?? null,
          uptime: data.uptime ?? null,
          checkedAt: data.checked_at ?? null,
          known: true,
          configured: data.configured !== false,
        })
        setAutoHalted(data.auto_halted ?? null)

        // Only an admin can drive the recovery (the step endpoint is admin-only).
        // A non-admin tab still triggers the SERVER to record the gap via this
        // same poll; the job then waits for an admin tab to drive it.
        if (isAdminRef.current && data.auto_recovery?.job_id) {
          driveAuto(data.auto_recovery.job_id)
        }
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        // Our own API being unreachable says nothing about the Whapi channel,
        // so leave the last known state rather than crying disconnected.
      }
    }

    checkRef.current = check
    check()
    const interval = setInterval(check, CHANNEL_POLL_MS)
    return () => {
      cancelled = true
      checkRef.current = null
      clearInterval(interval)
      controller.abort()
    }
    // Re-polls on an account switch so the banner never shows the previous
    // account's health against the new account's name.
  }, [accountId])

  const value = useMemo(
    () => ({
      ...state,
      // An unconfigured account is not a disconnection — nothing has been
      // connected yet — so it must not raise the reconnect banner.
      disconnected: state.known && !state.connected && state.configured,
      unconfigured: state.known && !state.configured,
      autoRecovering,
      autoHalted,
      // Which account this health actually describes, so the UI can name it.
      accountId,
      accountName: accounts.find((a) => String(a.id) === String(accountId))?.name ?? null,
      recheck: () => checkRef.current?.(),
    }),
    [state, autoRecovering, autoHalted, accountId, accounts]
  )

  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>
}

export function useChannel() {
  const ctx = useContext(ChannelContext)
  // Optional: components outside the provider simply see a healthy channel.
  return (
    ctx || {
      connected: true, disconnected: false, known: false, uptime: null, status: null,
      configured: true, unconfigured: false,
      autoRecovering: false, autoHalted: null,
      accountId: null, accountName: null, recheck: () => {},
    }
  )
}

/** 93899 -> "1d 2h" */
export function formatUptime(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}
