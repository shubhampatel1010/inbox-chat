import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { MESSAGE_COLUMNS } from '../_lib/storage.js'
import { json, badRequest, notFound, serverError } from '../_lib/respond.js'
import { beforeCursor, afterCursor } from '../_lib/search.js'
import { attachQuoted } from '../_lib/reply.js'

/**
 * Messages per request.
 *
 * Before windowing existed this endpoint returned a conversation's ENTIRE
 * history, unbounded, on every 4-second poll. 60 is chosen to be larger than
 * any first screenful at any supported width, so the default open still shows
 * a full thread and bottom-anchors exactly as it did.
 */
const PAGE_SIZE = 60

/** An anchored window is split evenly, so a hit lands mid-screen, not at an edge. */
const HALF_WINDOW = 30

const positiveInt = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * GET /api/messages?conversation_id=N
 *
 * Four modes, mutually exclusive:
 *   (none)      newest PAGE_SIZE       — unchanged behaviour on open
 *   anchor_id   window around a message — search result selection
 *   before_id   PAGE_SIZE older        — scrolling up
 *   after_id    PAGE_SIZE newer        — scrolling down
 *
 * Always returns messages oldest-first, plus has_more_before / has_more_after
 * so the client knows which directions are still loadable. has_more_after
 * being false is what tells the client it is at the live edge and may resume
 * normal bottom-anchored polling.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  const anchorId = positiveInt(url.searchParams.get('anchor_id'))
  const beforeId = positiveInt(url.searchParams.get('before_id'))
  const afterId = positiveInt(url.searchParams.get('after_id'))

  if ([anchorId, beforeId, afterId].filter(Boolean).length > 1) {
    return badRequest('anchor_id, before_id and after_id are mutually exclusive')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    /** One page in one direction. Fetches limit+1 to detect "more" without a count. */
    const page = async ({ cursor, direction, limit }) => {
      let builder = db
        .from('wp_chat_messages')
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: direction === 'after' })
        .order('id', { ascending: direction === 'after' })
        .limit(limit + 1)

      if (cursor) builder = builder.or(cursor)

      const rows = unwrap(await builder) || []
      const more = rows.length > limit
      const kept = more ? rows.slice(0, limit) : rows

      // Descending queries come back newest-first; the client always wants
      // oldest-first so it can render straight into the existing list.
      return { rows: direction === 'after' ? kept : kept.reverse(), more }
    }

    let messages = []
    let hasMoreBefore = false
    let hasMoreAfter = false

    if (anchorId) {
      // The anchor's position, not just its id — the tuple is what both
      // cursors are expressed against.
      const anchor = unwrap(
        await db
          .from('wp_chat_messages')
          .select('id, created_at, conversation_id')
          .eq('id', anchorId)
          .eq('conversation_id', conversationId)
          .maybeSingle()
      )

      // Scoped by conversation_id above, so a valid id in someone else's
      // thread is a 404 here and never confirms the message exists.
      if (!anchor) return notFound('That message is no longer available')

      const [older, newer] = await Promise.all([
        // Inclusive: the anchor itself belongs to the older half.
        page({ cursor: beforeCursor(anchor, true), direction: 'before', limit: HALF_WINDOW }),
        page({ cursor: afterCursor(anchor), direction: 'after', limit: HALF_WINDOW }),
      ])

      messages = [...older.rows, ...newer.rows]
      hasMoreBefore = older.more
      hasMoreAfter = newer.more
    } else if (beforeId || afterId) {
      const edgeId = beforeId || afterId
      const edge = unwrap(
        await db
          .from('wp_chat_messages')
          .select('id, created_at')
          .eq('id', edgeId)
          .eq('conversation_id', conversationId)
          .maybeSingle()
      )
      if (!edge) return notFound('That message is no longer available')

      if (beforeId) {
        const older = await page({
          cursor: beforeCursor(edge),
          direction: 'before',
          limit: PAGE_SIZE,
        })
        messages = older.rows
        hasMoreBefore = older.more
        // The caller already holds everything after this point.
        hasMoreAfter = true
      } else {
        const newer = await page({
          cursor: afterCursor(edge),
          direction: 'after',
          limit: PAGE_SIZE,
        })
        messages = newer.rows
        hasMoreAfter = newer.more
        hasMoreBefore = true
      }
    } else {
      // Default: the newest page. Identical on screen to the old unbounded
      // load for any thread under PAGE_SIZE messages, and bottom-anchored
      // either way.
      const tail = await page({ cursor: null, direction: 'before', limit: PAGE_SIZE })
      messages = tail.rows
      hasMoreBefore = tail.more
      hasMoreAfter = false
    }

    // Quoted-reply blocks for whichever slice was fetched. One extra query for
    // the whole page, and only when the page actually contains a reply.
    await attachQuoted(db, messages, access.conversation)

    // Reading a thread marks it read regardless of which slice was fetched —
    // an agent who opened it via a months-old search hit has still seen it.
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({ unread_count: 0, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
    )

    return json({
      ok: true,
      conversation: access.conversation,
      messages,
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    })
  } catch (err) {
    return serverError(err.message || 'Failed to load messages')
  }
}
