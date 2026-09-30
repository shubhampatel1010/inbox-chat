import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, MessagesSquare, Plus, Search, Users, Building2, ShieldCheck, Sparkles } from 'lucide-react'
import { api } from '../lib/api.js'
import { displayName, formatNumber, mediaLabel } from '../lib/format.js'
import { useInbox } from '../context/InboxContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useAccounts } from '../context/AccountContext.jsx'
import ConversationList from '../components/ConversationList.jsx'
import Thread from '../components/Thread.jsx'
import ReplyBox from '../components/ReplyBox.jsx'
import DropZone from '../components/DropZone.jsx'
import AssignControl from '../components/AssignControl.jsx'
import NewMessageModal from '../components/NewMessageModal.jsx'
import ContactAvatar from '../components/ContactAvatar.jsx'
import ContactPanel from '../components/ContactPanel.jsx'
import ThreadSearch from '../components/ThreadSearch.jsx'
import CallControl from '../components/CallControl.jsx'
import VideoCallControl from '../components/VideoCallControl.jsx'
import MessageContextMenu from '../components/MessageContextMenu.jsx'
import SelectionBar from '../components/SelectionBar.jsx'
import ConversationPicker from '../components/ConversationPicker.jsx'
import DismissReasonModal from '../components/DismissReasonModal.jsx'
import AttentionHistoryModal from '../components/AttentionHistoryModal.jsx'
import SummaryPopover from '../components/SummaryPopover.jsx'
import { useSwipeBack } from '../lib/useSwipeBack.js'
import { mergeMessages } from '../lib/thread.js'

const THREAD_POLL_MS = 4000

/** Query parameter carrying the open conversation, so a refresh restores it. */
const CHAT_PARAM = 'chat'

/**
 * How many conversations to warm the summary cache for. The list is
 * newest-first, but users scroll well past the first screenful, and a row that
 * was never preloaded pays a full model generation on tap — so this covers far
 * more than one screen.
 */
const PRELOAD_LIMIT = 150

/**
 * The batch endpoint caps each request at 30 ids (MAX_IDS), so a preload wider
 * than that is split into chunks and issued in parallel. These are read-only
 * indexed lookups — no model calls — so several at once is cheap.
 */
const PRELOAD_CHUNK = 30

const EMPTY_THREAD = {
  conversationId: null,
  messages: [],
  hasMoreBefore: false,
  hasMoreAfter: false,
}

export default function Inbox() {
  const toast = useToast()
  // Gates the thread-header audit icon. Presentation only — the events endpoint
  // answers 403 to an agent regardless.
  const { isAdmin } = useAuth()
  // Used to badge the open thread with its account when there is more than one.
  const { hasMultiple: hasMultipleAccounts, accountId: selectedAccountId } = useAccounts()
  // The app runs inside a BrowserRouter, so the URL is written through the
  // router rather than history.replaceState directly — a raw call would leave
  // the router's own location state pointing at the previous URL, and the next
  // navigation would render from that stale value.
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    conversations,
    loading,
    error,
    openId,
    setOpenId,
    clearUnread,
    applyOutbound,
    patchConversation,
    registerOpenHandler,
    mobileView,
    setMobileView,
    refresh,
  } = useInbox()

  // Messages are stored WITH the conversation they belong to. Clearing them in
  // an effect is not enough: effects run after paint, so a switch from A to B
  // would still render one frame of A's messages under B's header.
  const [thread, setThread] = useState(EMPTY_THREAD)
  const [threadLoading, setThreadLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(null)
  // The message the loaded WINDOW is built around. Null for a normal open,
  // which is what keeps the default path byte-for-byte the behaviour it was.
  const [anchor, setAnchor] = useState(null)
  // The message to scroll to and flash. Separate from `anchor` because
  // stepping between in-thread matches usually needs no reload at all — only
  // a jump outside the loaded window has to move the window with it.
  const [jumpTo, setJumpTo] = useState(null)
  const jumpNonceRef = useRef(0)

  // In-thread search state.
  const [threadSearchOpen, setThreadSearchOpen] = useState(false)
  const [threadSearchQuery, setThreadSearchQuery] = useState('')
  const [users, setUsers] = useState([])

  // The account of the currently open conversation, used to scope the assign
  // roster below. Derived from the already-loaded list rather than fetched, and
  // falls back to the selected account when no thread is open (so the roster is
  // still sensible for the account the user is looking at).
  const openConversationAccountId =
    conversations.find((c) => String(c.id) === String(openId))?.account_id ?? selectedAccountId ?? null
  const [composing, setComposing] = useState(false)
  // The contact/group info panel — opened by tapping the thread-header name.
  const [showInfo, setShowInfo] = useState(false)
  // The admin-only attention-history panel for the open conversation.
  const [historyOpen, setHistoryOpen] = useState(false)
  // The AI summary popover opened from the thread header — the same panel as
  // the list rows' ✦ Summary button. Holds the anchor rect it opens beside.
  const [summaryRect, setSummaryRect] = useState(null)

  // Short-summary cache shared with ConversationList's popovers. Owned here so
  // the background preload below can fill it before any row is tapped; the
  // popover's own lazy fetch stays as the fallback for a miss.
  //
  // Keyed by the RAW conversation id (a number), because that is what
  // SummaryPopover looks up — a string key would never be found.
  const summaryCache = useRef(new Map())

  // --- forwarding ---
  // The open context menu: {x, y, message}, or null.
  const [menu, setMenu] = useState(null)
  // Non-null puts the thread in selection mode. A Set of message ids, so
  // toggling is O(1) and the empty set is a valid "mode on, nothing picked".
  const [selection, setSelection] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [forwarding, setForwarding] = useState(false)
  // True when the picker was opened by the per-file shortcut rather than from
  // selection mode. Closing it must then leave the thread as it was found,
  // instead of stranding the user in a selection mode they never chose.
  const [quickForward, setQuickForward] = useState(false)

  // --- replying ---
  // The message being quoted, or null. The whole row is held rather than just
  // its id so the composer preview renders without a lookup, and so it survives
  // the loaded window scrolling away from the original.
  const [replyTo, setReplyTo] = useState(null)

  // --- drag & drop ---
  // ReplyBox publishes its file-queueing function here, so a drop on the thread
  // runs the same validation and upload path as the paperclip button.
  const attachFilesRef = useRef(null)

  const exitSelection = useCallback(() => {
    setSelection(null)
    setPickerOpen(false)
    setQuickForward(false)
  }, [])

  const toggleSelected = useCallback((messageId) => {
    setSelection((current) => {
      const next = new Set(current ?? [])
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  const openIdRef = useRef(null)
  openIdRef.current = openId

  // Monotonic request counter: a slow poll must never overwrite the result of
  // a newer one, even within the same conversation.
  const seqRef = useRef(0)
  const threadPaneRef = useRef(null)

  // Read by the poll and by the paging callbacks without making either of them
  // depend on thread state — the polling effect must not re-subscribe every
  // time a page loads.
  const threadRef = useRef(thread)
  threadRef.current = thread
  const loadingMoreRef = useRef(null)
  loadingMoreRef.current = loadingMore
  const threadSearchOpenRef = useRef(false)
  threadSearchOpenRef.current = threadSearchOpen

  /**
   * Render-time guard. If the stored messages belong to a different
   * conversation than the one selected, they simply do not exist as far as
   * this render is concerned — no stale frame is possible.
   */
  // The paging flags are guarded by the same test: a stale `hasMoreBefore`
  // would otherwise render "scroll up for earlier messages" over the loading
  // skeleton of a thread that has not arrived yet.
  const threadIsCurrent = String(thread.conversationId) === String(openId)
  const messages = threadIsCurrent ? thread.messages : []

  /** Scroll to and flash a message; nonce makes a repeat request a fresh one. */
  const requestJump = useCallback((messageId) => {
    setJumpTo({ id: messageId, nonce: ++jumpNonceRef.current })
  }, [])

  const open = useCallback(
    (conversationId, anchorMessageId = null) => {
      setOpenId(conversationId)
      setAnchor(anchorMessageId ?? null)
      setJumpTo(anchorMessageId ? { id: anchorMessageId, nonce: ++jumpNonceRef.current } : null)
      // Opening a different conversation from a global search result must not
      // leave the previous thread's in-thread search bar or info panel up.
      setThreadSearchOpen(false)
      setThreadSearchQuery('')
      setShowInfo(false)
      // Same reasoning: the audit panel is scoped to one conversation, so it
      // must not survive into the next one.
      setHistoryOpen(false)
      setSummaryRect(null)
      // Selection holds message ids from the thread being left. Carrying them
      // into a different one would show a stale count and forward messages the
      // user can no longer see, so every mode-piece resets with the thread.
      setSelection(null)
      setPickerOpen(false)
      setMenu(null)
      // Same reasoning for a pending reply: it quotes a message in the thread
      // being left, and /api/send would reject it against the new conversation.
      setReplyTo(null)
      // Optimistic — the GET /messages side effect clears it server-side.
      clearUnread(conversationId)
      setMobileView('thread')
      // replace, not push: switching conversations must not stack a history
      // entry per switch, or the back button would walk the whole session.
      setSearchParams({ [CHAT_PARAM]: String(conversationId) }, { replace: true })
    },
    [setOpenId, clearUnread, setMobileView, setSearchParams]
  )

  /**
   * Step to an in-thread match.
   *
   * Most steps land inside the loaded window, where a jump alone is enough and
   * a reload would be both wasteful and visibly jarring. Only a match outside
   * it moves the window, via the anchored load already built for global search.
   */
  const goToMessage = useCallback(
    (messageId) => {
      const loaded = threadRef.current.messages.some(
        (m) => String(m.id) === String(messageId)
      )
      if (!loaded) setAnchor(messageId)
      requestJump(messageId)
    },
    [requestJump]
  )

  const closeThreadSearch = useCallback(() => {
    setThreadSearchOpen(false)
    setThreadSearchQuery('')
  }, [])

  // Lets a toast click (or an Ask AI result) jump straight into the
  // conversation. Unregistered on unmount so callers on other pages know to
  // route to /inbox instead of calling a handler that is no longer on screen.
  useEffect(() => {
    registerOpenHandler(open)
    return () => registerOpenHandler(null)
  }, [registerOpenHandler, open])

  // Background summary preload.
  //
  // Two jobs: fill the popover cache so the first sparkle tap is instant, and
  // warm the Worker so that tap is not also paying cold-start. Fire-and-forget
  // — nothing here sets a loading state or blocks a render, and a failure just
  // leaves the cache empty for the popover's own fetch to handle.
  //
  // Invalidation is driven by last_message_at rather than by re-fetching on
  // every 5s poll: a conversation whose newest message has not changed cannot
  // have a newer summary, so only genuinely-updated rows are re-requested.
  const preloadedRef = useRef(new Map())
  useEffect(() => {
    if (loading || !conversations.length) return undefined

    // Newest-first order already, so this is the set most likely to be tapped.
    const candidates = conversations.slice(0, PRELOAD_LIMIT)

    // Ask only for rows we have never fetched, or whose last message moved
    // since we did. Everything else is already cached and current.
    const wanted = candidates.filter((c) => {
      const seenAt = preloadedRef.current.get(c.id)
      return seenAt === undefined || seenAt !== c.last_message_at
    })

    if (!wanted.length) return undefined

    const controller = new AbortController()

    // Split into MAX_IDS-sized requests; anything larger is rejected by the
    // endpoint as a bad request rather than truncated.
    const chunks = []
    for (let i = 0; i < wanted.length; i += PRELOAD_CHUNK) {
      chunks.push(wanted.slice(i, i + PRELOAD_CHUNK))
    }

    for (const chunk of chunks) {
      api
        .summariesBatch(
          chunk.map((c) => c.id),
          controller.signal
        )
        .then((res) => {
          if (controller.signal.aborted) return
          const summaries = res?.summaries || {}

          for (const conversation of chunk) {
            // The response keys are strings (JSON object keys always are); the
            // cache is keyed by the raw id, which is what the popover reads.
            const summary = summaries[String(conversation.id)] ?? null

            // A HIT is authoritative — the popover renders it with no request
            // at all. A MISS only means "nothing generated yet"; it must NOT be
            // cached as a final answer, or the popover would short-circuit on
            // it and show a permanent "No summary yet" without ever asking the
            // server to generate one. Leaving the key absent sends that row
            // down the popover's own fetch path, which triggers generation.
            if (summary) {
              summaryCache.current.set(conversation.id, { summary, stale: false })
            } else {
              summaryCache.current.delete(conversation.id)
            }
            preloadedRef.current.set(conversation.id, conversation.last_message_at)
          }
        })
        .catch(() => {
          // Silent by design: this is an optimisation, and the popover's own
          // fetch is the fallback. Nothing is shown to the user.
        })
    }

    return () => controller.abort()
  }, [conversations, loading])

  // Restore the conversation named in ?chat= on a cold load — a refresh, or a
  // pasted link.
  //
  // Deliberately NOT gated on the list having loaded: openId is set straight
  // away so the thread starts fetching in parallel with the conversation list,
  // rather than a round trip behind it. An id that turns out not to exist is
  // cleaned up by the access-loss effect once `loading` goes false, which is
  // the same path that already handles losing access to an open thread.
  //
  // Runs once. A later ?chat= change is always something this component just
  // wrote itself, so re-running would be a no-op at best and could fight a
  // user's own navigation at worst.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    const raw = searchParams.get(CHAT_PARAM)
    if (!raw) return

    // Only a positive integer is a possible id. Anything else is discarded
    // silently, per the spec — a junk URL shows the list, never an error.
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) {
      setSearchParams({}, { replace: true })
      return
    }

    setOpenId(id)
    setMobileView('thread')
    clearUnread(id)
  }, [searchParams, setSearchParams, setOpenId, setMobileView, clearUnread])

  // The assign dropdown needs the roster; agents get it for the read-only label.
  //
  // Scoped to the OPEN conversation's account, so the picker only offers agents
  // who can actually open it — assigning one who cannot would leave the chat
  // looking handled while its owner gets a 404. `openConversationAccountId` is
  // derived below from the conversation list, which is already loaded, so this
  // costs no extra request; it re-runs only when the open thread moves to a
  // different account.
  useEffect(() => {
    const controller = new AbortController()
    api
      .users(openConversationAccountId, controller.signal)
      .then((data) => setUsers(data.users || []))
      .catch(() => {
        /* assign control degrades to an empty list */
      })
    return () => controller.abort()
  }, [openConversationAccountId])

  // Load and then poll the open thread every ~4s.
  //
  // Re-runs when the anchor changes as well as the conversation, because
  // jumping to a different message is a different window of the same thread.
  useEffect(() => {
    if (!openId) {
      setThread(EMPTY_THREAD)
      setThreadLoading(false)
      setLoadingMore(null)
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false
    setThreadLoading(true)
    setLoadingMore(null)

    /** Guards shared by every request in this effect, cheapest first. */
    const stale = (seq) =>
      cancelled ||
      // ...the user left this thread while the request was in flight,
      String(openIdRef.current) !== String(openId) ||
      // ...or a newer request has already answered and this one is obsolete.
      seq !== seqRef.current

    const initial = async () => {
      const seq = ++seqRef.current
      try {
        const data = await api.messages(openId, {
          anchorId: anchor ?? undefined,
          signal: controller.signal,
        })
        if (stale(seq)) return

        setThread({
          conversationId: openId,
          messages: data.messages || [],
          hasMoreBefore: Boolean(data.has_more_before),
          hasMoreAfter: Boolean(data.has_more_after),
        })
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load messages', err.message)
      } finally {
        if (!cancelled) setThreadLoading(false)
      }
    }

    const poll = async () => {
      // While the reader is somewhere in the middle of history there is no
      // live edge to poll towards, and appending would be wrong. The poll
      // resumes by itself the moment they scroll down far enough for
      // has_more_after to clear.
      if (threadRef.current.hasMoreAfter) return
      // In-thread search gets the same treatment as reading history: the
      // reader is parked on a specific message, and a poll that appended or
      // re-anchored underneath them would move it.
      if (threadSearchOpenRef.current) return
      // A page request is already in flight; let it settle first.
      if (loadingMoreRef.current) return

      const seq = ++seqRef.current
      try {
        const data = await api.messages(openId, { signal: controller.signal })
        if (stale(seq)) return

        setThread((current) =>
          String(current.conversationId) !== String(openId)
            ? current
            : {
                ...current,
                messages: mergeMessages(current.messages, data.messages || []),
                // has_more_before describes the TAIL page, not the window the
                // reader has built by scrolling up, so it must not overwrite
                // what is already known about the top of that window.
                hasMoreAfter: false,
              }
        )
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load messages', err.message)
      }
    }

    initial()
    const interval = setInterval(poll, THREAD_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      controller.abort()
    }
  }, [openId, anchor, toast])

  /** Load one page in either direction from the edge of the loaded window. */
  const loadPage = useCallback(
    async (direction) => {
      const current = threadRef.current
      if (loadingMoreRef.current || !current.messages.length) return
      if (direction === 'before' ? !current.hasMoreBefore : !current.hasMoreAfter) return

      const conversationId = current.conversationId
      const edge =
        direction === 'before'
          ? current.messages[0]
          : current.messages[current.messages.length - 1]

      // Set synchronously via the ref too, so two scroll events in the same
      // frame cannot both get through the guard above.
      loadingMoreRef.current = direction
      setLoadingMore(direction)

      try {
        const data = await api.messages(conversationId, {
          [direction === 'before' ? 'beforeId' : 'afterId']: edge.id,
        })
        const rows = data.messages || []

        setThread((state) => {
          if (String(state.conversationId) !== String(conversationId)) return state
          return {
            ...state,
            messages: mergeMessages(state.messages, rows),
            ...(direction === 'before'
              ? { hasMoreBefore: Boolean(data.has_more_before) }
              : { hasMoreAfter: Boolean(data.has_more_after) }),
          }
        })
      } catch (err) {
        if (err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load more messages', err.message)
      } finally {
        loadingMoreRef.current = null
        setLoadingMore(null)
      }
    },
    [toast]
  )

  const loadOlder = useCallback(() => loadPage('before'), [loadPage])
  const loadNewer = useCallback(() => loadPage('after'), [loadPage])

  // The single Undo toast shown after a manual attention dismissal. Only one at
  // a time (a new dismissal replaces it) and it auto-hides after 10s. It holds
  // just the conversation id — the restore endpoint owns the level/reason.
  const [undoId, setUndoId] = useState(null)
  const undoTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(undoTimerRef.current), [])

  const showUndo = useCallback((conversationId) => {
    clearTimeout(undoTimerRef.current)
    setUndoId(conversationId)
    undoTimerRef.current = setTimeout(() => setUndoId(null), 10000)
  }, [])

  /**
   * The conversation whose reason sheet is open, or null. A flag can no longer
   * be cleared by the tap alone — the ✕ and the swipe both land here, and the
   * request is only made once a reason has been given.
   *
   * `error` holds the LAST SERVER REJECTION so the sheet can show it in place.
   * Several of the rules cannot be checked in the browser — the caller's role
   * against the flag's severity, and the "no response" window, which needs the
   * newest inbound timestamp — so the sheet has to be able to fail after submit
   * and stay open with the note intact rather than closing on a refusal.
   */
  const [dismissTarget, setDismissTarget] = useState(null)
  const [dismissError, setDismissError] = useState(null)
  const [dismissSaving, setDismissSaving] = useState(false)

  const openDismissSheet = useCallback((conversationId, level) => {
    setDismissError(null)
    setDismissSaving(false)
    setDismissTarget({ id: conversationId, level })
  }, [])

  const closeDismissSheet = useCallback(() => {
    setDismissTarget(null)
    setDismissError(null)
    setDismissSaving(false)
  }, [])

  /**
   * Commit the dismissal once a reason has been given.
   *
   * NOT optimistic, unlike the old tap-to-dismiss. The server can still refuse
   * — wrong role for a management-level flag, or a "no response" closure inside
   * the 24h window — and nulling the flag before knowing would flash the row
   * out of the list and back in on every rejection. The sheet is already a
   * modal, so the wait is visible and has somewhere to live; the row updates
   * when the refresh lands.
   */
  const confirmDismiss = useCallback(
    async (reason) => {
      if (!dismissTarget) return
      const conversationId = dismissTarget.id

      setDismissSaving(true)
      setDismissError(null)
      try {
        await api.dismissAttention(conversationId, reason)
        closeDismissSheet()
        // Reconcile to server truth — also snaps back any in-flight 5s poll
        // that may still be carrying the old flag.
        refresh()
        showUndo(conversationId)
      } catch (err) {
        // Keep the sheet open with the note intact so the agent can pick a
        // different reason rather than retyping.
        setDismissError(err.message)
        setDismissSaving(false)
      }
    },
    [dismissTarget, closeDismissSheet, refresh, showUndo]
  )

  /**
   * Undo a dismissal. The restore endpoint moves the parked level/reason back
   * server-side, so the client only names the conversation and reconciles — the
   * bar returns with the next (immediate) refresh.
   */
  const restoreAttention = useCallback(
    async (conversationId) => {
      if (conversationId == null) return
      clearTimeout(undoTimerRef.current)
      setUndoId(null)
      try {
        await api.restoreAttention(conversationId)
      } catch (err) {
        toast.error('Could not undo', err.message)
      } finally {
        refresh()
      }
    },
    [toast, refresh]
  )

  const conversation = conversations.find((c) => String(c.id) === String(openId)) || null

  /** Deselect and drop the ?chat= param, so a refresh lands on the list. */
  const closeConversation = useCallback(() => {
    setOpenId(null)
    setMobileView('list')
    setSearchParams({}, { replace: true })
  }, [setOpenId, setMobileView, setSearchParams])

  // If an agent loses access to the open conversation mid-poll, drop back.
  // This is also the path that clears a bad ?chat= from the URL: an id that
  // does not resolve leaves openId set with no conversation, which lands here
  // once the list has loaded.
  useEffect(() => {
    if (openId && !loading && !conversation) closeConversation()
  }, [openId, conversation, loading, closeConversation])

  // Edge-swipe right to go back. Only armed on a phone with a thread open —
  // the hook itself no-ops above 720px.
  useSwipeBack(threadPaneRef, mobileView === 'thread' && Boolean(conversation), () =>
    setMobileView('list')
  )

  const send = async (body, media = null, replyToId = null) => {
    if (!conversation) return
    try {
      const data = await api.send(conversation.id, body, media, replyToId)

      if (threadRef.current.hasMoreAfter) {
        // Sending while reading history would drop the new message below the
        // "scroll down for newer messages" marker, with a gap in between.
        // Clearing the anchor reloads the tail, which is where the reader now
        // wants to be anyway.
        setAnchor(null)
      } else {
        // Only append if that conversation is still the one on screen.
        setThread((current) =>
          String(current.conversationId) === String(conversation.id)
            ? { ...current, messages: [...current.messages, data.message] }
            : current
        )
      }
      applyOutbound(conversation.id, body || (media ? mediaLabel(media.media_type) : ''))

      if (data.message.status === 'send_failed') {
        toast.error('Message not delivered', 'Whapi did not accept it.')
      }
    } catch (err) {
      // Rethrown so the composer can surface it inline as well.
      toast.error('Could not send', err.message)
      throw err
    }
  }

  /**
   * Send an AI-drafted message from the summary popover.
   *
   * Separate from `send` above because the popover can be opened on ANY row,
   * not just the conversation currently on screen — `send` is bound to
   * `conversation` and would post to the wrong thread (or no-op) for any other
   * row. This takes the id explicitly and only touches the visible thread when
   * it happens to be the same one.
   *
   * It goes through the same /api/send as a typed message, so the draft is an
   * ordinary outbound message with nothing marking it as AI-written.
   */
  const sendDraft = useCallback(
    async (conversationId, body) => {
      const text = String(body || '').trim()
      if (!conversationId || !text) return

      const data = await api.send(conversationId, text, null, null)

      // Append only when that conversation is the one open AND the reader is at
      // the live edge; otherwise the list refresh below is the whole update.
      if (
        String(threadRef.current.conversationId) === String(conversationId) &&
        !threadRef.current.hasMoreAfter
      ) {
        setThread((current) =>
          String(current.conversationId) === String(conversationId)
            ? { ...current, messages: [...current.messages, data.message] }
            : current
        )
      }
      applyOutbound(conversationId, text)

      if (data.message.status === 'send_failed') {
        toast.error('Message not delivered', 'Whapi did not accept it.')
      }
      return data
    },
    [applyOutbound, toast]
  )

  /**
   * Forward the current selection into the picked conversations.
   *
   * On failure the selection is deliberately KEPT and the picker stays open, so
   * a network blip is one retry away rather than a re-selection from scratch.
   */
  const forward = async (targetIds) => {
    const messageIds = [...(selection ?? [])]
    if (!messageIds.length || !targetIds.length) return

    setForwarding(true)
    try {
      const data = await api.forward(messageIds, targetIds)

      // Targets changed their preview and ordering; refresh picks that up.
      refresh()

      // Forwarding INTO the open thread: if the reader is looking at history,
      // clearing the anchor reloads the tail where the new messages are.
      // Otherwise the 4s poll appends them on its own, exactly as it does for
      // a message that arrives from anywhere else.
      if (
        threadRef.current.hasMoreAfter &&
        targetIds.some((id) => String(id) === String(openIdRef.current))
      ) {
        setAnchor(null)
      }

      if (data.failed > 0) {
        toast.error(
          'Some forwards failed',
          `${data.forwarded} sent, ${data.failed} could not be delivered.`
        )
        // Partial failure still leaves the mode open so the user can retry the
        // remainder against the same selection.
        setForwarding(false)
        return
      }

      toast.success(`Forwarded to ${targetIds.length} ${targetIds.length === 1 ? 'chat' : 'chats'}`)
      exitSelection()
    } catch (err) {
      toast.error('Could not forward', err.message)
    } finally {
      setForwarding(false)
    }
  }

  return (
    <div className="inbox" data-view={mobileView}>
      <aside className="pane-list">
        {/* Desktop affordance; the mobile one is the FAB inside the list. */}
        <div className="list-actions desktop-only">
          <button
            type="button"
            className="icon-btn"
            aria-label="New message"
            title="New message"
            onClick={() => setComposing(true)}
          >
            <Plus size={18} />
          </button>
        </div>

        <ConversationList
          conversations={conversations}
          openId={openId}
          onOpen={open}
          loading={loading}
          onNewMessage={() => setComposing(true)}
          onRefresh={refresh}
          onDismissAttention={openDismissSheet}
          onSendDraft={sendDraft}
          users={users}
          summaryCache={summaryCache.current}
        />
        {error ? (
          <div style={{ padding: '10px 12px' }}>
            <div className="alert alert-error">{error}</div>
          </div>
        ) : null}
      </aside>

      <section className="pane-thread" ref={threadPaneRef}>
        {!conversation ? (
          <div className="empty">
            <MessagesSquare size={30} />
            <div className="empty-title">Select a conversation</div>
            <div className="empty-sub">
              Pick a conversation on the left to read the thread and reply.
            </div>
          </div>
        ) : (
          <>
            {/* On mobile the bar REPLACES the header — 390px has no room for a
                name, an assign control and a find bar. On desktop it sits
                below, so the conversation being searched stays named. */}
            <header className={`thread-head${threadSearchOpen ? ' is-searching' : ''}`}>
              <button
                type="button"
                className="icon-btn back-btn"
                aria-label="Back to conversations"
                onClick={() => setMobileView('list')}
              >
                <ArrowLeft size={18} />
              </button>

              {/* The avatar opens the info panel too — on mobile the name is
                  squeezed out of view, leaving the avatar as the only target. */}
              <button
                type="button"
                className="thread-avatar-btn"
                onClick={() => setShowInfo(true)}
                aria-label="Conversation info"
              >
                <ContactAvatar conversation={conversation} size={36} className="thread-avatar" />
              </button>

              {/* Tapping the name — group OR 1:1 — opens the info panel. */}
              <button
                type="button"
                className="thread-id thread-id-button"
                onClick={() => setShowInfo(true)}
                aria-label="Conversation info"
              >
                <div className="thread-name">
                  {displayName(conversation)}
                  {/* Which account this chat is on. Shown whenever the user has
                      more than one, regardless of the list filter — inside an
                      open thread there is no other cue, and replying from the
                      wrong number is exactly the mistake to prevent. */}
                  {hasMultipleAccounts && conversation.account_name ? (
                    <span className="thread-account" title={`Account: ${conversation.account_name}`}>
                      <Building2 size={11} />
                      {conversation.account_name}
                    </span>
                  ) : null}
                </div>
                {conversation.is_group ? (
                  <div className="thread-number">
                    <Users size={11} />
                    <span className="thread-sub-label">
                      {conversation.member_count
                        ? `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`
                        : 'Group'}
                    </span>
                  </div>
                ) : (
                  <div className="thread-number">
                    {formatNumber(conversation.customer_number)}
                  </div>
                )}
              </button>

              {/* Click-to-call. Renders the number as a tel: anchor for the
                  dialer extension to pick up; groups become a member picker
                  because the extension dials one person at a time. */}
              <CallControl conversation={conversation} />

              {/* Mints an instant Cal.com meeting and sends its link into the chat. */}
              <VideoCallControl
                conversation={conversation}
                onSend={(body) => send(body)}
                onError={(err) => toast.error('Could not start video call', err.message)}
              />

              <button
                type="button"
                className="icon-btn thread-search-btn"
                aria-label="Search this conversation"
                title="Search this conversation"
                aria-expanded={threadSearchOpen}
                onClick={() => setThreadSearchOpen(true)}
              >
                <Search size={18} />
              </button>

              <button
                type="button"
                className="icon-btn thread-summary-btn"
                aria-label="AI summary"
                title="AI summary"
                onClick={(e) => setSummaryRect(e.currentTarget.getBoundingClientRect())}
              >
                <Sparkles size={18} />
              </button>

              {/* Admin-only: this chat's closure history. Hidden from agents
                  because the audit trail is for the manager — an agent who can
                  see which closures get reviewed learns which ones do not.
                  The endpoint answers 403 either way, so this is presentation,
                  not the boundary. */}
              {isAdmin ? (
                <button
                  type="button"
                  className="icon-btn thread-audit-btn"
                  aria-label="Attention history"
                  title="Attention history"
                  onClick={() => setHistoryOpen(true)}
                >
                  <ShieldCheck size={18} />
                </button>
              ) : null}

              <AssignControl
                conversation={conversation}
                users={users}
                onAssigned={(updated) =>
                  patchConversation(updated.id, {
                    assigned_user_id: updated.assigned_user_id,
                    assigned_to: updated.assigned_to,
                  })
                }
              />
            </header>

            {threadSearchOpen ? (
              // Keyed on the conversation so switching threads with the bar
              // open starts a clean search rather than carrying the old query,
              // match list and cursor across.
              <ThreadSearch
                key={conversation.id}
                conversationId={conversation.id}
                onGoTo={goToMessage}
                onQueryChange={setThreadSearchQuery}
                onClose={closeThreadSearch}
              />
            ) : null}

            {/* Drop zone spans the thread AND the composer, so releasing a
                file anywhere below the header attaches it. Disabled during
                selection mode, where the composer is not even mounted. */}
            <DropZone
              className="thread-drop"
              disabled={selection !== null}
              onFiles={(files) => attachFilesRef.current?.(files)}
            >
            <Thread
              messages={messages}
              loading={threadLoading}
              conversation={conversation}
              hasMoreBefore={threadIsCurrent && thread.hasMoreBefore}
              hasMoreAfter={threadIsCurrent && thread.hasMoreAfter}
              loadingMore={loadingMore}
              onLoadOlder={loadOlder}
              onLoadNewer={loadNewer}
              jumpTo={jumpTo}
              highlightQuery={threadSearchQuery}
              searchActive={threadSearchOpen}
              // The window walked away from where search started, so there is
              // nothing left to scroll back to. Reloading the tail is the
              // honest fallback.
              onRestoreFailed={() => setAnchor(null)}
              selectionMode={selection !== null}
              selectedIds={selection}
              onToggleSelect={toggleSelected}
              onRequestMenu={setMenu}
              onReply={setReplyTo}
              // The quoted block jumps to the message it quotes, loading the
              // window around it first if it has scrolled out of range.
              onJumpToMessage={goToMessage}
              // The per-file shortcut: select just this message and jump
              // straight to the picker, skipping selection mode entirely.
              onForwardMedia={(messageId) => {
                setSelection(new Set([messageId]))
                setPickerOpen(true)
                setQuickForward(true)
              }}
            />

            {/* Selection mode replaces the composer: they are alternative
                modes for the same space, and on a phone both will not fit. */}
            {selection !== null ? (
              <SelectionBar
                count={selection.size}
                onCancel={exitSelection}
                onForward={() => setPickerOpen(true)}
              />
            ) : (
              /* No assignment gate: assignment is a label now, so any signed-in
                 user can reply to any conversation. The server agrees —
                 requireConversationAccess no longer 403s on assignment. */
              <ReplyBox
                conversationId={conversation.id}
                onSend={send}
                isGroup={conversation.is_group}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                conversation={conversation}
                onReady={(attach) => {
                  attachFilesRef.current = attach
                }}
              />
            )}
            </DropZone>
          </>
        )}
      </section>

      {showInfo && conversation ? (
        <ContactPanel
          conversation={conversation}
          onClose={() => setShowInfo(false)}
          onJumpToMessage={(messageId) => {
            // Reuse the anchor loading: jump to the message, then get out of the
            // way so the thread is visible.
            goToMessage(messageId)
            setShowInfo(false)
          }}
        />
      ) : null}

      {menu ? (
        <MessageContextMenu
          x={menu.x}
          y={menu.y}
          message={menu.message}
          onClose={() => setMenu(null)}
          onReply={() => {
            setReplyTo(menu.message)
            setMenu(null)
          }}
          onForward={() => {
            // Entering selection mode pre-selects the message that was pressed,
            // so "Forward" on a single message is two taps, not three.
            setSelection(new Set([menu.message.id]))
            setMenu(null)
          }}
        />
      ) : null}

      {pickerOpen && selection?.size ? (
        <ConversationPicker
          conversations={conversations}
          excludeId={conversation?.id ?? null}
          count={selection.size}
          sending={forwarding}
          onSend={forward}
          // Backing out returns to selection mode with the messages still
          // picked, rather than discarding the work — unless the picker was
          // opened by the per-file shortcut, where selection mode was never
          // asked for and dropping back into it would be a surprise.
          onClose={quickForward ? exitSelection : () => setPickerOpen(false)}
        />
      ) : null}

      {composing ? (
        <NewMessageModal
          onClose={() => setComposing(false)}
          onCreated={(conversationId) => {
            // refresh() picks the new row up on the next poll; opening it now
            // means the thread is already loading when the sheet closes.
            refresh()
            open(conversationId)
          }}
        />
      ) : null}

      {/* This chat's closure history. Gated on `conversation` as well as the
          open flag: switching chats must not leave the panel showing the
          previous one's history under the new header. */}
      {historyOpen && conversation && isAdmin ? (
        <AttentionHistoryModal
          conversation={conversation}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {/* Same popover, cache and actions as the list rows' ✦ Summary. */}
      {summaryRect && conversation ? (
        <SummaryPopover
          key={conversation.id}
          conversation={conversation}
          anchorRect={summaryRect}
          cache={summaryCache.current}
          onDismiss={openDismissSheet}
          onSend={sendDraft}
          onClose={() => setSummaryRect(null)}
        />
      ) : null}

      {/* The reason sheet. Every path that clears a flag — the hover ✕, the
          touch swipe, and the summary popover's banner — opens this rather than
          dismissing, so a closure without a recorded reason is not reachable
          from the UI at all. */}
      {dismissTarget ? (
        <DismissReasonModal
          level={dismissTarget.level}
          error={dismissError}
          saving={dismissSaving}
          onCancel={closeDismissSheet}
          onConfirm={confirmDismiss}
        />
      ) : null}

      {/* Undo toast for a just-dismissed attention flag. Bottom-centre, one at a
          time, auto-hides after 10s; "Undo" restores the flag. */}
      {undoId != null ? (
        <div className="undo-toast" role="status" aria-live="polite">
          <span className="undo-toast-text">Attention dismissed</span>
          <button
            type="button"
            className="undo-toast-btn"
            onClick={() => restoreAttention(undoId)}
          >
            Undo
          </button>
        </div>
      ) : null}
    </div>
  )
}
