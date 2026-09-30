import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, forbidden, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { validateReason, checkNoResponseWindow } from '../../_lib/attention-reasons.js'
import { recordAttentionEvent, lastInboundAt } from '../../_lib/attention-audit.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Attention levels only an admin may clear.
 *
 * Severity decides who can close, not the reason chosen — gating per reason
 * would be sidestepped by picking a softer one for the same chat. 'team' and
 * 'general' stay a one-tap-plus-reason action for any agent, because a closure
 * flow heavy enough to slow down routine work is a flow staff route around, and
 * an audit trail people evade is worse than none: it reads as complete when it
 * is not.
 */
const ADMIN_ONLY_LEVELS = new Set(['management'])

/**
 * POST /api/conversation/dismiss-attention
 *   { conversation_id, reason_category, reason_note }
 *
 * Clears the attention flag on one conversation — for when an agent resolved
 * the issue off-channel and the AI, never having seen it resolved, keeps the
 * row flagged.
 *
 * A REASON IS MANDATORY. It was not before: the flag could be cleared with a
 * single unexplained tap, leaving dismissed_at/dismissed_by to record when and
 * who but never why. That is the accountability hole this endpoint now closes —
 * see sql/019_attention_audit.sql for the full reasoning.
 *
 * ORDER MATTERS. The audit row is written BEFORE the flag is mutated, so a
 * failed insert aborts the dismissal rather than clearing a flag whose closure
 * nobody can trace. The reverse order would produce exactly the untraceable
 * closure the feature exists to prevent.
 *
 * Writes to wp_chat_summaries are otherwise unchanged from before: 
 * attention_required flips false and the dismissal is stamped. That stamp is
 * what lets a later regenerate distinguish "already handled" from "a new issue
 * arrived" — summarize.js suppresses re-flagging until a message lands AFTER
 * dismissed_at.
 *
 * The live attention_level / attention_reason MUST be nulled: a CHECK
 * constraint (attention_shape_chk) forbids a non-null level while
 * attention_required is false. So the originals are read first and parked in
 * dismissed_level / dismissed_reason, which restore-attention moves back for
 * the Undo action.
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

  const reason = validateReason(payload)
  if (reason.error) return badRequest(reason.error)

  try {
    // Same access rule as the summary endpoint: 404 if the conversation is
    // absent or out of the caller's accounts.
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    // Read the live values first: they are needed for the audit snapshot, for
    // the severity gate below, and for Undo — and the update must null them to
    // satisfy attention_shape_chk.
    const current = unwrap(
      await db
        .from('wp_chat_summaries')
        .select('attention_required, attention_level, attention_reason')
        .eq('conversation_id', conversationId)
        .maybeSingle()
    )

    // A conversation with no summary row, or one already cleared, has nothing
    // flagged. Report ok and write NO audit row: logging a closure that closed
    // nothing would pad the trail with events a manager then has to discount.
    if (!current?.attention_required) {
      return json({ ok: true, conversation_id: conversationId, dismissed: false })
    }

    if (ADMIN_ONLY_LEVELS.has(current.attention_level) && auth.user.role !== 'admin') {
      return forbidden(
        'This flag is marked for management attention — only an admin can close it. ' +
          'Escalate it instead, or ask an admin to review.'
      )
    }

    // The "no response" window. Measured from the newest INBOUND message, so an
    // agent cannot restart the silence clock with their own reply.
    const gate = checkNoResponseWindow(
      reason.category.id,
      await lastInboundAt(env, conversationId)
    )
    if (!gate.ok) return badRequest(gate.error)

    // Audit BEFORE mutating — a throw here leaves the flag standing.
    await recordAttentionEvent(env, {
      conversationId,
      accountId: access.conversation?.account_id ?? null,
      action: 'dismissed',
      reasonCategory: reason.category.id,
      reasonNote: reason.note,
      levelAtTime: current.attention_level ?? null,
      reasonAtTime: current.attention_reason ?? null,
      actor: auth.user,
    })

    const now = new Date().toISOString()
    unwrap(
      await db
        .from('wp_chat_summaries')
        .update({
          attention_required: false,
          attention_level: null,
          attention_reason: null,
          dismissed_at: now,
          dismissed_by: auth.user.id,
          dismissed_level: current.attention_level ?? null,
          dismissed_reason: current.attention_reason ?? null,
          updated_at: now,
        })
        .eq('conversation_id', conversationId)
    )

    return json({ ok: true, conversation_id: conversationId, dismissed: true })
  } catch (err) {
    return serverError(err?.message || 'Failed to dismiss attention')
  }
}
