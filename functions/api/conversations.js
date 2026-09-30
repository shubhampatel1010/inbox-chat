import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { accessibleAccountIds, accessibleAccounts } from '../_lib/accounts.js'
import { json, serverError } from '../_lib/respond.js'

const COLUMNS = `
  id, account_id, customer_number, business_number, customer_name,
  contact_type, country_of_origin,
  last_message_body, last_message_at, last_direction,
  unread_count, status, assigned_user_id, assigned_to,
  avatar_path, avatar_error,
  is_group, group_jid, member_count,
  created_at, updated_at
`

/**
 * GET /api/conversations[?account_id=N]
 *
 * Without account_id: every conversation across ALL accounts the caller can
 * reach, each tagged with its account. This is the "All accounts" inbox view,
 * and it is the default so a single-account user's experience is byte-for-byte
 * what it was before multi-account existed.
 *
 * With account_id: narrowed to that one account, after checking access.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    const db = getDb(env)
    const url = new URL(request.url)
    const requested = url.searchParams.get('account_id')

    // THE account boundary for the inbox. An agent sees only the accounts they
    // are assigned to; an admin sees all active ones.
    const allowed = await accessibleAccountIds(env, auth.user)
    if (!allowed.length) return json({ ok: true, conversations: [], accounts: [] })

    let scope = allowed
    if (requested) {
      const id = Number(requested)
      // An id outside `allowed` yields an empty list rather than a 403 — the
      // client may simply be holding a stale selection after its access changed,
      // and erroring there would wedge the inbox.
      if (!Number.isInteger(id) || !allowed.includes(id)) {
        return json({ ok: true, conversations: [], accounts: await accessibleAccounts(env, auth.user) })
      }
      scope = [id]
    }

    // Within an account, no role scoping: every user on the account sees every
    // conversation on it. Assignment is a label, not a filter — the
    // Assigned/Unassigned chips do the narrowing client-side.
    const builder = db
      .from('wp_chat_conversations')
      .select(COLUMNS)
      .in('account_id', scope)
      // DESC NULLS LAST
      .order('last_message_at', { ascending: false, nullsFirst: false })

    const conversations = unwrap(await builder) || []

    // Resolve assignee names in one extra round trip rather than an embedded
    // select, so this doesn't depend on PostgREST inferring the FK relationship.
    const assigneeIds = [
      ...new Set(conversations.map((c) => c.assigned_user_id).filter((id) => id != null)),
    ]

    let names = new Map()
    if (assigneeIds.length) {
      const users =
        unwrap(
          await db.from('wp_chat_users').select('id, name').in('id', assigneeIds)
        ) || []
      names = new Map(users.map((u) => [String(u.id), u.name]))
    }

    // Attention level for the row colour-coding. Joined in a second round trip
    // for the same reason as the assignee names — no reliance on PostgREST
    // inferring the FK. Only flagged rows are fetched (that is exactly what the
    // partial index on wp_chat_summaries covers), so this stays small however
    // many conversations exist, and every other row simply gets null.
    //
    // Restricted to the ids being returned. Without that it read every flagged
    // summary in the DEPLOYMENT — harmless (the id-join below discards the
    // rest) but it would grow with the total number of tenants, on an endpoint
    // the inbox polls every 5 seconds.
    const conversationIds = conversations.map((c) => c.id)
    const attentionRows = conversationIds.length
      ? unwrap(
          await db
            .from('wp_chat_summaries')
            .select('conversation_id, attention_level')
            .eq('attention_required', true)
            .in('conversation_id', conversationIds)
        ) || []
      : []

    const attention = new Map(
      attentionRows
        .filter((r) => r.attention_level)
        .map((r) => [String(r.conversation_id), r.attention_level])
    )

    // The accounts the caller can reach, returned alongside so the client can
    // render the switcher and the per-row account badge from ONE request — the
    // inbox polls this every 5s, and a second round trip per poll just to label
    // rows would be wasteful.
    const accounts = await accessibleAccounts(env, auth.user)
    const accountNames = new Map(accounts.map((a) => [String(a.id), a.name]))

    return json({
      ok: true,
      accounts,
      conversations: conversations.map((c) => ({
        ...c,
        // Prefer the live name, fall back to the denormalized copy.
        assigned_to: names.get(String(c.assigned_user_id)) ?? c.assigned_to ?? null,
        // 'team' | 'management' | 'general', null when not flagged.
        attention_level: attention.get(String(c.id)) ?? null,
        // Which account this chat belongs to — what the list badges and the
        // thread header show, so two accounts' chats are never confused.
        account_name: accountNames.get(String(c.account_id)) ?? null,
      })),
    })
  } catch (err) {
    return serverError(err.message || 'Failed to load conversations')
  }
}
