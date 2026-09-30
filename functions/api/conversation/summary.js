import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { decideRefresh } from '../../_lib/ai.js'
import { refreshConversationSummary } from '../../_lib/summarize.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Shape a stored row for the client, or null when there is no summary yet. The
 * panel shows the SHORT summary; the big summary is the memory (EOD report) and
 * is not sent to the panel.
 */
function toClient(row, extra = {}) {
  const summary =
    row && row.short_summary && row.short_summary.trim()
      ? {
          text: row.short_summary,
          department: row.department || null,
          attention_required: !!row.attention_required,
          attention_level: row.attention_level || null,
          attention_reason: row.attention_reason || null,
          generated_at: row.generated_at || null,
          model: row.model || null,
        }
      : null
  return json({ ok: true, summary, ...extra })
}

/**
 * GET /api/conversation/summary?conversation_id=N
 *
 * NEVER awaits the model. The request path is two tiny indexed reads plus the
 * pure decideRefresh() classification; when a refresh is due the model call is
 * handed to ctx.waitUntil() so it runs AFTER the response is flushed. The client
 * gets the stored (possibly stale) row immediately with `generating: true` and
 * polls back for the fresh text.
 *
 * This is the whole fix for the ~14s open: the browser used to hold the
 * connection open for the entire OpenRouter generation, and opening the inbox
 * fires several of these at once. Access rules are unchanged.
 */
export async function onRequestGet({ request, env, waitUntil }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    // Respects the existing access rules (agents see all; 404 if absent).
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    // One client, shared with the background refresh below so the deferred work
    // reuses this isolate's warm connection instead of building a second one.
    const db = getDb(env)

    // --- the two fast reads (milliseconds, both index-backed) -------------
    const summaryRow = unwrap(
      await db.from('wp_chat_summaries').select('*').eq('conversation_id', conversationId).maybeSingle()
    )
    const latestRows =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .order('id', { ascending: false })
          .limit(1)
      ) || []
    const latestMessageId = latestRows.length ? latestRows[0].id : null

    // --- classify without touching the model ------------------------------
    const decision = decideRefresh({
      summaryRow,
      latestMessageId,
      hasMessages: latestMessageId != null,
      now: Date.now(),
    })

    if (decision.action === 'empty') return toClient(null, { empty: true })
    if (decision.action === 'cached') return toClient(summaryRow)

    // --- generate ---------------------------------------------------------
    // THE REQUEST NEVER WAITS FOR THE MODEL. Not for a refresh, and not for a
    // first generation either.
    //
    // Summaries are produced in the background by the inbound webhook, which
    // already calls refreshConversationSummary() on every new message. This
    // endpoint is therefore a READER: it shows what has been produced so far.
    //
    // A conversation with no summary yet reports `empty`, and the panel says
    // "No summary yet" instead of spinning — the next message on that
    // conversation will generate one via the webhook. Blocking here is what
    // made a first open cost the full model latency.
    const hasText = !!(summaryRow && summaryRow.short_summary && summaryRow.short_summary.trim())

    // Kick the refresh off regardless, so an open still nudges a stale or
    // never-generated summary along — it just never delays the response.
    // Wrapped so a failure can never reject into the request.
    const deferred = refreshConversationSummary(
      env,
      conversationId,
      !!access.conversation.is_group,
      db
    ).catch(() => {})

    if (typeof waitUntil === 'function') waitUntil(deferred)

    // Stored text: show it now, flagged so the client polls for the newer
    // wording. No text yet: report empty rather than a spinner the user would
    // sit in front of.
    return hasText ? toClient(summaryRow, { generating: true }) : toClient(null, { empty: true })
  } catch (err) {
    return serverError(err?.message || 'Failed to load summary')
  }
}
