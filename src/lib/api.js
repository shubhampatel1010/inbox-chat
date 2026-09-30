// Fetch wrapper.
//
// Access token lives in memory only — never sessionStorage, never localStorage.
// Durable session state is the HttpOnly refresh cookie, which this file cannot
// read by design; it only ever calls /api/refresh and lets the browser attach
// the cookie.

let token = null
let onSessionLost = null

export function setToken(value) {
  token = value || null
}

export function getToken() {
  return token
}

/** Called only after a refresh attempt has itself failed. */
export function setSessionLostHandler(fn) {
  onSessionLost = fn
}

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    // The parsed response body, when there was one. Lets a caller inspect a
    // structured soft-failure (e.g. { ok:false, status:'starting' }) that the
    // wrapper still throws on because ok===false.
    this.data = data
  }
}

// Endpoints that must never trigger the refresh-and-retry path: a 401 from
// these IS the answer, and retrying would recurse.
const NO_RETRY = new Set(['/login', '/refresh', '/logout'])

/**
 * A single shared in-flight refresh.
 *
 * The inbox polls conversations every 5s and the open thread every 4s. When an
 * access token expires those land together, so without this every pending
 * request would fire its own /api/refresh — a storm, and worse, each rotation
 * would invalidate the previous one and log the user out. Everyone awaits the
 * same promise instead.
 */
let refreshInFlight = null

export function refreshSession() {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-store' },
      })
      if (!res.ok) return null

      const data = await res.json().catch(() => null)
      if (!data?.ok || !data.token) return null

      setToken(data.token)
      return data
    } catch {
      // Offline or network failure — indistinguishable from an expired
      // session here, so the caller decides what to do.
      return null
    } finally {
      // Cleared in a microtask so callers that awaited this exact promise all
      // observe the same result before a new attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null
      })
    }
  })()

  return refreshInFlight
}

function buildHeaders(extra = {}) {
  const headers = { ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Core request. On a 401 it attempts exactly one silent refresh and exactly
 * one retry — `retried` guards against any possibility of a loop.
 */
async function send(path, { method = 'GET', body, signal, raw = false } = {}, retried = false) {
  const headers = buildHeaders(
    body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}
  )

  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      // FormData must be passed through untouched so the browser sets the
      // multipart boundary itself.
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Network error — check your connection', 0)
  }

  if (res.status === 401 && !retried && !NO_RETRY.has(path.split('?')[0])) {
    const refreshed = await refreshSession()
    if (refreshed) return send(path, { method, body, signal, raw }, true)

    // Refresh failed too — the session is genuinely gone.
    setToken(null)
    if (onSessionLost) onSessionLost()
    throw new ApiError('Your session has expired. Please sign in again.', 401)
  }

  if (res.status === 401) {
    if (!NO_RETRY.has(path.split('?')[0])) {
      setToken(null)
      if (onSessionLost) onSessionLost()
    }
    throw new ApiError('Your session has expired. Please sign in again.', 401)
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON body — fall through to the status-based message */
  }

  if (!res.ok || data?.ok === false) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data)
  }

  return data ?? {}
}

const request = (path, options) => send(path, options)

export const api = {
  login: (email, password) =>
    request('/login', { method: 'POST', body: { email, password } }),

  /** Cold-start session restore. Resolves to {token, user} or null. */
  refresh: () => refreshSession(),

  logout: () =>
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null),

  /**
   * The inbox list. `accountId` narrows it to one account; omitted (or 'all'),
   * the server returns every conversation the caller can reach, each tagged
   * with its account. The response also carries the caller's accounts, so the
   * switcher and the per-row account badge come from this one request.
   */
  conversations: (accountId, signal) => {
    // Back-compat: this used to be conversations(signal). An AbortSignal in the
    // first position still works, so no existing call site had to change.
    if (accountId && typeof accountId === 'object') return request('/conversations', { signal: accountId })
    const query = accountId && accountId !== 'all' ? `?account_id=${encodeURIComponent(accountId)}` : ''
    return request(`/conversations${query}`, { signal })
  },

  /** Accounts the caller may use. `all` (admin) also returns deactivated ones. */
  accounts: ({ all = false, signal } = {}) =>
    request(all ? '/accounts?all=1' : '/accounts', { signal }),

  createAccount: (payload) => request('/accounts', { method: 'POST', body: payload }),

  /** Admin: this account's effective settings + masked secrets. */
  accountSettings: (accountId, signal) =>
    request(`/accounts/settings?account_id=${encodeURIComponent(accountId)}`, { signal }),

  /** Admin: partial update — omitted keys are left untouched. */
  saveAccountSettings: (payload) =>
    request('/accounts/settings', { method: 'POST', body: payload }),

  /** Admin: test this account's Whapi credentials. */
  testAccount: (accountId) =>
    request('/accounts/settings', { method: 'PUT', body: { account_id: accountId } }),

  /** Admin: the roster with an `assigned` flag for this account. */
  accountUsers: (accountId, signal) =>
    request(`/accounts/users?account_id=${encodeURIComponent(accountId)}`, { signal }),

  /** Admin: replace the account's membership with exactly these users. */
  setAccountUsers: (accountId, userIds) =>
    request('/accounts/users', { method: 'POST', body: { account_id: accountId, user_ids: userIds } }),

  newConversation: (payload) =>
    request('/conversations/new', { method: 'POST', body: payload }),

  /**
   * One page of a thread.
   *
   * With no anchorId/beforeId/afterId this is the newest page and behaves as
   * the endpoint always has. The three cursor options are mutually exclusive;
   * the server rejects any combination rather than silently picking one.
   */
  messages: (conversationId, { anchorId, beforeId, afterId, signal } = {}) => {
    const params = new URLSearchParams({ conversation_id: String(conversationId) })
    if (anchorId != null) params.set('anchor_id', String(anchorId))
    else if (beforeId != null) params.set('before_id', String(beforeId))
    else if (afterId != null) params.set('after_id', String(afterId))
    return request(`/messages?${params}`, { signal })
  },

  /**
   * Message-body search.
   *
   * Global by default. With conversationId it is scoped to that thread and
   * comes back oldest-first, which is the order the in-thread stepper walks.
   */
  search: (query, { conversationId, limit, cursor, accountId, signal } = {}) => {
    const params = new URLSearchParams({ q: query })
    if (conversationId != null) params.set('conversation_id', String(conversationId))
    // Only meaningful for a global search — a scoped one is already pinned to a
    // conversation, and therefore to its account.
    if (accountId != null && accountId !== 'all' && conversationId == null) {
      params.set('account_id', String(accountId))
    }
    if (limit != null) params.set('limit', String(limit))
    if (cursor) {
      params.set('cursor_at', cursor.at)
      params.set('cursor_id', String(cursor.id))
    }
    return request(`/search?${params}`, { signal })
  },

  /**
   * AI summary for one conversation. The server decides whether to return the
   * cached summary or (re)generate per the 6-hour / new-activity rules, so the
   * client just asks and renders whatever comes back.
   */
  summary: (conversationId, signal) =>
    request(`/conversation/summary?conversation_id=${encodeURIComponent(conversationId)}`, {
      signal,
    }),

  /**
   * Ask a free-form question about ONE conversation, or have the AI draft a
   * message for it. Reads the WHOLE thread, not just the summary's 30-day
   * window, and stores nothing — so it never disturbs the cached summary.
   *
   * `history` is the panel's prior turns, so follow-ups like "make it shorter"
   * resolve against the last answer.
   */
  askAi: (conversationId, question, { history = [], signal } = {}) =>
    request('/conversation/ask', {
      method: 'POST',
      body: { conversation_id: conversationId, question, history },
      signal,
    }),

  /**
   * Ask a question across the WHOLE portal — every conversation the caller can
   * reach, group chats and personal chats alike — or ask for a daily report.
   *
   * Answered from the stored per-conversation summaries rather than raw
   * transcripts, so the cost is fixed however busy the inbox is. Stores
   * nothing: the panel's turns are session-only and travel back as `history`.
   *
   * `accountId` narrows the scan to one account; omitted (or 'all') spans every
   * account the user is on.
   */
  portalAsk: (question, { history = [], accountId = null, signal } = {}) =>
    request('/portal/ask', {
      method: 'POST',
      body: {
        question,
        history,
        ...(accountId && accountId !== 'all' ? { account_id: accountId } : {}),
      },
      signal,
    }),

  /**
   * Bulk read of stored short summaries, for warming the popover cache.
   * Read-only: it never generates, so a miss here just means "not summarised
   * yet" and the per-conversation endpoint remains the way to produce one.
   */
  summariesBatch: (conversationIds, signal) =>
    request(`/summaries/batch?ids=${conversationIds.join(',')}`, { signal }),

  /** Mint an instant Cal.com meeting link for a conversation. Does not send it. */
  createVideoCall: (conversationId) =>
    request('/video-call', { method: 'POST', body: { conversation_id: conversationId } }),

  /** `replyTo` is the id of the message being quoted, or null for a normal send. */
  send: (conversationId, body, media = null, replyTo = null) =>
    request('/send', {
      method: 'POST',
      body: {
        conversation_id: conversationId,
        body,
        ...(media || {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      },
    }),

  /**
   * Forward existing messages into other conversations.
   * Resolves to { forwarded, failed, ... } — a partial failure still resolves,
   * so the caller reports counts rather than treating it as a thrown error.
   */
  forward: (messageIds, targetConversationIds) =>
    request('/messages/forward', {
      method: 'POST',
      body: { message_ids: messageIds, target_conversation_ids: targetConversationIds },
    }),

  /** Uploads one file as multipart/form-data. Returns the media_* fields. */
  upload: (conversationId, file, signal) => {
    const form = new FormData()
    form.append('conversation_id', String(conversationId))
    form.append('file', file)
    return request('/upload', { method: 'POST', body: form, signal, raw: true })
  },

  /** Short-lived signed URL for a private storage object. */
  mediaUrl: (mediaPath, signal) =>
    request(`/media/${String(mediaPath).split('/').map(encodeURIComponent).join('/')}`, {
      signal,
    }),

  assign: (conversationId, assignedUserId) =>
    request('/assign', {
      method: 'POST',
      body: { conversation_id: conversationId, assigned_user_id: assignedUserId },
    }),

  /**
   * Manually clear a conversation's attention flag.
   *
   * `reason` is { reason_category, reason_note } and is NOT optional — the
   * endpoint rejects a dismissal without one, and the reason is written to the
   * append-only audit trail before the flag is touched.
   */
  dismissAttention: (conversationId, reason) =>
    request('/conversation/dismiss-attention', {
      method: 'POST',
      body: { conversation_id: conversationId, ...reason },
    }),

  /**
   * The attention closure audit log. ADMIN ONLY — the endpoint answers 403 to
   * an agent, so callers must gate the UI on isAdmin as well.
   *
   * `filters` keys map straight to the query parameters: conversation_id,
   * account_id, actor_user_id, category, action, since, until, limit, offset.
   * Empty and null values are dropped rather than sent blank, which the server
   * would treat as a filter on an empty string.
   */
  attentionEvents: (filters = {}, { signal } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined || value === '') continue
      params.set(key, String(value))
    }
    const qs = params.toString()
    return request(`/attention/events${qs ? `?${qs}` : ''}`, { signal })
  },

  /** Undo a dismissal — flip the retained attention flag back on. */
  restoreAttention: (conversationId) =>
    request('/conversation/restore-attention', {
      method: 'POST',
      body: { conversation_id: conversationId },
    }),

  pushKey: () => request('/push/key'),

  pushSubscribe: (subscription) =>
    request('/push/subscribe', { method: 'POST', body: subscription }),

  pushUnsubscribe: (endpoint) =>
    request('/push/unsubscribe', { method: 'POST', body: { endpoint } }),

  /**
   * One page of a conversation's shared media, one tab at a time.
   * tab: 'media' | 'docs' | 'links'. Keyset-paginated newest-first.
   */
  conversationMedia: (conversationId, tab, { cursor, signal } = {}) => {
    const params = new URLSearchParams({
      conversation_id: String(conversationId),
      tab,
    })
    if (cursor) {
      params.set('cursor_at', cursor.at)
      params.set('cursor_id', String(cursor.id))
    }
    return request(`/conversation/media?${params}`, { signal })
  },

  groupMembers: (conversationId, signal) =>
    request(`/groups/members?conversation_id=${encodeURIComponent(conversationId)}`, { signal }),

  refreshGroupMembers: (conversationId) =>
    request('/groups/members', { method: 'POST', body: { conversation_id: conversationId } }),

  /** Health of ONE account's channel. Omitted account -> the caller's first. */
  channelStatus: (accountId, signal) => {
    // Back-compat with the old channelStatus(signal) shape.
    if (accountId && typeof accountId === 'object') return request('/channel/status', { signal: accountId })
    const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
    return request(`/channel/status${query}`, { signal })
  },

  /** Ask Whapi to relaunch this account's channel, then report health. */
  channelRelaunch: (accountId) =>
    request('/channel/relaunch', { method: 'POST', body: accountId ? { account_id: accountId } : {} }),

  /** A fresh login QR (data URL) for this account, or { connected: true }. */
  channelQr: (accountId, signal) => {
    if (accountId && typeof accountId === 'object') return request('/channel/qr', { signal: accountId })
    const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
    return request(`/channel/qr${query}`, { signal })
  },

  /**
   * The roster. `accountId` narrows it to users who can work that account,
   * which is what the assign picker needs — offering an agent who cannot open
   * the conversation would only produce a rejected assignment.
   */
  users: (accountId, signal) => {
    // (accountId, signal), matching conversations/channelStatus/channelQr. The
    // object sniff keeps the original users(signal) shape working, so a caller
    // that passes only a signal is still scoped correctly rather than silently
    // fetching an unscoped roster.
    if (accountId && typeof accountId === 'object') return request('/users', { signal: accountId })
    const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
    return request(`/users${query}`, { signal })
  },

  createUser: (payload) => request('/users/create', { method: 'POST', body: payload }),

  setUserDepartment: (id, department) =>
    request('/users/department', { method: 'POST', body: { id, department } }),

  changePassword: (currentPassword, newPassword) =>
    request('/password/change', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    }),

  resetPassword: (userId, newPassword) =>
    request('/password/reset', {
      method: 'POST',
      body: { user_id: userId, new_password: newPassword ?? null },
    }),

  // --- admin sync / backfill ---
  syncStart: (scope) => request('/sync/start', { method: 'POST', body: scope }),

  /** One sync step. `promote` runs a deferred (too-long auto) job on admin request. */
  syncStep: (jobId, { promote = false, signal } = {}) =>
    request('/sync/step', {
      method: 'POST',
      body: { job_id: jobId, ...(promote ? { promote: true } : {}) },
      signal,
    }),

  syncStatus: (jobId, signal, accountId = null) => {
    if (jobId != null) return request(`/sync/status?job_id=${encodeURIComponent(jobId)}`, { signal })
    const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
    return request(`/sync/status${query}`, { signal })
  },

  /** Admin: clear this account's auto-recovery halt. */
  clearAutoHalt: (accountId) =>
    request('/channel/clear-halt', { method: 'POST', body: accountId ? { account_id: accountId } : {} }),
}
