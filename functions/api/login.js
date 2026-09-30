import { findUserByEmail } from '../_lib/db.js'
import { verifyPassword } from '../_lib/hash.js'
import { signJWT } from '../_lib/jwt.js'
import { issueRefreshToken, refreshCookie } from '../_lib/tokens.js'
import { json, badRequest, unauthorized, serverError, readJson } from '../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  try {
    const { email, password } = await readJson(request)

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return badRequest('Email and password are required')
    }

    const user = await findUserByEmail(env, email, 'id, name, email, role, password_hash, is_active')

    // Same message for unknown user, inactive user and wrong password —
    // don't leak which one it was.
    if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
      return unauthorized('Invalid email or password')
    }

    const token = await signJWT(
      { sub: String(user.id), email: user.email, role: user.role, name: user.name },
      env
    )

    // The refresh token goes out as an HttpOnly cookie and is never included
    // in the body, so JavaScript cannot read it.
    const refresh = await issueRefreshToken(env, user.id, request)

    return json(
      {
        ok: true,
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      },
      200,
      { 'Set-Cookie': refreshCookie(refresh) }
    )
  } catch (err) {
    return serverError(err.message || 'Login failed')
  }
}
