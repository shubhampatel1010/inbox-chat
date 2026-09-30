import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { beforeCursor } from '../../_lib/search.js'
import { extractUrls } from '../../_lib/links.js'

// One tab, one page. Every tab is keyset-paginated newest-first on the same
// (created_at, id) tuple the thread and search already use.
const PAGE_SIZE = 30
const MAX_PAGE_SIZE = 60

// The Links tab over-fetches, because the ILIKE pre-filter catches messages
// that mention "http" without a real URL (e.g. "http status codes"). Those are
// dropped after extraction, so ask for extra to fill a page.
const LINK_SCAN_MULTIPLE = 3

const TABS = new Set(['media', 'docs', 'links'])

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * GET /api/conversation/media?conversation_id=N&tab=media|docs|links&cursor_at=&cursor_id=
 *
 * Shared media for the contact panel, one tab at a time:
 *   media — images + videos with a stored object, newest first
 *   docs  — documents, newest first
 *   links — messages whose body carries a URL, extracted at query time
 *
 * Authorised by requireConversationAccess, which post-Part-1 admits any signed
 * in user to any existing conversation (404 only for a missing one).
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  const tab = String(url.searchParams.get('tab') || 'media')
  if (!TABS.has(tab)) return badRequest('tab must be media, docs or links')

  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_PAGE_SIZE)
    : PAGE_SIZE

  const cursorAt = url.searchParams.get('cursor_at')
  const rawCursorId = url.searchParams.get('cursor_id')
  const cursorId = rawCursorId === null ? null : Number(rawCursorId)
  const hasCursor = cursorAt !== null && cursorId !== null && Number.isInteger(cursorId)
  if (!hasCursor && (cursorAt !== null || rawCursorId !== null)) {
    return badRequest('cursor_at and cursor_id must be supplied together')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    const applyCommon = (builder, fetch) =>
      (hasCursor
        ? builder.or(beforeCursor({ created_at: cursorAt, id: cursorId }))
        : builder
      )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(fetch)

    if (tab === 'links') {
      return await linksPage(db, conversationId, limit, applyCommon)
    }
    return await mediaPage(db, conversationId, tab, limit, applyCommon)
  } catch (err) {
    return serverError(err.message || 'Failed to load shared media')
  }
}

const MEDIA_FIELDS =
  'id, created_at, direction, media_path, media_type, media_mime, media_filename, media_size, media_caption, sender_name'

async function mediaPage(db, conversationId, tab, limit, applyCommon) {
  // media tab = image + video; docs tab = document. Audio is deliberately in
  // neither — voice notes are not "shared media" a user browses for.
  const types = tab === 'media' ? ['image', 'video'] : ['document']

  let builder = db
    .from('wp_chat_messages')
    .select(MEDIA_FIELDS)
    .eq('conversation_id', conversationId)
    .in('media_type', types)
    // Only successfully-stored objects — an errored ingest has no bytes to show
    // or download, and would render as a broken tile.
    .eq('media_error', false)
    .not('media_path', 'is', null)

  const rows = unwrap(await applyCommon(builder, limit + 1)) || []
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  const items = page.map((m) => ({
    message_id: m.id,
    created_at: m.created_at,
    direction: m.direction,
    media_path: m.media_path,
    media_type: m.media_type,
    media_mime: m.media_mime,
    media_filename: m.media_filename,
    media_size: m.media_size,
    media_caption: m.media_caption,
    sender_name: m.sender_name || null,
  }))

  return pageResponse(tab, items, hasMore, page)
}

const LINK_FIELDS = 'id, created_at, direction, body, sender_name'

async function linksPage(db, conversationId, limit, applyCommon) {
  // Keep scanning forward until the page is full or the source is exhausted:
  // the ILIKE pre-filter is coarse, so a batch can be mostly false positives.
  const items = []
  let cursor = null
  let exhausted = false
  let lastScanned = null

  // Bounded loop — at most a few passes; the LINK_SCAN_MULTIPLE over-fetch
  // means one pass usually suffices.
  for (let pass = 0; pass < 4 && items.length <= limit && !exhausted; pass++) {
    let builder = db
      .from('wp_chat_messages')
      .select(LINK_FIELDS)
      .eq('conversation_id', conversationId)
      .ilike('body', '%http%')

    if (cursor) builder = builder.or(beforeCursor(cursor))

    const fetch = (limit + 1) * LINK_SCAN_MULTIPLE
    const rows =
      unwrap(
        await builder
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(fetch)
      ) || []

    if (!rows.length) {
      exhausted = true
      break
    }

    for (const m of rows) {
      lastScanned = m
      const urls = extractUrls(m.body)
      if (!urls.length) continue
      items.push({
        message_id: m.id,
        created_at: m.created_at,
        direction: m.direction,
        text: m.body,
        urls,
        sender_name: m.sender_name || null,
      })
    }

    if (rows.length < fetch) exhausted = true
    else cursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id }
  }

  const hasMore = items.length > limit || (!exhausted && items.length >= limit)
  const page = items.slice(0, limit)

  // The links cursor advances by the last MESSAGE actually returned, so the
  // next request resumes just before it — never re-scanning a delivered row.
  const cursorSource = page.length
    ? { created_at: page[page.length - 1].created_at, id: page[page.length - 1].message_id }
    : lastScanned && { created_at: lastScanned.created_at, id: lastScanned.id }

  return json({
    ok: true,
    tab: 'links',
    items: page,
    has_more: hasMore,
    next_cursor: hasMore && cursorSource ? { at: cursorSource.created_at, id: cursorSource.id } : null,
  })
}

function pageResponse(tab, items, hasMore, page) {
  const last = page[page.length - 1]
  return json({
    ok: true,
    tab,
    items,
    has_more: hasMore,
    next_cursor: hasMore && last ? { at: last.created_at, id: last.id } : null,
  })
}
