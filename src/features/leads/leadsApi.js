// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// This does NOT extend src/lib/api.js on purpose. Keeping the call here means
// deleting src/features/leads/ takes the whole feature with it, leaving the
// shared api surface exactly as it was.

import { getToken, refreshSession, ApiError } from '../../lib/api.js'

/**
 * GET /api/leads/mine
 *
 * Both calls go through request(), which retries once behind a silent refresh
 * — the same contract the shared client uses. The inbox polls for minutes at a
 * time, so an access token expiring mid-session is routine, not exceptional.
 *
 * Deliberately does NOT call the shared session-lost handler on failure: a
 * secondary banner must never be the thing that signs a user out. If the
 * session is genuinely gone, the inbox's own polling will discover it.
 */
export async function fetchMyLeads({ signal } = {}) {
  const data = await request('/api/leads/mine', { signal })
  return Array.isArray(data?.leads) ? data.leads : []
}

/** POST /api/leads/outcome — returns the lead's resulting { id, status }. */
export async function logLeadOutcome(id, outcome) {
  const data = await request('/api/leads/outcome', {
    method: 'POST',
    body: JSON.stringify({ id, outcome }),
  })
  return data?.lead
}

async function request(url, { method = 'GET', body, signal } = {}, retried = false) {
  const headers = getToken() ? { Authorization: `Bearer ${getToken()}` } : {}
  if (body) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(url, { method, body, headers, credentials: 'same-origin', signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Network error', 0)
  }

  if (res.status === 401 && !retried) {
    const refreshed = await refreshSession()
    if (refreshed) return request(url, { method, body, signal }, true)
    throw new ApiError('Unauthorized', 401)
  }

  const data = await res.json().catch(() => null)
  if (!res.ok || data?.ok === false) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data)
  }
  return data
}
