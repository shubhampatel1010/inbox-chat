import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api } from '../lib/api.js'
import { displayName } from '../lib/format.js'
import { playChime } from '../lib/chime.js'
import { useToast } from './ToastContext.jsx'
import { useTheme } from './ThemeContext.jsx'
import { setAppBadge, ensurePushSubscription } from '../lib/push.js'
import { useAccounts } from './AccountContext.jsx'

const CONVERSATION_POLL_MS = 5000

const InboxContext = createContext(null)

const BASE_TITLE = 'Team Inbox'

export function InboxProvider({ children }) {
  const toast = useToast()
  const { soundOn } = useTheme()
  // `accountId` is null in the "All accounts" view, which fetches everything the
  // user can reach — the single-account case, and therefore the default.
  const { accountId, syncAccounts } = useAccounts()

  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  // Which pane is showing on phones. Lives here rather than in the Inbox page
  // so the Shell can hide its chrome while a thread is open.
  const [mobileView, setMobileView] = useState('list')

  // Snapshot of the previous poll, keyed by id, used to diff for new inbound
  // messages. Kept in a ref so the polling effect doesn't re-subscribe on it.
  const snapshot = useRef(null)
  const openIdRef = useRef(null)
  const soundRef = useRef(soundOn)
  const onOpenRef = useRef(null)

  useEffect(() => {
    openIdRef.current = openId
  }, [openId])
  useEffect(() => {
    soundRef.current = soundOn
  }, [soundOn])

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0),
    [conversations]
  )

  // (N) prefix on the browser tab.
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${BASE_TITLE}` : BASE_TITLE
  }, [totalUnread])

  // Home-screen badge tracks the same count. The in-app count stays the source
  // of truth — push delivery is best-effort and may never arrive.
  useEffect(() => {
    setAppBadge(totalUnread)
  }, [totalUnread])

  // iOS can silently discard a push subscription while leaving permission
  // granted, so re-assert it on every start rather than trusting permission.
  useEffect(() => {
    ensurePushSubscription().catch(() => {})
  }, [])

  // Notification tap: the service worker focuses this window and posts the
  // conversation to open.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const onMessage = (event) => {
      if (event.data?.type !== 'OPEN_CONVERSATION') return
      const id = event.data.conversationId
      if (id != null) onOpenRef.current?.(id)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  /** Diff this poll against the last one and toast + chime on new inbound. */
  const announce = useCallback(
    (rows) => {
      const previous = snapshot.current

      // First successful poll only seeds the snapshot — don't toast history.
      if (previous) {
        let anyNew = false

        for (const row of rows) {
          if (row.last_direction !== 'inbound') continue
          if (String(row.id) === String(openIdRef.current)) continue

          const before = previous.get(String(row.id))
          const stampNow = row.last_message_at ? new Date(row.last_message_at).getTime() : 0
          const stampBefore = before?.last_message_at
            ? new Date(before.last_message_at).getTime()
            : 0

          // New conversation, or an existing one whose last message got newer.
          const isNew = !before ? stampNow > 0 : stampNow > stampBefore
          if (!isNew) continue

          anyNew = true
          toast.notify(displayName(row), row.last_message_body || 'New message', () =>
            onOpenRef.current?.(row.id)
          )
        }

        if (anyNew && soundRef.current) playChime()
      }

      snapshot.current = new Map(rows.map((r) => [String(r.id), r]))
    },
    [toast]
  )

  const refresh = useCallback(
    async (signal) => {
      try {
        const data = await api.conversations(accountId, signal)
        const rows = data.conversations || []
        announce(rows)
        setConversations(rows)
        // The list comes back with the rows, so the switcher stays current
        // without a second request on every poll.
        syncAccounts(data.accounts)
        setError(null)
      } catch (err) {
        if (err.name === 'AbortError' || err.status === 401) return
        setError(err.message)
      } finally {
        setLoading(false)
      }
    },
    [announce, accountId, syncAccounts]
  )

  // Poll every ~5s. Re-runs when the account changes, because `refresh` depends
  // on accountId — switching therefore aborts the in-flight request and fetches
  // the new account immediately rather than waiting out the interval.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    // Drop the previous account's rows so its chats cannot linger on screen
    // while the new ones load — showing one account's chats under another's
    // name, even for a moment, is exactly the confusion to avoid.
    setConversations([])
    setLoading(true)
    // The diff baseline belongs to the old account; keeping it would announce
    // every chat in the newly selected one as "new" and fire a toast storm.
    snapshot.current = null

    refresh(controller.signal)
    const interval = setInterval(() => {
      if (!cancelled) refresh(controller.signal)
    }, CONVERSATION_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      controller.abort()
    }
  }, [refresh])

  /** Clear a conversation's unread count locally the moment it's opened. */
  const clearUnread = useCallback((conversationId) => {
    setConversations((current) =>
      current.map((c) =>
        String(c.id) === String(conversationId) ? { ...c, unread_count: 0 } : c
      )
    )
    const entry = snapshot.current?.get(String(conversationId))
    if (entry) entry.unread_count = 0
  }, [])

  /** Optimistically bump the preview after we send, so the row jumps to the top. */
  const applyOutbound = useCallback((conversationId, body) => {
    const stamp = new Date().toISOString()
    setConversations((current) =>
      current.map((c) =>
        String(c.id) === String(conversationId)
          ? {
              ...c,
              last_message_body: body,
              last_message_at: stamp,
              last_direction: 'outbound',
              unread_count: 0,
            }
          : c
      )
    )
    const entry = snapshot.current?.get(String(conversationId))
    if (entry) {
      entry.last_message_body = body
      entry.last_message_at = stamp
      entry.last_direction = 'outbound'
    }
  }, [])

  const patchConversation = useCallback((conversationId, patch) => {
    setConversations((current) =>
      current.map((c) => (String(c.id) === String(conversationId) ? { ...c, ...patch } : c))
    )
  }, [])

  const registerOpenHandler = useCallback((fn) => {
    onOpenRef.current = fn
  }, [])

  // Open a conversation in the mounted Inbox page. Returns false when the Inbox
  // is not on screen, so the caller can route to /inbox?chat= instead.
  const openConversation = useCallback((id) => {
    if (!onOpenRef.current) return false
    onOpenRef.current(id)
    return true
  }, [])

  const value = useMemo(
    () => ({
      conversations,
      loading,
      error,
      totalUnread,
      openId,
      setOpenId,
      mobileView,
      setMobileView,
      clearUnread,
      applyOutbound,
      patchConversation,
      registerOpenHandler,
      openConversation,
      refresh: () => refresh(),
    }),
    [
      conversations,
      loading,
      error,
      totalUnread,
      openId,
      mobileView,
      clearUnread,
      applyOutbound,
      patchConversation,
      registerOpenHandler,
      openConversation,
      refresh,
    ]
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox() {
  const ctx = useContext(InboxContext)
  if (!ctx) throw new Error('useInbox must be used inside InboxProvider')
  return ctx
}
