import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { syncGroup } from '../../_lib/group.js'
import { envForConversation } from '../../_lib/accounts.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

const MEMBER_COLUMNS = 'id, member_number, member_name, is_admin, synced_at'

/**
 * GET /api/groups/members?conversation_id=N
 * The stored snapshot. Same role rule as any other conversation read.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const conversationId = Number(new URL(request.url).searchParams.get('conversation_id'))
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    if (!access.conversation.is_group) return badRequest('That conversation is not a group')

    const members = await readMembers(env, conversationId)
    return json({ ok: true, members, synced_at: members[0]?.synced_at ?? null })
  } catch (err) {
    return serverError(err.message || 'Could not load members')
  }
}

/**
 * POST /api/groups/members — body {conversation_id}
 *
 * Re-fetches from Whapi. Unlike the creation-time sync this is NOT
 * fire-and-forget: the user pressed refresh and is waiting for the result.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { conversation_id } = await readJson(request)
  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const conversation = access.conversation
    if (!conversation.is_group || !conversation.group_jid) {
      return badRequest('That conversation is not a group')
    }

    // Group info/icon come from Whapi, so this runs on the conversation's own
    // account credentials.
    const accountEnv = await envForConversation(env, conversation)
    const sync = await syncGroup(accountEnv, conversationId, conversation.group_jid)
    const members = await readMembers(env, conversationId)

    // A failed refresh still returns the previous snapshot — stale data beats
    // an empty list.
    return json({
      ok: true,
      members,
      synced_at: members[0]?.synced_at ?? null,
      refreshed: sync.members > 0,
      warning: sync.errors.length ? 'Could not reach WhatsApp; showing the last snapshot.' : null,
    })
  } catch (err) {
    return serverError(err.message || 'Could not refresh members')
  }
}

async function readMembers(env, conversationId) {
  const rows =
    unwrap(
      await getDb(env)
        .from('wp_chat_group_members')
        .select(MEMBER_COLUMNS)
        .eq('conversation_id', conversationId)
    ) || []

  // Admins first, then by name — PostgREST cannot order by lower(name).
  return rows.sort((a, b) => {
    if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1
    const an = String(a.member_name || a.member_number || '')
    const bn = String(b.member_name || b.member_number || '')
    return an.localeCompare(bn, undefined, { sensitivity: 'base' })
  })
}
