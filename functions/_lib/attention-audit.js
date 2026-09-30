import { getDb, unwrap } from './db.js'

/**
 * Appends one row to wp_chat_attention_events.
 *
 * The table is append-only: this INSERTs and nothing in the codebase updates or
 * deletes. That is the whole point — wp_chat_summaries.dismissed_* holds the
 * CURRENT state and is overwritten freely; this holds the HISTORY and is not.
 *
 * Failures are RETHROWN rather than swallowed. A dismissal whose audit row went
 * missing is precisely the untraceable closure this feature exists to prevent,
 * so the caller must write the log BEFORE mutating the flag and let a failure
 * abort the whole action. Losing the audit row is strictly worse than the agent
 * seeing an error and trying again.
 */
export async function recordAttentionEvent(env, event) {
  const db = getDb(env)

  unwrap(
    await db.from('wp_chat_attention_events').insert({
      conversation_id: event.conversationId,
      account_id: event.accountId ?? null,
      action: event.action,
      reason_category: event.reasonCategory ?? null,
      reason_note: event.reasonNote ?? null,
      attention_level_at_time: event.levelAtTime ?? null,
      attention_reason_at_time: event.reasonAtTime ?? null,
      actor_user_id: event.actor?.id ?? null,
      // Snapshot, never joined later — see the migration's note on why a
      // promotion must not rewrite who had what rights at closure time.
      actor_role: event.actor?.role ?? null,
    })
  )
}

/**
 * The newest INBOUND (customer) message timestamp, or null if the customer has
 * never written.
 *
 * Feeds the "no response" time gate. Deliberately inbound-only: measuring from
 * the newest message of any direction would let an agent's own reply restart
 * the silence clock they are being measured against.
 */
export async function lastInboundAt(env, conversationId) {
  const db = getDb(env)

  // Ordered by id, not created_at, matching how summarize.js finds the newest
  // message: ids are monotonic on insert, while created_at is the WhatsApp
  // timestamp and can arrive out of order on a backfill.
  const rows =
    unwrap(
      await db
        .from('wp_chat_messages')
        .select('created_at')
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .order('id', { ascending: false })
        .limit(1)
    ) || []

  return rows.length ? rows[0].created_at : null
}
