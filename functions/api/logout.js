import { readCookie, revokeRefreshToken, clearRefreshCookie, REFRESH_COOKIE } from '../_lib/tokens.js'
import { json } from '../_lib/respond.js'

/**
 * POST /api/logout
 *
 * Revokes ONLY the refresh token presented by this device and clears its
 * cookie — other devices keep their own rows and stay signed in.
 *
 * Deliberately requires no access token: logging out must work even when the
 * access token has already expired, and it always answers 200 so the client
 * can clear local state unconditionally.
 */
export async function onRequestPost({ request, env }) {
  const presented = readCookie(request, REFRESH_COOKIE)

  try {
    await revokeRefreshToken(env, presented)
  } catch {
    // A failed revoke must not strand the user in a signed-in UI; the cookie
    // is cleared below regardless and the token still expires on its own.
  }

  return json({ ok: true }, 200, { 'Set-Cookie': clearRefreshCookie() })
}
