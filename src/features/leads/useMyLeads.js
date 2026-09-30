// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchMyLeads, logLeadOutcome } from './leadsApi.js'

/** The inbox polls chats every 5s; leads change far less often. */
const POLL_MS = 60000

/**
 * Read state is per-browser and never touches the database — the feature was
 * specified to add no migration, and `leads` has no column to record "this
 * agent has seen it". localStorage is the honest place for a view-state fact.
 * (The key predates read/unread: ids dismissed under the old behaviour simply
 * count as read now.)
 */
const READ_KEY = 'wp_leads_seen_v1'

function readReadSet() {
  try {
    const raw = localStorage.getItem(READ_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set()
  } catch {
    // Private mode, blocked storage, or corrupt JSON. Everything reads as
    // unread — a lead flagged twice beats a lead never flagged.
    return new Set()
  }
}

function writeReadSet(set) {
  try {
    // Bounded so a long-lived browser cannot grow this without limit.
    localStorage.setItem(READ_KEY, JSON.stringify([...set].slice(-200)))
  } catch {
    /* storage unavailable — read state simply does not persist */
  }
}

/**
 * A lead is unread while it is still 'new' and nobody marked it read here.
 * Once its status moves on it has been worked, so it no longer asks for
 * attention — but it stays in the list.
 */
export const isUnread = (lead, readSet) =>
  lead.status === 'new' && !readSet.has(String(lead.id))

/**
 * The caller's recent leads, polled, with a per-browser read/unread flag.
 * Nothing is ever removed from the list client-side; marking read only clears
 * the badge.
 *
 * Errors are swallowed into `leads: []`. This is a secondary surface: a failing
 * leads query must never put an error banner over a working inbox.
 */
export function useMyLeads() {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [readSet, setReadSet] = useState(readReadSet)
  // Held in a ref so the polling effect never re-subscribes on a state change
  // — re-running it would fire an extra request each time.
  const activeRef = useRef(true)

  const load = useCallback(async (signal) => {
    try {
      const rows = await fetchMyLeads({ signal })
      if (activeRef.current) setLeads(rows)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (activeRef.current) setLeads([])
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    const controller = new AbortController()
    load(controller.signal)

    const timer = setInterval(() => {
      // Polling a hidden tab wakes the worker for a view nobody is looking at.
      if (document.visibilityState === 'visible') load(controller.signal)
    }, POLL_MS)

    // A tab returning to the foreground may have missed several ticks.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load(controller.signal)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      activeRef.current = false
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  /**
   * Logs a contact outcome. The row updates only once the server confirms, so
   * the panel never shows a status the database did not take; failures are
   * thrown for the row to display.
   */
  const logOutcome = useCallback(async (id, outcome) => {
    const updated = await logLeadOutcome(id, outcome)
    if (activeRef.current) {
      setLeads((prev) =>
        prev.map((lead) =>
          lead.id === id && updated?.status ? { ...lead, status: updated.status } : lead
        )
      )
    }
  }, [])

  const markRead = useCallback((ids) => {
    setReadSet((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(String(id)))
      writeReadSet(next)
      return next
    })
  }, [])

  const unreadCount = useMemo(
    () => leads.filter((lead) => isUnread(lead, readSet)).length,
    [leads, readSet]
  )

  return {
    leads,
    readSet,
    unreadCount,
    loading,
    markRead: (id) => markRead([id]),
    markAllRead: () => markRead(leads.map((lead) => lead.id)),
    logOutcome,
  }
}
