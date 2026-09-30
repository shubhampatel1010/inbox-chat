import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { getAccount } from '../../_lib/accounts.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'

/**
 * Which users are assigned to which accounts. Admin only.
 *
 * Admins are deliberately absent from wp_chat_user_accounts — they reach every
 * account by role. Listing them as assignable would imply an admin could be
 * REMOVED from an account, which is not true and would be a confusing control.
 * So this endpoint manages agents' membership only.
 */

/**
 * GET /api/accounts/users?account_id=N  (admin)
 *
 * Returns every agent with a flag for whether they are on this account, so the
 * UI can render the full roster with checkboxes in one request rather than
 * diffing two lists.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  try {
    const url = new URL(request.url)
    const account = await getAccount(env, url.searchParams.get('account_id'))
    if (!account) return notFound('Account not found')

    const db = getDb(env)

    const users =
      unwrap(
        await db
          .from('wp_chat_users')
          .select('id, name, email, role, is_active, department')
          .order('is_active', { ascending: false })
      ) || []

    const members =
      unwrap(
        await db.from('wp_chat_user_accounts').select('user_id').eq('account_id', account.id)
      ) || []

    const assigned = new Set(members.map((m) => String(m.user_id)))

    // Same case-insensitive ordering /api/users uses — PostgREST cannot order by
    // lower(name), so the (small) roster is sorted here.
    users.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    })

    return json({
      ok: true,
      account_id: account.id,
      users: users.map((u) => ({
        ...u,
        // Admins read as assigned-and-locked: they do have access, but it comes
        // from their role and cannot be toggled off here.
        assigned: u.role === 'admin' ? true : assigned.has(String(u.id)),
        locked: u.role === 'admin',
      })),
    })
  } catch (err) {
    return serverError(err.message || 'Failed to load account users')
  }
}

/**
 * POST /api/accounts/users  (admin)
 *
 * Body: { account_id, user_ids: [...] } — the COMPLETE membership list for the
 * account. Declarative rather than add/remove deltas: the UI holds a set of
 * checkboxes, so sending the resulting set makes the request idempotent and
 * immune to a lost delta leaving membership half-applied.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)

  try {
    const account = await getAccount(env, body?.account_id)
    if (!account) return notFound('Account not found')

    if (!Array.isArray(body?.user_ids)) return badRequest('user_ids must be an array')

    const db = getDb(env)

    const requested = [
      ...new Set(body.user_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)),
    ]

    // Only real, non-admin users may be written. An admin id in the list is
    // dropped rather than rejected — the UI renders admins as locked-on, so
    // echoing them back is expected, not an error.
    const valid =
      requested.length
        ? unwrap(await db.from('wp_chat_users').select('id, role').in('id', requested)) || []
        : []
    const toAssign = valid.filter((u) => u.role !== 'admin').map((u) => Number(u.id))

    // Replace the membership set. Delete-then-insert is safe here because the
    // table holds no state beyond the pairing itself — there is nothing to lose
    // by recreating a row, and it keeps "the set you sent is the set you get"
    // literally true.
    unwrap(await db.from('wp_chat_user_accounts').delete().eq('account_id', account.id))

    if (toAssign.length) {
      unwrap(
        await db
          .from('wp_chat_user_accounts')
          .insert(toAssign.map((userId) => ({ user_id: userId, account_id: account.id })))
      )
    }

    return json({ ok: true, account_id: account.id, user_ids: toAssign })
  } catch (err) {
    return serverError(err.message || 'Failed to update account users')
  }
}
