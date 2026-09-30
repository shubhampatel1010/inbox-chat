import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'

const DEPARTMENTS = ['sales', 'operations']

/**
 * POST /api/users/department  (admin only)
 *
 * Sets ONLY the department for an agent. Deliberately narrow — it does not touch
 * role, activation, name, or any other user field. Admins have no department, so
 * assigning one to an admin is rejected.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { id, department } = await readJson(request)

  const userId = Number(id)
  if (!Number.isInteger(userId) || userId <= 0) return badRequest('A valid user id is required')

  const dept = department == null || department === '' ? null : department
  if (dept !== null && !DEPARTMENTS.includes(dept)) {
    return badRequest("Department must be 'sales', 'operations', or null")
  }

  try {
    const db = getDb(env)

    const user = unwrap(
      await db.from('wp_chat_users').select('id, role').eq('id', userId).maybeSingle()
    )
    if (!user) return notFound('User not found')
    if (user.role === 'admin' && dept !== null) {
      return badRequest('Admins do not belong to a department')
    }

    const updated = unwrap(
      await db
        .from('wp_chat_users')
        .update({ department: dept })
        .eq('id', userId)
        .select('id, name, email, role, is_active, created_at, department')
        .single()
    )

    return json({ ok: true, user: updated })
  } catch (err) {
    return serverError(err.message || 'Failed to update department')
  }
}
