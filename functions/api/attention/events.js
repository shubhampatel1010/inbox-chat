import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, forbidden, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { accessibleAccountIds } from '../../_lib/accounts.js'
import { REASON_CATEGORIES } from '../../_lib/attention-reasons.js'

/** Page size. The log is browsed, not exported — see the note on `limit`. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const VALID_CATEGORIES = new Set(REASON_CATEGORIES.map((c) => c.id))
const VALID_ACTIONS = new Set(['dismissed', 'restored', 'auto_raised', 'reopened'])

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * GET /api/attention/events
 *
 * The closure audit log — who cleared which attention flag, when, and why.
 * ADMIN ONLY. This is the management-visibility half of the accountability
 * feature: without a way to read them, the reasons dismiss-attention records
 * are write-only and the audit trail is decorative.
 *
 * Query parameters, all optional:
 *   conversation_id — one chat's history, for the thread-header panel.
 *   account_id      — narrow to one account (must be one the caller can reach).
 *   actor_user_id   — everything one agent closed.
 *   category        — one reason category.
 *   action          — 'dismissed' | 'restored' | …
 *   since / until   — ISO timestamps, inclusive lower / exclusive upper bound.
 *   limit / offset  — paging.
 *
 * WHY ADMIN-ONLY RATHER THAN "EVERYONE SEES THEIR OWN". An agent who can read
 * the log learns exactly which closures get looked at and which do not, which
 * is the one thing that makes the deterrent hollow. The audit trail exists for
 * the manager; the agent already knows what they wrote.
 *
 * ACCOUNT SCOPING still applies on top of the admin check. Admins reach every
 * ACTIVE account (accessibleAccountIds), so a deactivated account's history
 * stops appearing here — consistent with how it disappears everywhere else
 * rather than a special rule for the log.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  // The server is the real gate. The client hides the tab and the header icon
  // from agents, but that is presentation — this is the check that counts.
  if (auth.user.role !== 'admin') {
    return forbidden('Admin access required')
  }

  const url = new URL(request.url)
  const params = url.searchParams

  const limit = Math.min(positiveInt(params.get('limit')) || DEFAULT_LIMIT, MAX_LIMIT)
  const offset = Math.max(0, Number(params.get('offset')) || 0)

  try {
    const db = getDb(env)

    // Every query is bounded by the accounts the caller can reach. An admin of
    // a deployment with no active accounts sees an empty log, not everything.
    const allowedAccounts = await accessibleAccountIds(env, auth.user)
    if (!allowedAccounts.length) {
      return json({ ok: true, events: [], has_more: false })
    }

    let query = db
      .from('wp_chat_attention_events')
      .select('*')
      .in('account_id', allowedAccounts)
      .order('created_at', { ascending: false })
      // One extra row decides has_more without a second COUNT query — the log
      // is paged by a human clicking "load more", so an exact total is not
      // worth an extra round trip per page.
      .range(offset, offset + limit)

    const conversationId = positiveInt(params.get('conversation_id'))
    if (conversationId) query = query.eq('conversation_id', conversationId)

    const accountId = positiveInt(params.get('account_id'))
    if (accountId) {
      // Filtering to an account the caller cannot reach must not silently widen
      // to "all accounts" — answer empty instead.
      if (!allowedAccounts.includes(accountId)) {
        return json({ ok: true, events: [], has_more: false })
      }
      query = query.eq('account_id', accountId)
    }

    const actorUserId = positiveInt(params.get('actor_user_id'))
    if (actorUserId) query = query.eq('actor_user_id', actorUserId)

    const category = params.get('category')
    if (category) {
      if (!VALID_CATEGORIES.has(category)) return badRequest('Unknown reason category')
      query = query.eq('reason_category', category)
    }

    const action = params.get('action')
    if (action) {
      if (!VALID_ACTIONS.has(action)) return badRequest('Unknown action')
      query = query.eq('action', action)
    }

    const since = params.get('since')
    if (since) {
      if (Number.isNaN(new Date(since).getTime())) return badRequest('Invalid "since" date')
      query = query.gte('created_at', since)
    }

    const until = params.get('until')
    if (until) {
      if (Number.isNaN(new Date(until).getTime())) return badRequest('Invalid "until" date')
      query = query.lt('created_at', until)
    }

    const rows = unwrap(await query) || []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return json({
      ok: true,
      events: await hydrate(db, page),
      has_more: hasMore,
    })
  } catch (err) {
    return serverError(err?.message || 'Failed to load the attention log')
  }
}

/**
 * Attaches the actor's name and the conversation's customer to each row.
 *
 * Two extra lookups rather than a PostgREST embed: wp_chat_attention_events has
 * no foreign keys (deliberately — an audit row must outlive the user and the
 * conversation it names), and without an FK PostgREST cannot infer the
 * relationship to embed across it. This is the same shape conversations.js uses
 * for assigned_to, for the same reason.
 *
 * Both are best-effort. A deleted user or conversation leaves the id in place
 * and the label null: the log must still render the event, because an event
 * whose actor has since left is exactly the one a manager needs to see.
 *
 * actor_role is NOT re-read from wp_chat_users here — the row's own snapshot is
 * authoritative, since it records the role held AT CLOSURE TIME.
 */
async function hydrate(db, rows) {
  if (!rows.length) return []

  const userIds = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))]
  const conversationIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))]

  const [users, conversations] = await Promise.all([
    userIds.length
      ? unwrap(await db.from('wp_chat_users').select('id, name, email').in('id', userIds))
      : [],
    conversationIds.length
      ? unwrap(
          await db
            .from('wp_chat_conversations')
            .select('id, customer_name, customer_number, is_group')
            .in('id', conversationIds)
        )
      : [],
  ])

  const userById = new Map((users || []).map((u) => [String(u.id), u]))
  const convById = new Map((conversations || []).map((c) => [String(c.id), c]))

  return rows.map((row) => {
    const actor = userById.get(String(row.actor_user_id))
    const conversation = convById.get(String(row.conversation_id))
    return {
      ...row,
      actor_name: actor?.name ?? null,
      actor_email: actor?.email ?? null,
      customer_name: conversation?.customer_name ?? null,
      customer_number: conversation?.customer_number ?? null,
      is_group: conversation?.is_group ?? false,
    }
  })
}
