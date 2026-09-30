import { verifyJWT } from './jwt.js'
import { getDb, unwrap } from './db.js'
import { accessibleAccountIds } from './accounts.js'

/**
 * Resolves the caller from the Authorization header.
 * Returns {user} on success or {response} holding the error to return.
 * The user row is re-read from the DB so a deactivated account loses access
 * immediately rather than at token expiry.
 */
export async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  const payload = await verifyJWT(token, env)
  if (!payload?.sub) {
    return { response: unauth() }
  }

  const user = unwrap(
    await getDb(env)
      .from('wp_chat_users')
      .select('id, name, email, role, is_active')
      .eq('id', payload.sub)
      .maybeSingle()
  )

  if (!user || !user.is_active) {
    return { response: unauth() }
  }

  return { user }
}

export async function requireAdmin(request, env) {
  const result = await requireAuth(request, env)
  if (result.response) return result
  if (result.user.role !== 'admin') {
    return {
      response: new Response(
        JSON.stringify({ ok: false, error: 'Admin access required' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    }
  }
  return result
}

/**
 * Loads a conversation the caller may access.
 *
 * Assignment is NOT a permission boundary — every agent sees, reads and replies
 * to every conversation in an account they belong to, assigned or not;
 * `assigned_user_id` is only a "who is handling this" label. That much is as it
 * was before multi-account; what changed is the account gate below.
 *
 * The ACCOUNT, however, IS a boundary, and this is the one place it is enforced
 * for conversation-scoped endpoints. Every such endpoint already funnels through
 * here (send, messages, upload, media, search, summary, forward, group members,
 * attention), so gating here covers all of them at once rather than relying on
 * each to remember.
 *
 * A conversation in an account the caller cannot reach answers 404, not 403:
 * distinguishing them would let an agent enumerate which conversation ids exist
 * in other accounts.
 */
export async function requireConversationAccess(env, user, conversationId) {
  const conversation = unwrap(
    await getDb(env)
      .from('wp_chat_conversations')
      .select('id, account_id, customer_number, business_number, customer_name, assigned_user_id, avatar_path, avatar_error, is_group, group_jid, member_count')
      .eq('id', conversationId)
      .maybeSingle()
  )

  if (!conversation) return { response: notFound() }

  // account_id is NOT NULL after migration 018, but a row written by an older
  // build mid-deploy could still be null. Treating null as "the default
  // account" would be a guess about access, so such a row is simply not
  // reachable — it fails closed rather than open.
  const allowed = await accessibleAccountIds(env, user)
  if (!allowed.includes(Number(conversation.account_id))) {
    return { response: notFound() }
  }

  return { conversation }
}

function unauth() {
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

function notFound() {
  return new Response(JSON.stringify({ ok: false, error: 'Conversation not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}
