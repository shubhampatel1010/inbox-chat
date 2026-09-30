// Missed-message / historical backfill engine.
//
// DESIGN — client-driven cooperative chunking (no cron, no long request).
//
// A long backfill cannot run inside one request: Cloudflare Workers cap
// wall-clock and subrequests, and Pages has no cron to hand it off to. So the
// work is split into bounded STEPS that the admin UI drives:
//
//   POST /api/sync/start  -> creates a job row, returns it
//   POST /api/sync/step   -> does ONE bounded unit, advances the cursor, returns progress
//   (repeat step until done)
//   GET  /api/sync/status -> poll the row (also survives a page reload)
//
// Each step is a fresh short request, so the runtime limits never bind, and
// the cursor lives in the row, so the whole thing is resumable. This same
// machinery serves both a five-minute outage gap and a three-month import —
// the only difference is the scope and how many steps it takes.
//
// HISTORICAL POLICY (differs from live inbound on purpose):
//   * is_read = true            — a backfilled message is NOT unread, so a
//                                 sync never inflates a badge.
//   * last_message_at is bumped ONLY when the synced message is NEWER than the
//     conversation's current last message — an old message never reorders the
//     list or overwrites a fresher preview.
//   * no push — notifyNewMessage is never called from here, so a backfill
//     cannot fire a flood of notifications.
//   * dedup on whapi_message_id (already unique) — an already-present message
//     hits the constraint and is skipped, never written twice.

import { unwrap, UNIQUE_VIOLATION } from './db.js'
import { listMessages, listChats, getMessage, redactPayload } from './whapi.js'
import { resolveQuotedRef } from './reply.js'
import {
  shapeInboundMessage,
  resolveLidChatId,
  ingestAttachment,
  findOrCreateGroup,
  findOrCreateConversation,
  previewLine,
  mediaPreviewLabel,
  messageHasContent,
} from './ingest.js'

// Messages pulled and processed per step. Deliberately small: a step may fetch
// and re-host up to this many media attachments sequentially, and every step
// must finish comfortably inside a Worker's limits. The client just runs more
// steps — throughput is unchanged, latency per request stays low.
const STEP_MESSAGES = 15

// Chats pulled per /chats page during a range sync. Cached in the cursor and
// drained one chat at a time, so /chats is hit once per this many chats.
const CHATS_PAGE = 50

// Diff-based conversation sync tuning.
//   RECONCILE_PAGE          — ids per Whapi page in Phase 1. Large is fine: the
//                             reconcile only reads ids, never downloads media.
//   RECONCILE_PAGES_PER_STEP— cap on Whapi calls per reconcile step, so a huge
//                             chat's id-collection stays inside a Worker's limits
//                             and resumes on the next step.
//   DB_ID_PAGE              — page size when reading a conversation's existing
//                             whapi ids. MUST page: PostgREST caps a plain select
//                             at 1000 rows, so a big chat would otherwise report
//                             thousands of false "missing" ids.
const RECONCILE_PAGE = 200
const RECONCILE_PAGES_PER_STEP = 10
const DB_ID_PAGE = 1000

/** YYYY-MM-DD -> unix seconds at the START of that day (UTC). */
function dayStartUnix(date) {
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
/** YYYY-MM-DD -> unix seconds at the END of that day (UTC), inclusive. */
function dayEndUnix(date) {
  const ms = Date.parse(`${date}T23:59:59Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * The unix-second window a range/auto job covers.
 *   range : whole days from the admin's YYYY-MM-DD dates.
 *   auto  : the precise outage window (already buffered) in from_ts/to_ts, so a
 *           5-minute outage recovers a 5-minute window, not a whole day.
 */
function rangeWindow(scope) {
  if (scope.type === 'auto') {
    return { from: Number(scope.from_ts) || null, to: Number(scope.to_ts) || null }
  }
  return { from: dayStartUnix(scope.from), to: dayEndUnix(scope.to) }
}

/**
 * Whapi's per-message delivery status -> our `status` column.
 *
 * We store only what Whapi reports, mapped onto the small set the app already
 * understands: a failed send stays distinguishable, everything else that made
 * it into Whapi's history was sent. We do not invent a delivery state.
 */
function outboundStatus(msg) {
  const s = String(msg?.status || '').toLowerCase()
  if (s === 'failed' || s === 'error') return 'send_failed'
  return 'sent'
}

/**
 * Who/what sent an outbound message, if Whapi says. Stored in the EXISTING
 * sent_by column (no new column). Whapi does not know our internal agents, so
 * this is the account/device name when present, else null.
 */
function outboundSentBy(msg) {
  const candidate = [msg?.from_name, msg?.source, msg?.device].find(
    (v) => typeof v === 'string' && v.trim()
  )
  return candidate ? candidate.trim().slice(0, 255) : null
}

/**
 * Store one historical message — INBOUND or OUTBOUND. Returns
 *   { added, duplicate, skipped, mediaFailed, error }
 * and never throws for an expired attachment — that degrades to media_error
 * exactly as a live failure does.
 */
export async function persistHistorical(env, db, msg, chatName) {
  // allowOutbound: sync keeps our own sent messages (the live webhook drops
  // them as echoes). This is what was missing — replies never got written.
  const shaped = shapeInboundMessage(msg, env, { allowOutbound: true })

  // DIAGNOSTIC: trace every raw from_me message through shaping so a run shows,
  // per message, whether the fromMe flag survived into persistence and which
  // direction it will be written as — the exact "computed and discarded?"
  // question. If shapedFromMe is ever false or skip is set for a from_me
  // message, this line pinpoints it.
  if (msg?.from_me === true) {
    console.log(
      'sync.diag.outbound ' +
        JSON.stringify({
          id: msg?.id ?? null,
          type: msg?.type ?? null,
          rawFromMe: msg.from_me,
          shapedFromMe: shaped.fromMe ?? null,
          skip: shaped.skip ?? null,
          direction: shaped.skip ? null : shaped.fromMe ? 'outbound' : 'inbound',
        })
    )
  }

  if (shaped.skip) return { added: false, skipped: true, reason: shaped.skip }

  const {
    fromMe, groupJid, sender, customerNumber, customerName,
    whapiMessageId, body, createdAt, explicitMedia, attachment, businessNumber,
    accountId,
  } = shaped

  // accountId is carried on the account-scoped env the caller built, so a sync
  // lands its messages in the account whose channel it walked.
  const conversation = groupJid
    ? await findOrCreateGroup(db, groupJid, businessNumber, chatName, 'sync', accountId)
    : await findOrCreateConversation(db, customerNumber, businessNumber, customerName, 'sync', accountId)

  // Same fetch-and-store pipeline for BOTH directions. An expired media id
  // (common on year-old messages) comes back as media_error rather than
  // throwing, and the message is still written with its text intact.
  let media = explicitMedia
  let mediaError = null
  if (attachment) {
    const ingested = await ingestAttachment(env, conversation.id, attachment)
    media = ingested.media
    mediaError = ingested.error
  }

  // Content guard, matching the has_content constraint. A media message whose
  // bytes expired (media_path null) with no caption has nothing to store — skip
  // it cleanly instead of attempting a write the constraint rejects (which
  // would throw and, in the backfill, abort the whole run). Common on year-old
  // media (e.g. captionless stickers). Only reachable here — shapeInboundMessage
  // is pure and cannot know the media failed until after the fetch.
  if (!messageHasContent(body, media)) {
    return { added: false, skipped: true, reason: 'no_content' }
  }

  // Direction-specific columns. The recipient of an outbound message is the
  // conversation counterparty (the group JID, or the customer's number).
  const directionRow = fromMe
    ? {
        direction: 'outbound',
        from_number: businessNumber,
        to_number: groupJid || customerNumber,
        sender_number: null,
        sender_name: null,
        status: outboundStatus(msg),
        sent_by: outboundSentBy(msg),
      }
    : {
        direction: 'inbound',
        from_number: groupJid ? sender.number : customerNumber,
        to_number: businessNumber,
        sender_number: groupJid ? sender.number : null,
        sender_name: groupJid ? sender.name : null,
        status: 'received',
        sent_by: null,
      }

  const inserted = await db
    .from('wp_chat_messages')
    .insert({
      conversation_id: conversation.id,
      ...directionRow,
      body,
      whapi_message_id: whapiMessageId,
      // Quoted reply, resolved against messages already stored. A backfill runs
      // newest-first through history, so the quoted original is often not landed
      // yet — reply_to_whapi_id is recorded either way, which is what lets the
      // thread show the quote block rather than silently dropping the reference.
      // This path also carries replies an agent sent from the WhatsApp app.
      ...(await resolveQuotedRef(db, conversation.id, msg)),
      // Historical messages are considered already-read in BOTH directions: a
      // backfill must never inflate unread counts, and our own replies are read
      // by definition (this matches /api/send, which stores is_read: true).
      is_read: true,
      created_at: createdAt,
      ...(mediaError ? { error_code: mediaError.slice(0, 200) } : {}),
      ...(media ? { ...media, media_caption: body } : {}),
    })
    .select('id')
    .single()

  if (inserted.error) {
    // Already synced (or, for outbound, already written live by /api/send): the
    // unique whapi_message_id makes this a no-op — the dedup guarantee, and the
    // reason an outbound message already in the DB is never doubled.
    if (inserted.error.code === UNIQUE_VIOLATION) {
      return { added: false, duplicate: true, direction: fromMe ? 'outbound' : 'inbound' }
    }
    throw new Error(inserted.error.message)
  }

  // Preview/order guard: only move last_message_at FORWARD. An old message must
  // never jump a conversation to the top or clobber a newer preview. Unread is
  // intentionally left untouched.
  //
  // Outbound gets NO group-sender prefix — the list adds "You: " itself from
  // last_direction, exactly as it does for a live reply.
  const preview = fromMe
    ? body || mediaPreviewLabel(media)
    : previewLine(groupJid, sender, body, media)

  const conv = unwrap(
    await db.from('wp_chat_conversations').select('last_message_at').eq('id', conversation.id).maybeSingle()
  )
  const existingAt = conv?.last_message_at ? new Date(conv.last_message_at).getTime() : 0
  if (new Date(createdAt).getTime() > existingAt) {
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: preview,
          last_message_at: createdAt,
          last_direction: fromMe ? 'outbound' : 'inbound',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
    )
  }

  return { added: true, direction: fromMe ? 'outbound' : 'inbound', mediaFailed: Boolean(mediaError) }
}

// Memoises @lid → real-JID lookups across the sync run (per isolate), so a chat
// synced over many steps resolves each LID once. A LID→real mapping is stable,
// so a longer-lived cache is safe.
//
// KEYED BY ACCOUNT. resolveLid() is a call to a SPECIFIC Whapi channel, and a
// LID is only meaningful to the channel that issued it — the same LID string can
// denote different contacts on two accounts. One shared Map would let account
// A's resolution answer account B's lookup and mis-file a message into the wrong
// customer's thread, which is exactly the cross-account leak this design exists
// to prevent.
const syncLidCaches = new Map()

function lidCacheFor(env) {
  const key = String(env?.ACCOUNT_ID ?? 'default')
  let cache = syncLidCaches.get(key)
  if (!cache) {
    cache = new Map()
    syncLidCaches.set(key, cache)
  }
  return cache
}

/**
 * persistHistorical + Facebook LID resolution for the sync paths. A message whose
 * chat_id is an unresolvable "@lid" is skipped here; otherwise chat_id is
 * rewritten to the real @s.whatsapp.net JID and the message is persisted.
 * persistHistorical itself is unchanged.
 */
async function persistWithLidResolution(env, db, msg, chatName) {
  const resolution = await resolveLidChatId(env, msg, lidCacheFor(env))
  if (resolution.skip) {
    console.log('sync: skipped unresolvable @lid ' + JSON.stringify({ chat_id: msg?.chat_id ?? null, id: msg?.id ?? null }))
    return { added: false, skipped: true, reason: 'unresolvable_lid' }
  }
  return persistHistorical(env, db, resolution.msg, chatName)
}

/**
 * Process a batch of raw messages, honouring an optional time window.
 *
 * DIAGNOSTIC: logs one `sync.diag.classify` line per page — returned vs how
 * many were classified inbound/outbound, added, deduped, window-skipped, and
 * skipped-with-reason. A run that silently drops every outbound message no
 * longer looks identical to a healthy one; the counts show it.
 */
async function ingestBatch(env, db, messages, chatName, windowSec, chatId = '') {
  let added = 0
  let mediaFailed = 0
  const stats = { returned: messages.length, inbound: 0, outbound: 0, added: 0, duplicate: 0, windowSkipped: 0, skipped: 0, reasons: {} }

  for (const msg of messages) {
    // Defensive window filter: even if Whapi ignores time_from/time_to, an
    // out-of-range message is skipped so a range sync stays within its dates.
    if (windowSec) {
      const ts = Number(msg?.timestamp)
      if (Number.isFinite(ts)) {
        if (windowSec.from && ts < windowSec.from) { stats.windowSkipped++; continue }
        if (windowSec.to && ts > windowSec.to) { stats.windowSkipped++; continue }
      }
    }
    const r = await persistWithLidResolution(env, db, msg, chatName)
    if (r.direction === 'inbound') stats.inbound++
    else if (r.direction === 'outbound') stats.outbound++
    if (r.added) { added++; stats.added++ }
    if (r.mediaFailed) mediaFailed++
    if (r.duplicate) stats.duplicate++
    if (r.skipped) {
      stats.skipped++
      // Break the generic non_text skip down by message type, so contact /
      // action (reactions, edits) / system (revoked) are visible distinctly
      // rather than lumped together.
      const key = r.reason === 'non_text' ? `non_text:${msg?.type || 'unknown'}` : r.reason
      stats.reasons[key] = (stats.reasons[key] || 0) + 1
    }
  }

  console.log('sync.diag.classify ' + JSON.stringify({ chat: chatId, ...stats }))

  return { added, mediaFailed }
}

/**
 * DIAGNOSTIC: dump the raw Whapi response for the first page of a chat, with
 * only token-shaped keys redacted (redactPayload preserves from/from_me/author/
 * chat_id/source so the real direction encoding is visible). Bounded to one
 * page (≤ STEP_MESSAGES) and only on offset 0, so it does not flood.
 */
function logRawPage(chatId, offset, messages) {
  if (offset !== 0) return
  console.log(
    'sync.diag.raw ' +
      JSON.stringify({ chat: chatId, count: messages.length, messages: messages.map(redactPayload) })
  )
}

/**
 * One bounded step of a job. Pure-ish: reads Whapi + the DB, returns a patch
 * for the caller to persist. Does NOT write the job row itself.
 *
 * Returns { done, cursor, addAdded, addMediaFailed, addConversationsDone, error }.
 */
export async function runSyncStep(env, db, job) {
  const scope = job.scope || {}
  const cursor = job.cursor || {}

  if (scope.type === 'conversation') {
    return stepConversation(env, db, scope, cursor)
  }
  // Manual date range AND automatic outage recovery walk chats the same way;
  // only the time window differs (see rangeWindow).
  if (scope.type === 'range' || scope.type === 'auto') {
    return stepRange(env, db, scope, cursor)
  }
  return { done: true, cursor, error: `unknown scope type: ${scope.type}` }
}

// Diff-based conversation sync (replaces the old fetch-all-then-dedup walk).
//
// Phase 1 'reconcile': page the conversation's Whapi message ids ONLY — no media
// download, no persist — with timestamp pagination (offset 0, time_to narrowed
// each page) so it never hits Whapi's deep-offset slowdown. Ids accumulate in the
// cursor across steps, each step bounded to RECONCILE_PAGES_PER_STEP calls. When
// history is exhausted, the collected ids are diffed against the ids already
// stored for this conversation and only the MISSING ones are staged.
//
// Phase 2 'fetch-missing': pull the full message for each missing id
// (STEP_MESSAGES per step) and hand it to persistHistorical — which still owns
// media, dedup, preview and direction exactly as before. Its UNIQUE dedup stays
// the backstop for anything that lands between the two phases.
//
// Net effect: re-syncing a 5000-message chat where 4990 exist fetches and
// re-hosts ~10 messages, not 5000.
async function stepConversation(env, db, scope, cursor) {
  const phase = cursor.phase || 'reconcile'
  if (phase === 'fetch-missing') return fetchMissingConversation(env, db, scope, cursor)
  return reconcileConversation(env, db, scope, cursor)
}

/** Smallest UNIX-second timestamp in a raw Whapi page — the time_to watermark. */
function pageMinTimestamp(messages) {
  let min = Infinity
  for (const m of messages) {
    const ts = Number(m?.timestamp)
    if (Number.isFinite(ts) && ts < min) min = ts
  }
  return Number.isFinite(min) ? min : null
}

/**
 * Phase 1 — collect the conversation's Whapi message ids (bounded per step),
 * then on exhaustion diff against the DB and hand off to the fetch-missing phase.
 */
async function reconcileConversation(env, db, scope, cursor) {
  const ids = Array.isArray(cursor.whapi_ids) ? cursor.whapi_ids.slice() : []
  // undefined on the first page (newest first), then narrowed backwards in time.
  let timeTo = Number.isFinite(Number(cursor.reconcile_time_to)) ? Number(cursor.reconcile_time_to) : undefined

  for (let i = 0; i < RECONCILE_PAGES_PER_STEP; i++) {
    const list = await listMessages(env, scope.chat_id, { offset: 0, count: RECONCILE_PAGE, timeTo })

    if (!list.ok) {
      // Account-level failure halts the whole job; a dead chat ends this one.
      if (list.accountError) {
        return {
          done: true,
          cursor: { ...cursor, phase: 'reconcile', whapi_ids: ids, reconcile_time_to: timeTo ?? null },
          error: list.error,
          accountError: true,
        }
      }
      return { done: true, cursor: { ...cursor, phase: 'reconcile' }, error: list.error, addConversationsDone: 0 }
    }

    const page = list.messages
    for (const m of page) if (m?.id) ids.push(String(m.id))

    // A short page means no older messages remain — history is exhausted.
    if (page.length < RECONCILE_PAGE) return finishReconcile(db, scope, ids)

    // Walk further back, excluding the boundary second (matches the backfill).
    const min = pageMinTimestamp(page)
    if (min == null) return finishReconcile(db, scope, ids)
    timeTo = min - 1
  }

  // Not exhausted — persist progress and let the client run another step.
  return {
    done: false,
    cursor: { ...cursor, phase: 'reconcile', whapi_ids: ids, reconcile_time_to: timeTo ?? null },
    addConversationsDone: 0,
  }
}

/** Diff the collected Whapi ids against the DB and stage the missing ones. */
async function finishReconcile(db, scope, collectedIds) {
  const whapiIds = [...new Set(collectedIds)]
  const existing = await fetchExistingWhapiIds(db, scope.conversation_id)
  const missing = whapiIds.filter((id) => !existing.has(id))

  console.log(
    'sync.diag.reconcile ' +
      JSON.stringify({ chat: scope.chat_id, whapi: whapiIds.length, existing: existing.size, missing: missing.length })
  )

  const cursor = { phase: 'fetch-missing', missing_ids: missing, missing_offset: 0 }
  // Nothing missing — the conversation is already fully synced.
  if (missing.length === 0) {
    return { done: true, cursor, addAdded: 0, addMediaFailed: 0, addConversationsDone: 1 }
  }
  return { done: false, cursor, addConversationsDone: 0 }
}

/**
 * Every non-null whapi_message_id already stored for a conversation, as a Set.
 * Paged past PostgREST's default 1000-row cap: without paging, a chat with more
 * than 1000 stored messages would report the unseen ones as "missing" and
 * re-fetch them, defeating the whole diff.
 */
async function fetchExistingWhapiIds(db, conversationId) {
  const out = new Set()
  if (conversationId == null) return out
  let from = 0
  for (;;) {
    const rows =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select('whapi_message_id')
          .eq('conversation_id', conversationId)
          .not('whapi_message_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + DB_ID_PAGE - 1)
      ) || []
    for (const r of rows) if (r.whapi_message_id != null) out.add(String(r.whapi_message_id))
    if (rows.length < DB_ID_PAGE) break
    from += DB_ID_PAGE
  }
  return out
}

/**
 * Phase 2 — fetch and persist one chunk of missing messages. persistHistorical
 * handles media, dedup, preview and direction exactly as the old walk did.
 */
async function fetchMissingConversation(env, db, scope, cursor) {
  const missing = Array.isArray(cursor.missing_ids) ? cursor.missing_ids : []
  const start = Number(cursor.missing_offset) || 0
  const chunk = missing.slice(start, start + STEP_MESSAGES)

  let added = 0
  let mediaFailed = 0

  for (const id of chunk) {
    const got = await getMessage(env, id)
    if (!got.ok) {
      // Account-level failure halts the whole job. Anything else (a 404 for a
      // message deleted on Whapi, or a transient blip) is a per-message skip —
      // the offset still advances so a step always makes progress and can never
      // loop forever on one bad id. A later full reconcile re-detects it.
      if (got.accountError) {
        return { done: true, cursor: { ...cursor, missing_offset: start }, error: got.error, accountError: true }
      }
      console.log('sync.diag.fetch-missing skip ' + JSON.stringify({ id, error: got.error }))
      continue
    }
    const r = await persistWithLidResolution(env, db, got.message, scope.name)
    if (r.added) added++
    if (r.mediaFailed) mediaFailed++
  }

  const nextOffset = start + chunk.length
  const done = nextOffset >= missing.length

  return {
    done,
    cursor: { ...cursor, missing_offset: nextOffset },
    addAdded: added,
    addMediaFailed: mediaFailed,
    addConversationsDone: done ? 1 : 0,
  }
}

async function stepRange(env, db, scope, cursor) {
  const { from, to } = rangeWindow(scope)
  const windowSec = { from, to }

  const state = {
    chatOffset: Number(cursor.chatOffset) || 0,
    pending: Array.isArray(cursor.pending) ? cursor.pending : [],
    current: cursor.current || null,
    chatsExhausted: Boolean(cursor.chatsExhausted),
  }

  // 1. Need a chat to work on? Seed from /chats (one page cached in the cursor).
  if (!state.current && state.pending.length === 0) {
    if (state.chatsExhausted) {
      return { done: true, cursor: state } // nothing left anywhere
    }
    const page = await listChats(env, { offset: state.chatOffset, count: CHATS_PAGE })
    if (!page.ok) {
      // Quota/account failure: stop the whole job so an auto-sync cannot retry
      // it on every poll. A transient error just backs off and retries.
      if (page.accountError) {
        return { done: true, cursor: state, error: page.error, accountError: true }
      }
      return { done: false, cursor: state, error: page.error, backoff: true }
    }
    state.pending = page.chats
    state.chatOffset += page.chats.length
    if (page.chats.length < CHATS_PAGE) state.chatsExhausted = true
    if (state.pending.length === 0) {
      return { done: state.chatsExhausted, cursor: state }
    }
    // Seed step only — do the message work on the next step so this stays one
    // Whapi call.
    return { done: false, cursor: state }
  }

  // 2. Promote the next chat if we are between chats.
  if (!state.current) {
    const next = state.pending.shift()
    state.current = { id: next.id, name: next.name, msgOffset: 0 }
  }

  // 3. Pull one message page for the current chat.
  const list = await listMessages(env, state.current.id, {
    offset: state.current.msgOffset,
    count: STEP_MESSAGES,
    timeFrom: from,
    timeTo: to,
  })

  if (!list.ok) {
    // Account-level failure halts everything; a normal one just skips this chat.
    if (list.accountError) {
      state.current = null
      return { done: true, cursor: state, error: list.error, accountError: true }
    }
    // Skip this chat, record the failure, move on.
    const chatId = state.current.id
    state.current = null
    return {
      done: false,
      cursor: state,
      error: list.error,
      errorChat: chatId,
      addConversationsDone: 0,
    }
  }

  logRawPage(state.current.id, state.current.msgOffset, list.messages)
  const { added, mediaFailed } = await ingestBatch(env, db, list.messages, state.current.name, windowSec, state.current.id)

  state.current.msgOffset += list.messages.length
  const chatDone = list.messages.length < STEP_MESSAGES
  let conversationsDone = 0
  if (chatDone) {
    conversationsDone = 1
    state.current = null
  }

  // The whole job is done only once there is no current chat, nothing pending,
  // and /chats has been exhausted.
  const done = !state.current && state.pending.length === 0 && state.chatsExhausted

  return {
    done,
    cursor: state,
    addAdded: added,
    addMediaFailed: mediaFailed,
    addConversationsDone: conversationsDone,
  }
}
