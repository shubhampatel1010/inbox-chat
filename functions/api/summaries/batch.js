import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { accessibleAccountIds } from '../../_lib/accounts.js'

// Bulk read of already-generated short summaries, for warming the client cache
// after the conversation list loads.
//
// READ-ONLY BY DESIGN. Unlike /api/conversation/summary this never calls
// decideRefresh and never generates: it returns what is already stored, or
// nothing for that id. A cold Worker doing 30 sequential generations would be
// exactly the stall this endpoint exists to remove.
//
// One auth check and one `in` query, versus the per-conversation endpoint's
// four sequential round trips.

// Caps the id list. Also bounds the PostgREST `in` filter, which travels in the
// query string and would eventually hit a URL-length limit.
const MAX_IDS = 30

// big_summary is deliberately absent — it is the EOD memory, runs to thousands
// of characters, and no client surface shows it.
const BATCH_COLUMNS =
  'conversation_id, short_summary, department, attention_required, attention_level, attention_reason, generated_at, model'

/** Parse `?ids=1,2,3` into unique positive integers, or null when unusable. */
function readIds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null

  const seen = new Set()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const n = Number(trimmed)
    // One bad id fails the whole request rather than being silently dropped —
    // a caller sending junk should learn that, not get a short result set.
    if (!Number.isInteger(n) || n <= 0) return null
    seen.add(n)
  }

  return seen.size ? [...seen] : null
}

/**
 * GET /api/summaries/batch?ids=1,2,3
 *
 * Returns { ok, summaries: { "<id>": { text, department, … } } }, keyed by
 * conversation id as a string. Ids with no stored summary, or whose summary has
 * no short text yet, are simply absent from the map — the client treats a miss
 * as "not cached" and falls back to the per-conversation endpoint.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const ids = readIds(url.searchParams.get('ids'))

  if (!ids) return badRequest('ids is required, as a comma-separated list of conversation ids')
  if (ids.length > MAX_IDS) return badRequest(`No more than ${MAX_IDS} ids per request`)

  try {
    const db = getDb(env)

    // ACCOUNT FILTER. Assignment is not a permission boundary — every user on an
    // account may read every summary on it — but the ACCOUNT is, so the ids are
    // narrowed to conversations the caller can actually reach before any summary
    // is read. Without this an agent could pass another account's conversation
    // ids and receive its AI summaries, which quote the customer's messages.
    //
    // One extra round trip, not N: the ids are already capped at MAX_IDS, so
    // this is a single bounded `in` query regardless of how many were asked for.
    const allowed = await accessibleAccountIds(env, auth.user)
    if (!allowed.length) return json({ ok: true, summaries: {} })

    const visible =
      unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id')
          .in('id', ids)
          .in('account_id', allowed)
      ) || []

    const visibleIds = visible.map((c) => Number(c.id))
    // Every requested id was out of reach (or does not exist) — an empty map is
    // the same answer the client already handles as "not cached".
    if (!visibleIds.length) return json({ ok: true, summaries: {} })

    const rows =
      unwrap(
        await db.from('wp_chat_summaries').select(BATCH_COLUMNS).in('conversation_id', visibleIds)
      ) || []

    const summaries = {}
    for (const row of rows) {
      // Mirrors toClient() in the per-conversation endpoint: a row with no
      // usable short text is not a summary, so it is omitted rather than
      // returned as an empty one the client would have to special-case.
      if (!row.short_summary || !row.short_summary.trim()) continue

      summaries[String(row.conversation_id)] = {
        text: row.short_summary,
        department: row.department || null,
        attention_required: !!row.attention_required,
        attention_level: row.attention_level || null,
        attention_reason: row.attention_reason || null,
        generated_at: row.generated_at || null,
        model: row.model || null,
      }
    }

    return json({ ok: true, summaries })
  } catch (err) {
    return serverError(err?.message || 'Failed to load summaries')
  }
}
