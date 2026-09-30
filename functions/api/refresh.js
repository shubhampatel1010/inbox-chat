import { signJWT } from '../_lib/jwt.js'
import {
  readCookie,
  rotateRefreshToken,
  refreshCookie,
  clearRefreshCookie,
  REFRESH_COOKIE,
} from '../_lib/tokens.js'
import { json, serverError } from '../_lib/respond.js'

/**
 * POST /api/refresh
 *
 * Reads the HttpOnly refresh cookie, validates and ROTATES it, and returns a
 * fresh 15-minute access token. Rotation means the presented token is revoked
 * as part of the same call, so a captured cookie is single-use.
 *
 * Takes no body and needs no Authorization header — the cookie is the
 * credential. Called on cold start and whenever an access token expires.
 */
export async function onRequestPost({ request, env }) {
  const presented = readCookie(request, REFRESH_COOKIE)

  try {
    const result = await rotateRefreshToken(env, presented, request)

    if (!result.ok) {
      // Any failure clears the cookie so the client stops re-presenting a
      // token that will never work again.
      return json(
        { ok: false, error: 'Session expired' },
        401,
        presented ? { 'Set-Cookie': clearRefreshCookie() } : {}
      )
    }

    const token = await signJWT(
      {
        sub: String(result.user.id),
        email: result.user.email,
        role: result.user.role,
        name: result.user.name,
      },
      env
    )

    return json(
      { ok: true, token, user: result.user },
      200,
      { 'Set-Cookie': refreshCookie(result.token) }
    )
  } catch (err) {
    return serverError(err.message || 'Could not refresh the session')
  }
}
