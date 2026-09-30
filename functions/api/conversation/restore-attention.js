import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { recordAttentionEvent } from '../../_lib/attention-audit.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * POST /api/conversation/restore-attention  { conversation_id }
 *
 * The Undo of a manual dismissal. dismiss-attention parked the original level
 * and reason in dismissed_level / dismissed_reason (the live columns had to be
 * nulled for attention_shape_chk). Restoring moves them back, re-raises
 * attention_required, and clears the dismissal state.
 *
 * If there is nothing parked (never dismissed, or already restored) this is a
 * no-op — importantly, it must NOT re-raise attention_required with a null
 * level, which the same CHECK constraint would reject.
 *
 * A 'restored' row is appended to the audit trail. Without it an accidental
 * dismiss-then-undo would leave a lone 'dismissed' event that a manager reads
 * as a closure which never happened; the pair together tell the truth. No
 * reason is required — undoing a closure creates no accountability gap, and
 * demanding prose for it would just push agents to leave bad closures standing.
 *
 * Any signed-in user may undo, INCLUDING re-raising a 'management' flag that
 * only an admin could have cleared: restoring is the safe direction, and
 * blocking it would leave an agent who mis-closed something unable to correct
 * it themselves.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  let payload
  try {
    payload = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const conversationId = positiveInt(payload?.conversation_id)
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    const parked = unwrap(
      await db
        .from('wp_chat_summaries')
        .select('dismissed_level, dismissed_reason')
        .eq('conversation_id', conversationId)
        .maybeSingle()
    )

    // Nothing to undo (never dismissed, or already restored). Re-raising with a
    // null level would violate attention_shape_chk, so bail out cleanly.
    if (!parked || parked.dismissed_level == null) {
      return json({ ok: true, conversation_id: conversationId, restored: false })
    }

    // Audit before mutating, as in dismiss — the level being restored is
    // snapshot from the parked columns, which the update below clears.
    await recordAttentionEvent(env, {
      conversationId,
      accountId: access.conversation?.account_id ?? null,
      action: 'restored',
      levelAtTime: parked.dismissed_level,
      reasonAtTime: parked.dismissed_reason ?? null,
      actor: auth.user,
    })

    unwrap(
      await db
        .from('wp_chat_summaries')
        .update({
          attention_required: true,
          attention_level: parked.dismissed_level,
          attention_reason: parked.dismissed_reason ?? null,
          dismissed_at: null,
          dismissed_by: null,
          dismissed_level: null,
          dismissed_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('conversation_id', conversationId)
    )

    return json({ ok: true, conversation_id: conversationId, restored: true })
  } catch (err) {
    return serverError(err?.message || 'Failed to restore attention')
  }
}
