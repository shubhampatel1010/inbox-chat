import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'
import { clearAutoHalt } from '../../_lib/channel-gap.js'
import { resolveAccountAccess, envForAccount } from '../../_lib/accounts.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const validDate = (s) => DATE_RE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/**
 * POST /api/sync/start  (admin)
 *
 * Body — one of:
 *   { "type": "conversation", "conversation_id": 42 }
 *   { "type": "range", "from": "2026-04-01", "to": "2026-07-01", "account_id": 3 }
 *
 * Creates a sync job and returns it. Does no Whapi work — the client then
 * drives /api/sync/step until the job reports done.
 *
 * The job is stamped with an account, so the step runner knows whose channel to
 * walk. For a conversation sync the account is taken from the conversation
 * itself (it cannot be anything else); for a range sync the admin chooses, and
 * omitting it falls back to their first accessible account.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const type = String(body?.type || '')

  let scope
  // Which account's channel this job walks. Resolved per scope type below.
  let accountId = null

  try {
    if (type === 'conversation') {
      const conversationId = positiveInt(body.conversation_id)
      if (!conversationId) return badRequest('conversation_id is required')

      const db = getDb(env)
      const conversation = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, account_id, customer_number, is_group, group_jid, customer_name')
          .eq('id', conversationId)
          .maybeSingle()
      )
      if (!conversation) return notFound('Conversation not found')

      // The conversation's account IS the job's account — but it must be one
      // the caller can reach. Without this an admin could start a sync on a
      // DEACTIVATED account's conversation: the job would be created, and
      // /api/sync/step would then refuse to run it (its own account check),
      // leaving a job stuck 'pending' forever. Failing here says so instead.
      const access = await resolveAccountAccess(env, auth.user, conversation.account_id)
      if (access.response) return access.response
      accountId = access.accountId

      // Whapi chat id: the group JID as-is, or <number>@s.whatsapp.net for 1:1.
      const chatId = conversation.is_group
        ? conversation.group_jid
        : `${conversation.customer_number}@s.whatsapp.net`

      if (!chatId || (!conversation.is_group && !conversation.customer_number)) {
        return badRequest('This conversation cannot be synced (no chat id)')
      }

      scope = {
        type: 'conversation',
        conversation_id: conversationId,
        chat_id: chatId,
        name: conversation.customer_name || null,
      }
    } else if (type === 'range') {
      if (!validDate(body.from) || !validDate(body.to)) {
        return badRequest('from and to must be YYYY-MM-DD dates')
      }
      if (body.from > body.to) return badRequest('from must be on or before to')
      scope = { type: 'range', from: body.from, to: body.to }

      const access = await resolveAccountAccess(env, auth.user, body.account_id)
      if (access.response) return access.response
      accountId = access.accountId
    } else {
      return badRequest('type must be "conversation" or "range"')
    }

    const db = getDb(env)
    const job = unwrap(
      await db
        .from('wp_chat_sync_jobs')
        .insert({
          status: 'pending',
          account_id: accountId,
          scope,
          cursor: {},
          created_by: auth.user.id,
        })
        .select('*')
        .single()
    )

    // Starting a manual sync IS the admin intervention that a halted
    // auto-recovery was waiting for — clear the halt so auto resumes afterward.
    // Scoped, so it clears only the halt on the account being synced.
    await clearAutoHalt(await envForAccount(env, accountId))

    return json({ ok: true, job })
  } catch (err) {
    return serverError(err.message || 'Failed to start sync')
  }
}
