import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, serverError } from '../_lib/respond.js'

/**
 * GET /api/users[?account_id=N]
 *
 * The roster. With account_id it is narrowed to the users who can actually work
 * that account — which is what the assign picker wants, since offering an agent
 * who cannot open the conversation would only produce a failed assignment.
 * Admins are always included: they reach every account by role.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    const db = getDb(env)

    // password_hash is never selected here.
    let users =
      unwrap(
        await db
          .from('wp_chat_users')
          .select('id, name, email, role, is_active, created_at, department')
          .order('is_active', { ascending: false })
      ) || []

    const accountId = Number(new URL(request.url).searchParams.get('account_id'))
    if (Number.isInteger(accountId) && accountId > 0) {
      const members =
        unwrap(
          await db.from('wp_chat_user_accounts').select('user_id').eq('account_id', accountId)
        ) || []
      const assigned = new Set(members.map((m) => String(m.user_id)))
      users = users.filter((u) => u.role === 'admin' || assigned.has(String(u.id)))
    }

    // PostgREST can't order by lower(name), so sort the (small) roster here to
    // keep the case-insensitive ordering the SQL version had.
    users.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        sensitivity: 'base',
      })
    })

    return json({ ok: true, users })
  } catch (err) {
    return serverError(err.message || 'Failed to load users')
  }
}
