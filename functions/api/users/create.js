import { getDb, unwrap, findUserByEmail, UNIQUE_VIOLATION } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { hashPassword } from '../../_lib/hash.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { name, email, password, role, department } = await readJson(request)

  if (typeof name !== 'string' || !name.trim()) return badRequest('Name is required')
  if (typeof email !== 'string' || !email.includes('@')) {
    return badRequest('A valid email is required')
  }
  if (typeof password !== 'string' || password.length < 8) {
    return badRequest('Password must be at least 8 characters')
  }
  const userRole = role === 'admin' ? 'admin' : 'agent'

  // Department: admins have none; a new agent must be given one. Existing agents
  // may already be department-less (the column is nullable) — that is only about
  // pre-existing rows, not new creations.
  const dept = department == null || department === '' ? null : department
  if (userRole === 'agent' && !['sales', 'operations'].includes(dept)) {
    return badRequest("An agent's department must be 'sales' or 'operations'")
  }
  const finalDepartment = userRole === 'admin' ? null : dept

  try {
    const existing = await findUserByEmail(env, email, 'id, email')
    if (existing) return badRequest('A user with that email already exists')

    const passwordHash = await hashPassword(password)

    const user = unwrap(
      await getDb(env)
        .from('wp_chat_users')
        .insert({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password_hash: passwordHash,
          role: userRole,
          department: finalDepartment,
          is_active: true,
          created_at: new Date().toISOString(),
        })
        .select('id, name, email, role, is_active, created_at, department')
        .single()
    )

    return json({ ok: true, user })
  } catch (err) {
    // Belt and braces: the UNIQUE index can still fire on a concurrent insert.
    if (err.code === UNIQUE_VIOLATION || String(err.message || '').includes('duplicate key')) {
      return badRequest('A user with that email already exists')
    }
    return serverError(err.message || 'Failed to create user')
  }
}
