import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { useAuth } from './AuthContext.jsx'

const AccountContext = createContext(null)

// The selected account is a UI preference, so it belongs in localStorage rather
// than in a URL or on the server: it should survive a reload on THIS device
// without following the user to another one, where a different account may well
// be the one they want.
const STORAGE_KEY = 'wpchat.account'

/** "All accounts" is a real selection, not the absence of one. */
export const ALL_ACCOUNTS = 'all'

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ALL_ACCOUNTS
  } catch {
    // Private mode / blocked storage — fall back to the merged view.
    return ALL_ACCOUNTS
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // Non-fatal: the selection simply will not survive a reload.
  }
}

/**
 * Which accounts the user can reach, and which one the inbox is showing.
 *
 * DEFAULTS TO "ALL ACCOUNTS", deliberately. A user with exactly one account —
 * which is every user of the existing single-account deployment — then sees
 * precisely the inbox they saw before, with no switcher to notice and nothing
 * to pick. Multi-account is additive, not a new step in the way.
 *
 * The list is refreshed from /api/conversations (which returns it alongside the
 * rows) rather than polled separately, so the 5s inbox poll keeps it current for
 * free. The fetch here is only for the cold start, before the first poll lands.
 */
export function AccountProvider({ children }) {
  const { isAuthenticated } = useAuth()

  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(readStored)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (signal) => {
    try {
      const data = await api.accounts({ signal })
      setAccounts(data.accounts || [])
      return data.accounts || []
    } catch {
      // The inbox poll will supply the list shortly; failing here must not
      // block the app from rendering.
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated) {
      setAccounts([])
      setLoading(false)
      return undefined
    }
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [isAuthenticated, load])

  /**
   * Keep the list fresh from the inbox poll's payload. Called by InboxContext
   * on every refresh, so a newly created account (or one the admin just
   * assigned) appears within one poll without its own request.
   */
  const syncAccounts = useCallback((next) => {
    if (!Array.isArray(next)) return
    setAccounts((prev) => {
      // Reference-stable when nothing changed, so this cannot drive a re-render
      // of the whole inbox every 5 seconds.
      if (prev.length === next.length && prev.every((a, i) => a.id === next[i].id && a.name === next[i].name)) {
        return prev
      }
      return next
    })
    setLoading(false)
  }, [])

  const select = useCallback((value) => {
    const next = value == null ? ALL_ACCOUNTS : String(value)
    setSelected(next)
    writeStored(next)
  }, [])

  // A stored selection for an account the user can no longer reach (unassigned,
  // or deactivated) would show a permanently empty inbox, so it falls back to
  // the merged view. Only once the list has actually loaded — an empty list
  // during the cold start must not clear a valid selection.
  useEffect(() => {
    if (loading || !accounts.length) return
    if (selected === ALL_ACCOUNTS) return
    if (!accounts.some((a) => String(a.id) === String(selected))) select(ALL_ACCOUNTS)
  }, [accounts, selected, loading, select])

  const value = useMemo(() => {
    const isAll = selected === ALL_ACCOUNTS
    const current = isAll ? null : accounts.find((a) => String(a.id) === String(selected)) || null

    return {
      accounts,
      loading,
      // 'all' or a stringified id.
      selected,
      // The resolved row, or null in the merged view.
      account: current,
      isAll,
      // What to send as account_id: null in the merged view, so the server
      // returns everything the caller can reach.
      accountId: isAll ? null : current?.id ?? null,
      // With one account there is nothing to switch between, so the UI hides
      // the switcher entirely and single-account users see no new chrome.
      hasMultiple: accounts.length > 1,
      select,
      syncAccounts,
      reload: load,
      /** Display name for a conversation's account_id. */
      nameFor: (accountId) =>
        accounts.find((a) => String(a.id) === String(accountId))?.name ?? null,
    }
  }, [accounts, selected, loading, select, syncAccounts, load])

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccounts() {
  const ctx = useContext(AccountContext)
  // Optional, matching useChannel(): a component rendered outside the provider
  // behaves as a single-account app rather than crashing.
  return (
    ctx || {
      accounts: [],
      loading: false,
      selected: ALL_ACCOUNTS,
      account: null,
      isAll: true,
      accountId: null,
      hasMultiple: false,
      select: () => {},
      syncAccounts: () => {},
      reload: () => {},
      nameFor: () => null,
    }
  )
}
