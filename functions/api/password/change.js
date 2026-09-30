import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { hashPassword, verifyPassword } from '../../_lib/hash.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { current_password, new_password } = await readJson(request)

  if (typeof current_password !== 'string' || !current_password) {
    return badRequest('Current password is required')
  }
  if (typeof new_password !== 'string' || new_password.length < 8) {
    return badRequest('New password must be at least 8 characters')
  }

  try {
    const db = getDb(env)

    const row = unwrap(
      await db
        .from('wp_chat_users')
        .select('password_hash')
        .eq('id', auth.user.id)
        .maybeSingle()
    )

    if (!row || !(await verifyPassword(current_password, row.password_hash))) {
      return badRequest('Current password is incorrect')
    }

    unwrap(
      await db
        .from('wp_chat_users')
        .update({ password_hash: await hashPassword(new_password) })
        .eq('id', auth.user.id)
    )

    return json({ ok: true })
  } catch (err) {
    return serverError(err.message || 'Failed to change password')
  }
}
