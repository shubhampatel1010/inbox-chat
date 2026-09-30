import { getDb, unwrap } from './db.js'

// Two-token session model.
//
//   access  — 15 min, JWT, returned in the response body, held in memory only.
//   refresh — 30 days, opaque random string, HttpOnly cookie, never readable
//             from JavaScript. Only its SHA-256 hash is stored server-side.
//
// The refresh token is opaque rather than a JWT so that revocation is
// authoritative: the row in wp_chat_refresh_tokens IS the session.

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

export const REFRESH_COOKIE = 'wpchat_rt'

/** 32 bytes of entropy, base64url. */
function newRefreshToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * SHA-256 hex. A fast hash is correct here — unlike a password, the token is
 * 256 bits of uniform entropy, so there is nothing to brute-force.
 */
async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reads one cookie off the request. */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * HttpOnly so JavaScript can never read it; Secure + SameSite=Lax; Path=/ so
 * it is sent to every /api route. Host-scoped (no Domain attribute).
 *
 * Note: a first-party cookie set by the server is NOT subject to Safari ITP's
 * 7-day cap — that cap only applies to cookies written via document.cookie.
 * This is what makes the iOS home-screen PWA survive being evicted.
 */
export function refreshCookie(token) {
  return [
    `${REFRESH_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${REFRESH_TTL_SECONDS}`,
  ].join('; ')
}

export function clearRefreshCookie() {
  return `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

const userAgentOf = (request) =>
  (request.headers.get('User-Agent') || '').slice(0, 400) || null

/** Creates a refresh-token row and returns the raw token (shown once). */
export async function issueRefreshToken(env, userId, request) {
  const token = newRefreshToken()
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString()

  unwrap(
    await getDb(env)
      .from('wp_chat_refresh_tokens')
      .insert({
        user_id: userId,
        token_hash: await hashToken(token),
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        user_agent: userAgentOf(request),
      })
  )

  return token
}

/**
 * Validates a refresh token and rotates it: the presented token is revoked and
 * a replacement is issued. Returns {ok, user, token} or {ok:false, reason}.
 */
export async function rotateRefreshToken(env, token, request) {
  if (!token) return { ok: false, reason: 'missing' }

  const db = getDb(env)
  const tokenHash = await hashToken(token)

  const row = unwrap(
    await db
      .from('wp_chat_refresh_tokens')
      .select('id, user_id, expires_at, revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()
  )

  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revoked_at) return { ok: false, reason: 'reused' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  // Compare-and-swap: only the caller that actually flips revoked_at from NULL
  // gets to rotate. Two concurrent refreshes cannot both mint a token.
  const claimed = unwrap(
    await db
      .from('wp_chat_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle()
  )
  if (!claimed) return { ok: false, reason: 'raced' }

  // Re-read the user so a deactivated account cannot refresh its way back in.
  const user = unwrap(
    await db
      .from('wp_chat_users')
      .select('id, name, email, role, is_active')
      .eq('id', row.user_id)
      .maybeSingle()
  )
  if (!user || !user.is_active) return { ok: false, reason: 'inactive' }

  return {
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    token: await issueRefreshToken(env, user.id, request),
  }
}

/** Revokes a single token — this device only, never the whole account. */
export async function revokeRefreshToken(env, token) {
  if (!token) return
  await getDb(env)
    .from('wp_chat_refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', await hashToken(token))
    .is('revoked_at', null)
}
