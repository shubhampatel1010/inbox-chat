import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { json, badRequest, serverError } from '../_lib/respond.js'
import { accessibleAccountIds } from '../_lib/accounts.js'
import {
  SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_SCOPED_MAX_PAGE_SIZE,
  likePattern,
  normalizeQuery,
  beforeCursor,
  afterCursor,
  buildSnippet,
} from '../_lib/search.js'

const MESSAGE_FIELDS =
  'id, conversation_id, direction, body, media_caption, media_type, sender_name, sender_number, created_at'

const CONVERSATION_FIELDS =
  'id, account_id, customer_name, customer_number, is_group, avatar_path, avatar_error'

// Above this many conversations, the account filter stops being an id list (see
// the note where it is built) and is applied after the fetch instead.
const CONVERSATION_ID_FILTER_CAP = 900

/**
 * GET /api/search?q=...&conversation_id=N&limit=25&cursor_at=...&cursor_id=...
 *
 * Message-body search. Global by default, across every conversation the caller
 * may see — which now means every conversation on the accounts they belong to,
 * not every conversation in the system; scoped to one conversation when
 * conversation_id is supplied. An optional account_id narrows it further.
 *
 * Ordering follows the use: global results are newest-first, because recency is
 * the best relevance proxy for an inbox. Scoped results are OLDEST-first, so
 * stepping through them with the in-thread chevrons walks the conversation in
 * reading order.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const query = normalizeQuery(url.searchParams.get('q'))

  const rawConversationId = url.searchParams.get('conversation_id')
  let conversationId = null
  if (rawConversationId !== null) {
    conversationId = Number(rawConversationId)
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return badRequest('conversation_id must be a positive integer')
    }
  }

  const scoped = conversationId !== null

  // Not an error — the field is simply not yet worth querying. Returning an
  // empty page keeps the client from having to special-case a 400 for every
  // first keystroke.
  if (!query) {
    return json({ ok: true, query: '', results: [], has_more: false, next_cursor: null })
  }

  const maxLimit = scoped ? SEARCH_SCOPED_MAX_PAGE_SIZE : SEARCH_MAX_PAGE_SIZE
  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, maxLimit)
    : SEARCH_PAGE_SIZE

  try {
    const db = getDb(env)

    // ---- Scope -------------------------------------------------------
    // Assignment is not a permission boundary, but the ACCOUNT is. A scoped
    // search passes through requireConversationAccess, which enforces it (and
    // 404s an id on an unreachable account). A global search has no conversation
    // to check, so the account boundary is applied here by resolving the
    // caller's conversation ids up front.
    let allowedConversationIds = null
    // Non-null only for a global search; the scoped path is already gated by
    // requireConversationAccess.
    let allowedAccountSet = null

    if (scoped) {
      const access = await requireConversationAccess(env, auth.user, conversationId)
      if (access.response) return access.response
    } else {
      const allowedAccounts = await accessibleAccountIds(env, auth.user)
      if (!allowedAccounts.length) {
        return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
      }

      let accountScope = allowedAccounts
      const requestedAccount = url.searchParams.get('account_id')
      if (requestedAccount) {
        const id = Number(requestedAccount)
        if (!Number.isInteger(id) || !allowedAccounts.includes(id)) {
          return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
        }
        accountScope = [id]
      }

      allowedAccountSet = new Set(accountScope)

      // wp_chat_messages carries no account_id (it is reached through its
      // conversation), so the filter is an explicit id list. Capped: PostgREST
      // limits a plain select to 1000 rows, and an .in() of many thousands of
      // ids would also outgrow the URL. Above the cap the filter is dropped and
      // results are filtered after the fetch instead — correctness is preserved
      // either way, only the efficiency differs.
      const convRows =
        unwrap(
          await db
            .from('wp_chat_conversations')
            .select('id')
            .in('account_id', accountScope)
            .limit(CONVERSATION_ID_FILTER_CAP + 1)
        ) || []

      allowedConversationIds =
        convRows.length > CONVERSATION_ID_FILTER_CAP
          ? null
          : convRows.map((c) => Number(c.id))

      if (allowedConversationIds && !allowedConversationIds.length) {
        return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
      }
    }

    // ---- Page --------------------------------------------------------
    // Ascending for a scoped search, descending for a global one. The cursor
    // below has to follow the same direction or paging walks backwards.
    const ascending = scoped

    let builder = db
      .from('wp_chat_messages')
      .select(MESSAGE_FIELDS)
      .ilike('search_text', likePattern(query))
      .order('created_at', { ascending })
      .order('id', { ascending })
      // One extra row is the has_more probe — cheaper and race-free compared
      // with a second count query.
      .limit(limit + 1)

    if (scoped) builder = builder.eq('conversation_id', conversationId)
    else if (allowedConversationIds) builder = builder.in('conversation_id', allowedConversationIds)

    const cursorAt = url.searchParams.get('cursor_at')
    const rawCursorId = url.searchParams.get('cursor_id')
    // Not Number(rawCursorId): a missing param is null, Number(null) is 0, and
    // 0 is a perfectly good integer — so a half-supplied cursor would silently
    // page from id 0 instead of being rejected.
    const cursorId = rawCursorId === null ? null : Number(rawCursorId)

    if (cursorAt !== null && cursorId !== null && Number.isInteger(cursorId)) {
      const cursor = { created_at: cursorAt, id: cursorId }
      builder = builder.or(ascending ? afterCursor(cursor) : beforeCursor(cursor))
    } else if (cursorAt !== null || rawCursorId !== null) {
      return badRequest('cursor_at and cursor_id must be supplied together')
    }

    const rows = unwrap(await builder) || []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    if (!page.length) {
      return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
    }

    // ---- Decorate ----------------------------------------------------
    // One extra round trip rather than an embedded select, matching
    // /api/conversations — this does not depend on PostgREST inferring the
    // foreign key.
    const conversationIds = [...new Set(page.map((m) => m.conversation_id))]
    const conversations =
      unwrap(
        await db
          .from('wp_chat_conversations')
          .select(CONVERSATION_FIELDS)
          .in('id', conversationIds)
      ) || []

    const byId = new Map(conversations.map((c) => [String(c.id), c]))

    // Backstop for the uncapped path: when the deployment has more conversations
    // than CONVERSATION_ID_FILTER_CAP the .in() filter above was skipped, so the
    // account boundary is enforced here instead, against the conversation rows
    // just fetched. Also covers a message whose conversation vanished mid-query.
    // When the id filter DID apply this is a no-op, so the rule is enforced on
    // every path rather than only the cheap one.
    const visible = allowedAccountSet
      ? page.filter((m) => {
          const conversation = byId.get(String(m.conversation_id))
          return conversation && allowedAccountSet.has(Number(conversation.account_id))
        })
      : page

    const results = visible.map((m) => {
      const conversation = byId.get(String(m.conversation_id)) || null

      // The indexed text is body + caption + sender name. Attribute the hit to
      // whichever of those actually contains it, so a group search on an
      // agent's name shows their message rather than an unhighlighted snippet.
      const bodyText = m.body || m.media_caption || ''
      const hit =
        buildSnippet(bodyText, query) ||
        buildSnippet(m.sender_name, query) || {
          // Reachable when the match straddles the single space this column
          // joins its inputs with. Rare, and a plain snippet is still useful.
          snippet: bodyText.slice(0, 160),
          match_start: -1,
          match_length: 0,
        }

      return {
        message_id: m.id,
        conversation_id: m.conversation_id,
        direction: m.direction,
        created_at: m.created_at,
        media_type: m.media_type || null,

        conversation_name: conversation?.customer_name?.trim() || null,
        conversation_number: conversation?.customer_number || null,
        is_group: Boolean(conversation?.is_group),
        avatar_path: conversation?.avatar_path || null,
        avatar_error: Boolean(conversation?.avatar_error),

        // Only meaningful in a group; 1:1 senders are the contact themselves.
        sender_name: conversation?.is_group ? m.sender_name || null : null,
        sender_number: conversation?.is_group ? m.sender_number || null : null,

        ...hit,
      }
    })

    // Deliberately from `page`, not `visible`: the cursor must track what the
    // QUERY returned, or a page whose rows were all filtered out by the account
    // backstop would rewind the cursor and page forever over the same rows.
    const last = page[page.length - 1]

    return json({
      ok: true,
      query,
      conversation_id: conversationId,
      results,
      has_more: hasMore,
      next_cursor: hasMore ? { at: last.created_at, id: last.id } : null,
    })
  } catch (err) {
    // A missing search_text column is the one failure worth naming, because
    // it means sql/001_message_search.sql has not been run.
    const message = String(err?.message || '')
    if (/search_text/.test(message)) {
      return serverError('Search is not set up yet — run sql/001_message_search.sql')
    }
    return serverError(message || 'Search failed')
  }
}
