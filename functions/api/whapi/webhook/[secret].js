import { getDb, unwrap, UNIQUE_VIOLATION } from '../../../_lib/db.js'
import { redactPayload } from '../../../_lib/whapi.js'
import {
  shapeInboundMessage,
  resolveLidChatId,
  ingestAttachment,
  findOrCreateGroup,
  findOrCreateConversation,
  previewLine,
} from '../../../_lib/ingest.js'
import { persistHistorical } from '../../../_lib/sync.js'
import { resolveQuotedRef } from '../../../_lib/reply.js'
import { notifyNewMessage } from '../../../_lib/notify.js'
import { autoAssign } from '../../../_lib/assign.js'
import { refreshConversationSummary } from '../../../_lib/summarize.js'
import { ingestAvatar } from '../../../_lib/avatar.js'
import { syncGroup } from '../../../_lib/group.js'
import {
  accountForWebhookSecret,
  defaultAccount,
  envForAccountRow,
} from '../../../_lib/accounts.js'

// Public endpoint — called by Whapi, not by a logged-in user. Whapi supports
// neither signed webhooks nor custom auth headers, so the secret path segment
// IS the credential. A wrong secret gets a 404 so the route's existence stays
// unadvertised.
//
//   https://<domain>/api/whapi/webhook/<WHAPI_WEBHOOK_SECRET>

const notFound = () =>
  new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

const accepted = (detail) =>
  new Response(JSON.stringify({ ok: true, ...detail }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** Length-independent constant-time compare, so the secret can't be timed out. */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  if (!expected) return false

  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(expected)

  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export async function onRequest(context) {
  const { request, env: baseEnv, params } = context
  // Collected during processing and flushed after the response — Whapi must
  // get its 200 without waiting on push delivery.
  const pending = []

  // Hide the route from anything that isn't the real delivery.
  if (request.method !== 'POST') return notFound()

  // ---------------------------------------------------------------------
  // ACCOUNT ROUTING. The secret in the path both authenticates the delivery
  // AND identifies which account's channel it came from — that is what lets N
  // Whapi channels share this one route while their messages stay separate.
  //
  // Two ways to resolve, in order:
  //   1. A per-account secret, matched by indexed hash lookup.
  //   2. The legacy env WHAPI_WEBHOOK_SECRET, which maps to the DEFAULT
  //      account. This is what keeps the existing Whapi channel — already
  //      configured with the old URL — delivering after the upgrade, with no
  //      change needed in the Whapi dashboard.
  // ---------------------------------------------------------------------
  const secret = params?.secret
  let account = await accountForWebhookSecret(baseEnv, secret).catch(() => null)

  if (!account && secretsMatch(secret, baseEnv?.WHAPI_WEBHOOK_SECRET)) {
    account = await defaultAccount(baseEnv).catch(() => null)
  }

  // A wrong secret gets a 404 so the route's existence stays unadvertised.
  if (!account) return notFound()

  // Everything downstream runs against THIS account's credentials. Because the
  // whole ingest path threads `env`, swapping it here is all that is needed —
  // no ingest/sync/whapi function had to learn about accounts.
  const env = await envForAccountRow(baseEnv, account)

  let payload
  try {
    payload = await request.json()
  } catch {
    // Malformed body: 200 anyway, or Whapi retries it forever.
    console.error('whapi webhook: body was not valid JSON')
    return accepted({ processed: 0, skipped: 0 })
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  let processed = 0
  let skipped = 0

  // Ids handled in THIS request. Whapi can deliver the same outbound message both
  // as messages.post AND inside chats_updates (in one payload or two) — this Set
  // makes the second sighting a no-op within the request, before any DB work. The
  // unique whapi_message_id index remains the cross-request backstop.
  const seen = new Set()

  // Memoises @lid → real-JID lookups for the life of this request, so the same
  // LID appearing in several messages/updates costs a single Whapi call.
  const lidCache = new Map()

  for (const msg of messages) {
    if (msg?.id) seen.add(String(msg.id))
    try {
      const result = await handleMessage(env, msg, pending, lidCache)
      if (result === 'inserted') processed++
      else skipped++
    } catch (err) {
      // One bad message must not sink the batch, and must not trigger a retry
      // of the messages that already landed.
      skipped++
      console.error('whapi webhook: failed to process message', msg?.id, err?.message)
    }
  }

  // chats_updates: a message sent from the WhatsApp Business app arrives as a chat
  // PATCH carrying the chat's `last_message`, NOT under `messages`. Take ONLY the
  // outbound (from_me) ones — an inbound chat update is already covered by
  // messages.post and must not re-run push/unread from here. Each goes through the
  // SAME handleMessage flow (reconcile echo → else persist), so echo
  // reconciliation and dedup are identical to the messages path.
  const chatsUpdates = Array.isArray(payload?.chats_updates) ? payload.chats_updates : []
  for (const update of chatsUpdates) {
    const lm = update?.last_message
    // Skip a chat update with no message, or an inbound one (handled elsewhere).
    if (!lm || lm.from_me !== true) continue

    const id = lm.id ? String(lm.id) : null
    // Already handled this request (Scenario C) — count as skipped, never insert.
    if (id && seen.has(id)) {
      skipped++
      continue
    }
    if (id) seen.add(id)

    try {
      const result = await handleMessage(env, lm, pending, lidCache)
      if (result === 'inserted') processed++
      else skipped++
    } catch (err) {
      skipped++
      console.error('whapi webhook: failed to process chats_updates message', id, err?.message)
    }
  }

  // Flush the deferred work (push fan-out, avatar/group sync, summary refresh).
  //
  // waitUntil keeps the isolate alive past the response, which is what lets a
  // 15-30s summary generation finish after Whapi already has its 200. When it
  // is NOT available the promises must still be awaited: previously they were
  // created and abandoned, so the isolate was torn down at `return` and every
  // slow task died mid-flight — silently, since nothing was ever awaited to
  // observe the rejection. The summary refresh is the slowest item in `pending`
  // and so was the one that reliably never completed.
  //
  // Awaiting delays the 200 by the length of the flush, which is not free — but
  // Whapi retries on a missing/failed response, not a slow one, and losing the
  // work outright is worse than answering late.
  if (pending.length) {
    // allSettled, not all: one rejection must not mask the others, and each
    // task already logs its own failure. This only reports what got through.
    const flush = Promise.allSettled(pending).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length) {
        console.error(
          'whapi webhook: deferred task(s) failed',
          JSON.stringify({
            failed: failed.length,
            total: results.length,
            reasons: failed.slice(0, 5).map((r) => String(r.reason?.message || r.reason)),
          })
        )
      }
    })

    if (typeof context.waitUntil === 'function') context.waitUntil(flush)
    else await flush
  }

  return accepted({ processed, skipped })
}

// How far back an un-idded outbound row is still considered a candidate echo of
// the message now arriving. Whapi echoes land within seconds; the generous
// window only has to cover a slow send + patch, while staying short enough that
// an old stuck 'queued' row can never be mistaken for a fresh echo.
const ECHO_WINDOW_MS = 5 * 60 * 1000

/**
 * Reconcile a from_me webhook message against a reply we sent from the inbox.
 *
 * /api/send writes its row BEFORE calling Whapi and patches whapi_message_id in
 * only after the response arrives — so an echo can overtake that patch, and a
 * send that returns no messageId never gets one at all. Either way the row's
 * whapi_dedup_id is NULL, which the partial unique index does not cover, so the
 * echo would insert a second copy. Matching on the un-idded row closes both
 * cases without depending on the echo losing that race.
 *
 * Returns true when this message was an echo and has been reconciled (the
 * caller must not insert), false when it is a genuinely new outbound message
 * (sent from the WhatsApp Business app) that still needs storing.
 */
async function reconcileOutboundEcho(db, conversationId, whapiMessageId) {
  // No id to backfill means nothing to match on — treat as un-reconciled and
  // let the normal insert path decide.
  if (!whapiMessageId) return false

  const since = new Date(Date.now() - ECHO_WINDOW_MS).toISOString()

  const candidates = unwrap(
    await db
      .from('wp_chat_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .is('whapi_message_id', null)
      .in('status', ['queued', 'sent'])
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
  )

  const match = candidates?.[0]
  if (!match) return false

  // Backfill the id onto the row /api/send already wrote. This also populates
  // the generated whapi_dedup_id, so any LATER duplicate of this same message
  // (e.g. an auto-sync recovery) hits the unique index and is dropped.
  //
  // Re-assert the null check in the UPDATE itself: two echoes processed
  // concurrently could both read the same candidate, and only one may claim it.
  // The loser matches zero rows and falls through to a fresh insert, where the
  // unique index is the final backstop.
  const claimed = unwrap(
    await db
      .from('wp_chat_messages')
      .update({ whapi_message_id: whapiMessageId })
      .eq('id', match.id)
      .is('whapi_message_id', null)
      .select('id')
  )

  return Boolean(claimed?.length)
}

async function handleMessage(env, msg, pending = [], lidCache = null) {
  // Shared with the sync backfill — see functions/_lib/ingest.js. Everything
  // from here down is the LIVE-only behaviour: unread bump and push fan-out.
  //
  // allowOutbound: from_me messages are no longer dropped as echoes. An agent
  // replying from the WhatsApp Business app produces one, and it is a real
  // message we would otherwise never capture. Echoes of our OWN inbox replies
  // are separated out below by reconcileOutboundEcho, not by discarding the
  // whole class.
  // Resolve a Facebook LID chat_id ("…@lid") to the real @s.whatsapp.net JID
  // before anything else, so the rest of the pipeline sees a normal number. An
  // unresolvable @lid is dropped: we cannot identify the contact, and an inbound
  // reply also arrives under the real JID, so nothing is lost.
  const resolution = await resolveLidChatId(env, msg, lidCache)
  if (resolution.skip) {
    console.log('whapi webhook: skipped unresolvable @lid', JSON.stringify({ chat_id: msg?.chat_id ?? null, message_id: msg?.id ?? null }))
    return 'skipped'
  }
  const effectiveMsg = resolution.msg
  if (effectiveMsg !== msg) console.log('whapi webhook: resolved LID → ' + effectiveMsg.chat_id)

  const shaped = shapeInboundMessage(effectiveMsg, env, { allowOutbound: true })
  if (shaped.skip) {
    if (shaped.skip === 'broadcast' || shaped.skip === 'invalid_number') {
      console.log(
        'whapi webhook: skipping message',
        JSON.stringify({ skip: shaped.skip, message_id: msg?.id ?? null, payload: redactPayload(msg) })
      )
    }
    return 'skipped'
  }

  const {
    fromMe, groupJid, sender, customerNumber, customerName,
    whapiMessageId, body, createdAt, explicitMedia, attachment, businessNumber,
    accountId,
  } = shaped

  const db = getDb(env)

  // accountId comes off the account-scoped env set in onRequest, so the
  // conversation is bound to the channel the message actually arrived on.
  const conversation = groupJid
    ? await findOrCreateGroup(db, groupJid, businessNumber, effectiveMsg?.chat_name, 'webhook', accountId)
    : await findOrCreateConversation(db, customerNumber, businessNumber, customerName, 'webhook', accountId)

  // On creation only — no refresh, no backfill. Fire-and-forget via the same
  // waitUntil the push fan-out uses, so it can never delay the 200.
  if (conversation.__created) {
    pending.push(
      groupJid
        ? syncGroup(env, conversation.id, groupJid)
        : ingestAvatar(env, conversation.id, customerNumber)
    )

    // A fresh 1:1 lead is auto-assigned to sales, round-robin, at creation —
    // before the push below, so the existing routing notifies the assigned
    // agent. Department is not consulted for fresh leads. Groups are never
    // auto-assigned. If sales has no active agents it stays unassigned.
    if (!groupJid) {
      try {
        const result = await autoAssign(db, conversation.id, 'sales', accountId)
        if (result.assigned) {
          conversation.assigned_user_id = result.agent.id
          conversation.assigned_to = result.agent.name
        }
      } catch (err) {
        console.error('auto-assign (fresh) failed', conversation.id, err?.message)
      }
    }
  }

  // --- from_me: our own outbound, from one of two very different sources -----
  //
  // Handled before the media ingest below, so an echo never re-downloads bytes
  // /api/send already stored.
  if (fromMe) {
    // (a) Echo of an inbox reply: backfill the id onto the row we already wrote
    //     and stop. No second row, no preview churn — /api/send set the preview.
    const reconciled = await reconcileOutboundEcho(db, conversation.id, whapiMessageId)
    if (reconciled) return 'skipped'

    // (b) No pending row to claim, so this was sent from the WhatsApp Business
    //     app and we have never seen it. persistHistorical writes exactly the
    //     outbound row we want (direction, status, sent_by, forward-only
    //     preview) and already treats a UNIQUE violation as a no-op duplicate,
    //     which covers a Whapi retry of this same echo.
    const stored = await persistHistorical(env, db, effectiveMsg, effectiveMsg?.chat_name)

    // Summary refresh fires for outbound too — an agent replying from their
    // phone is exactly the activity the digest must not miss. Push and unread
    // are deliberately NOT touched: we do not notify ourselves about our own
    // message, and our own reply cannot make a thread unread.
    if (stored.added) {
      pending.push(
        refreshConversationSummary(env, conversation.id, Boolean(groupJid))
          .then((result) => {
            console.log(
              'summary refresh (webhook outbound)',
              JSON.stringify({ conversation_id: conversation.id, action: result?.action ?? null })
            )
          })
          .catch((err) =>
            console.error(
              'summary refresh (webhook outbound) failed',
              conversation.id,
              err?.message || String(err)
            )
          )
      )
    }

    return stored.added ? 'inserted' : 'skipped'
  }

  // Pull the bytes into our own bucket. A failure here must degrade to a
  // "Media unavailable" bubble, never drop the message.
  let media = explicitMedia
  let mediaError = null

  if (attachment) {
    const ingested = await ingestAttachment(env, conversation.id, attachment)
    media = ingested.media
    mediaError = ingested.error
  }

  // Quoted reply, if the payload carries one — shared with the sync backfill so
  // both paths map Whapi's quoted id onto our row the same way.
  const quotedRef = await resolveQuotedRef(db, conversation.id, msg)

  // Insert the message. whapi_message_id is UNIQUE, which is what makes a Whapi
  // retry idempotent — the duplicate is dropped and the badge is not re-bumped.
  const inserted = await db
    .from('wp_chat_messages')
    .insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      from_number: groupJid ? sender.number : customerNumber,
      to_number: businessNumber,
      // Null for 1:1 — the conversation already identifies the other party.
      sender_number: groupJid ? sender.number : null,
      sender_name: groupJid ? sender.name : null,
      body,
      whapi_message_id: whapiMessageId,
      ...quotedRef,
      status: 'received',
      is_read: false,
      created_at: createdAt,
      // media_error flags the failure to the UI; error_code carries the reason.
      ...(mediaError ? { error_code: mediaError.slice(0, 200) } : {}),
      ...(media ? { ...media, media_caption: body } : {}),
    })
    .select('id')
    .single()

  if (inserted.error) {
    if (inserted.error.code === UNIQUE_VIOLATION) return 'skipped'
    throw new Error(inserted.error.message)
  }

  // Everything from here down is INBOUND-ONLY, and structurally so: the from_me
  // branch above returns in every case, so a message that reaches this line has
  // from_me false. That is what keeps push and the unread bump off our own
  // outbound — including replies sent from the WhatsApp Business app, which are
  // now stored but must not notify us about ourselves or mark a thread unread.
  // If that early return is ever softened, both guarantees below need explicit
  // `if (!fromMe)` guards.
  //
  // Queue the push FIRST — the moment the insert is confirmed, before any of the
  // unread/preview bookkeeping below. The notification needs only the
  // conversation id and the message body, so it must never be lost to a failure
  // in that read-modify-write (previously an unwrap() throw here left the message
  // stored but the push silently unsent).
  pending.push(
    notifyNewMessage(env, {
      // account_id scopes the push fan-out to this account's members.
      conversation: {
        id: conversation.id,
        assigned_user_id: conversation.assigned_user_id,
        account_id: conversation.account_id ?? accountId,
      },
      message: { id: inserted.data?.id ?? null, body, media_type: media?.media_type ?? null },
      title: groupJid
        ? conversation.customer_name || 'Group'
        : customerName || conversation.customer_name || `+${customerNumber}`,
      // Prefixes the body with the sender inside a group, as WhatsApp does.
      senderName: groupJid ? sender.name || (sender.number ? `+${sender.number}` : null) : null,
    })
  )

  // Preview + unread badge, only for a message we actually stored. Wrapped in its
  // own try/catch so a PostgREST hiccup degrades to a stale badge/preview and a
  // log line — it can no longer throw out of handleMessage and take the push (or
  // the summary refresh) down with it.
  //
  // PostgREST has no atomic `unread_count = unread_count + 1`, so this is a
  // read-modify-write. Two messages arriving in the same instant can lose a
  // count; the badge is a hint and opening the thread resets it, so that is an
  // acceptable trade for not adding a DB function.
  try {
    const current = unwrap(
      await db
        .from('wp_chat_conversations')
        .select('unread_count')
        .eq('id', conversation.id)
        .maybeSingle()
    )

    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          // Media with no caption still needs a readable preview line. In a
          // group the sender is prefixed here rather than in a separate column —
          // it is what the list AND the toast both want to show.
          last_message_body: previewLine(groupJid, sender, body, media),
          last_message_at: createdAt,
          last_direction: 'inbound',
          unread_count: (Number(current?.unread_count) || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
    )
  } catch (err) {
    console.error('whapi webhook: unread/preview update failed', conversation.id, err?.message || err)
  }

  // Fire-and-forget: keep the conversation's AI summary current as new inbound
  // activity arrives, so the EOD digest has coverage without a manual click. The
  // dormant guard + 6-hour gate live inside refreshConversationSummary
  // (decideRefresh), so a busy chat does NOT generate on every message — most
  // calls are a cheap cached no-op. Flushed via waitUntil; never blocks the 200.
  // Logs the outcome, not just failures: a silent no-op and a refresh that
  // never ran were previously indistinguishable in the logs, which is what made
  // the abandoned-promise bug above invisible. `action` names which branch of
  // decideRefresh was taken ('cached' | 'generated' | 'generating' | …).
  pending.push(
    refreshConversationSummary(env, conversation.id, Boolean(groupJid))
      .then((result) => {
        console.log(
          'summary refresh (webhook)',
          JSON.stringify({ conversation_id: conversation.id, action: result?.action ?? null })
        )
      })
      .catch((err) =>
        // err?.message alone is empty for a non-Error rejection, which silently
        // produced a blank log line.
        console.error(
          'summary refresh (webhook) failed',
          conversation.id,
          err?.message || String(err)
        )
      )
  )

  return 'inserted'
}
