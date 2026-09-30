import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { hashPassword, generateTempPassword } from '../../_lib/hash.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { user_id, new_password } = await readJson(request)

  const userId = Number(user_id)
  if (!Number.isInteger(userId) || userId <= 0) return badRequest('user_id is required')

  const generated = new_password === undefined || new_password === null || new_password === ''
  const password = generated ? generateTempPassword(10) : String(new_password)

  if (!generated && password.length < 8) {
    return badRequest('New password must be at least 8 characters')
  }

  try {
    const updated = unwrap(
      await getDb(env)
        .from('wp_chat_users')
        .update({ password_hash: await hashPassword(password) })
        .eq('id', userId)
        .select('id, name, email')
        .maybeSingle()
    )

    if (!updated) return notFound('User not found')

    // Only echo the password back when we generated it — the admin has to
    // hand it over, and it is the one copy that exists.
    return json(generated ? { ok: true, temp_password: password } : { ok: true })
  } catch (err) {
    return serverError(err.message || 'Failed to reset password')
  }
}
