// Shared inbound-message ingestion.
//
// Extracted from the Whapi webhook so the SYNC backfill goes through exactly
// the same media-fetch, group-routing and dedup pipeline as live delivery.
// The webhook and the sync worker both call shapeInboundMessage() to normalise
// a raw Whapi message, then findOrCreate*/ingestAttachment to land it — they
// differ only in the side effects AFTER the insert (unread + push for live,
// nothing for historical).

import { unwrap, UNIQUE_VIOLATION } from './db.js'
import {
  toDigits,
  fetchMedia,
  fetchMediaUrl,
  groupJidOf,
  senderOf,
  resolveLid,
} from './whapi.js'
import {
  readMediaFields,
  uploadObject,
  mediaTypeFromWhapi,
  MAX_UPLOAD_BYTES,
} from './storage.js'

const ATTACHMENT_KEYS = ['image', 'video', 'audio', 'voice', 'ptt', 'document', 'sticker', 'gif']

/**
 * Pull a native Whapi attachment descriptor off an inbound message.
 * Whapi nests it under a key matching the message type, e.g.
 *   { type: 'image', image: { id, mime_type, file_size, caption } }
 * Returns null when the message carries no attachment.
 */
export function describeAttachment(msg) {
  const key = ATTACHMENT_KEYS.includes(msg?.type) ? msg.type : null
  const info = (key && msg[key]) || msg?.media || null
  if (!info || typeof info !== 'object') return null

  const mediaId = info.id || info.media_id || null
  // No id means nothing to download — treat as no attachment at all.
  if (!mediaId) return null

  const mime = String(info.mime_type || info.mime || '').split(';')[0].trim() || null
  const size = Number(info.file_size ?? info.size)

  // Whapi puts a direct storage URL alongside the id. Captured so ingest can
  // recover the bytes when /media/{id} has expired on an old message.
  const link = [info.link, info.url].find((v) => typeof v === 'string' && v) || null

  return {
    mediaId: String(mediaId),
    mime,
    link,
    filename: info.file_name || info.filename || null,
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
    caption: typeof info.caption === 'string' && info.caption ? info.caption : null,
    type: mediaTypeFromWhapi(msg?.type, mime),
  }
}

/**
 * Download from Whapi and store in our bucket.
 * Always returns a media object so the row records what the attachment WAS,
 * even when the bytes could not be retrieved — media_path stays null and the
 * caller records the reason. Never throws.
 *
 * For a historical sync this is also where an EXPIRED media id surfaces: Whapi
 * answers 404/410, fetchMedia returns {ok:false}, and this degrades to
 * media_error just like a live failure — never an exception.
 */
export async function ingestAttachment(env, conversationId, attachment) {
  const base = {
    media_path: null,
    media_type: attachment.type,
    media_mime: attachment.mime,
    media_filename: attachment.filename,
    media_size: attachment.size,
    media_caption: null,
    media_error: true,
  }

  let fetched = await fetchMedia(env, attachment.mediaId, MAX_UPLOAD_BYTES)

  // Recovery: /media/{id} expires on old messages, but the direct storage link
  // may still resolve. Only tried on failure, so live delivery (fresh id) is
  // unaffected; if the link fails too, this degrades to media_error as before.
  if (!fetched.ok && attachment.link) {
    const viaLink = await fetchMediaUrl(attachment.link, MAX_UPLOAD_BYTES)
    if (viaLink.ok) {
      console.log('ingest: recovered media via direct link', attachment.mediaId)
      fetched = viaLink
    } else {
      console.error('ingest: media fetch failed (id and link)', attachment.mediaId, fetched.error, viaLink.error)
      return { media: base, error: `${fetched.error}; link:${viaLink.error}` }
    }
  }

  if (!fetched.ok) {
    console.error('ingest: media fetch failed', attachment.mediaId, fetched.error)
    return { media: base, error: fetched.error }
  }

  const mime = attachment.mime || fetched.mime || 'application/octet-stream'

  const uploaded = await uploadObject(env, {
    conversationId,
    bytes: fetched.bytes,
    mime,
    filename: attachment.filename,
  })

  if (!uploaded.ok) {
    console.error('ingest: media upload failed', attachment.mediaId, uploaded.error)
    return { media: { ...base, media_mime: mime }, error: uploaded.error }
  }

  return {
    media: {
      ...base,
      media_path: uploaded.path,
      media_mime: mime,
      media_size: attachment.size ?? fetched.bytes.byteLength,
      media_error: false,
    },
    error: null,
  }
}

export function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/**
 * The DB's wp_chat_messages_has_content constraint requires every row to have
 * SOMETHING to show — a body, or a stored media object (media_path). A media
 * message whose bytes have expired (media_path null) and that carries no
 * caption satisfies neither, and must be skipped rather than written.
 *
 * shapeInboundMessage cannot make this call: it is pure, and whether the media
 * actually stored is only known AFTER ingestAttachment runs. So the check lives
 * here and is applied by the persistence layer post-ingest. The constraint is
 * correct — this simply avoids attempting a write it would (rightly) reject.
 */
export function messageHasContent(body, media) {
  return Boolean(body) || Boolean(media && media.media_path)
}

/** Build the group-aware preview line used by the list AND the toast. */
export function previewLine(groupJid, sender, body, media) {
  const text = body || mediaPreviewLabel(media)
  if (!groupJid) return text
  const who = sender?.name || (sender?.number ? `+${sender.number}` : 'Someone')
  return `${who}: ${text}`
}

/**
 * Extract readable text from a WhatsApp template ("hsm") message — the shape a
 * template sent from the WhatsApp Business app arrives as. The rendered template
 * carries its text in hsm.body, sometimes with a text header in
 * hsm.header.text.body. Returns the joined text, or null when there is nothing
 * textual to show (e.g. a media-header template we cannot render here).
 */
function hsmBody(msg) {
  const h = msg?.hsm
  if (!h || typeof h !== 'object') return null
  const parts = []
  const header = h.header?.text?.body
  if (typeof header === 'string' && header.trim()) parts.push(header.trim())
  if (typeof h.body === 'string' && h.body.trim()) parts.push(h.body.trim())
  return parts.length ? parts.join('\n') : null
}

/**
 * Normalise a raw Whapi message (webhook OR /messages/list — same shape) into
 * the fields every downstream write needs, or {skip: reason} for anything that
 * is not a storable conversation message.
 *
 * `allowOutbound` controls whether from_me messages survive shaping:
 *   - true — used by BOTH the sync backfill and the live webhook. A from_me
 *     message is kept and shaped with `fromMe: true` so the caller writes it
 *     with direction 'outbound'.
 *   - false (default) — from_me is skipped outright. No caller uses this today;
 *     it remains for a consumer that genuinely only wants inbound.
 *
 * The webhook used to pass false, on the theory that every from_me message was
 * an echo of a reply /api/send had already written. That also silently dropped
 * replies an agent sent from the WhatsApp Business app, which have no local row
 * at all. Distinguishing the two needs a DB lookup, so it cannot happen here —
 * this function is pure. The webhook now keeps from_me messages and reconciles
 * them against the pending outbound row itself.
 *
 * Pure: no I/O, no side effects — which is what lets both callers share it and
 * what makes it unit-testable without a database.
 */
export function shapeInboundMessage(msg, env, { allowOutbound = false } = {}) {
  const fromMe = msg?.from_me === true
  // Live: drop our own outbound echoes. Sync: keep them (see above).
  if (fromMe && !allowOutbound) return { skip: 'from_me' }

  const groupJid = groupJidOf(msg)
  // Outbound has no inbound "sender" — `from` is us, so senderOf would wrongly
  // treat the business number as a group participant. Only inbound resolves one.
  const sender = groupJid && !fromMe ? senderOf(msg) : { number: null, name: null }

  // Broadcasts and newsletters are never conversations.
  const chatIdRaw = String(msg?.chat_id ?? '')
  if (/@(broadcast|newsletter)$/i.test(chatIdRaw)) return { skip: 'broadcast' }

  const explicitMedia = readMediaFields(msg)
  const attachment = explicitMedia ? null : describeAttachment(msg)

  // Template ("hsm") messages — sent from the WhatsApp Business app — carry their
  // text under hsm.body (+ optional hsm.header.text.body), not text.body. Pull it
  // out so the guard below treats a template with text like any text message.
  const hsmText = msg?.type === 'hsm' ? hsmBody(msg) : null

  // Text-bearing messages must be type 'text' (or an hsm template we could read).
  if (!explicitMedia && !attachment && msg?.type !== 'text' && !hsmText) return { skip: 'non_text' }

  // A Facebook LID chat_id ("…@lid") is resolved to the real @s.whatsapp.net JID
  // by the caller (resolveLidChatId) BEFORE this runs, so by here chat_id is
  // always a real number — no LID heuristics needed.
  const customerNumber = groupJid ? null : toDigits(msg?.chat_id ?? msg?.from)
  const whapiMessageId = msg?.id ? String(msg.id) : null

  const rawBody =
    msg?.text?.body ?? msg?.caption ?? hsmText ?? attachment?.caption ?? explicitMedia?.media_caption ?? null
  const body = typeof rawBody === 'string' && rawBody ? rawBody : null

  if (!groupJid && !customerNumber) return { skip: 'no_identifier' }
  // A leading 0 is never a valid E.164 country code (it is a national trunk
  // prefix), so this is not a real international number — always junk.
  if (customerNumber && customerNumber.startsWith('0')) return { skip: 'invalid_number' }

  // Without media, a body is mandatory — otherwise there is nothing to show.
  if (!explicitMedia && !attachment && !body) return { skip: 'empty' }

  const fromName = typeof msg?.from_name === 'string' ? msg.from_name.trim() : ''

  // Whapi sends UNIX seconds.
  const ts = Number(msg?.timestamp)
  const createdAt =
    Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString()

  return {
    skip: null,
    fromMe,
    groupJid,
    sender,
    customerNumber,
    customerName: fromName || null,
    whapiMessageId,
    body,
    createdAt,
    explicitMedia,
    attachment,
    businessNumber: toDigits(env?.BUSINESS_NUMBER),
    // Set by envForAccount() on an account-scoped env. Callers stamp the
    // conversation with it, so a message is bound to the channel it arrived on.
    accountId: env?.ACCOUNT_ID ?? null,
  }
}

/**
 * Facebook LID resolution, shared by the webhook and the sync. When a message's
 * chat_id is a LID ("…@lid"), resolve it to the real @s.whatsapp.net JID via
 * Whapi and return the message with chat_id rewritten; otherwise return the
 * message unchanged.
 *
 * Returns { skip:true } when an @lid cannot be resolved. In that case we cannot
 * identify the contact, so we drop this copy for BOTH directions: an outbound to
 * an unknown recipient is unusable, and an inbound reply also arrives under the
 * real @s.whatsapp.net id, so nothing is lost.
 *
 * `cache` (a Map) memoises lookups so the same LID is fetched at most once per
 * request (webhook) or per run/isolate (sync). It stores nulls too, so an
 * unresolvable LID is not re-queried.
 */
export async function resolveLidChatId(env, msg, cache = null) {
  const chatId = String(msg?.chat_id ?? '')
  if (!/@lid$/i.test(chatId)) return { msg }

  let resolved
  if (cache && cache.has(chatId)) {
    resolved = cache.get(chatId)
  } else {
    resolved = await resolveLid(env, chatId)
    if (cache) cache.set(chatId, resolved)
  }

  if (!resolved) return { skip: true }
  return { msg: { ...msg, chat_id: resolved } }
}

/**
 * Find-or-create by group JID.
 * group_jid is UNIQUE, so one conversation per group no matter how many
 * participants write in. Returns the row; a freshly created one carries
 * __created so the caller can kick off the one-time group sync.
 */
export async function findOrCreateGroup(db, groupJid, businessNumber, chatName, source = null, accountId = null) {
  // Scoped by account: group_jid is unique WITHIN an account (migration 018), so
  // the same WhatsApp group reachable from two connected numbers is two separate
  // conversations — one per account — rather than one shared row that would mix
  // two companies' threads together.
  const existing = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('id, account_id, customer_name, assigned_user_id')
      .eq('group_jid', groupJid)
      .eq('account_id', accountId)
      .maybeSingle()
  )
  if (existing) return existing

  const subject = typeof chatName === 'string' && chatName.trim() ? chatName.trim() : null

  const created = await db
    .from('wp_chat_conversations')
    .insert({
      account_id: accountId,
      is_group: true,
      group_jid: groupJid,
      customer_number: null,
      business_number: businessNumber,
      customer_name: subject,
      unread_count: 0,
      status: 'open',
      created_source: source,
    })
    .select('id, account_id, customer_name, assigned_user_id')
    .single()

  if (created.error) {
    // Two participants wrote at once — take whichever row landed first.
    if (created.error.code === UNIQUE_VIOLATION) {
      const row = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, account_id, customer_name, assigned_user_id')
          .eq('group_jid', groupJid)
          .eq('account_id', accountId)
          .maybeSingle()
      )
      if (row) return row
    }
    throw new Error(created.error.message)
  }
  return { ...created.data, __created: true }
}

/**
 * Find-or-create by customer_number. Fills a blank name only — never clobbers a
 * name a human may have corrected.
 */
export async function findOrCreateConversation(db, customerNumber, businessNumber, customerName, source = null, accountId = null) {
  // Scoped by account — see findOrCreateGroup. The same customer writing to two
  // of the business's numbers is two conversations, one per account.
  const existing = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('id, account_id, customer_name, assigned_user_id')
      .eq('customer_number', customerNumber)
      .eq('account_id', accountId)
      .maybeSingle()
  )

  if (existing) {
    if (customerName && !String(existing.customer_name || '').trim()) {
      unwrap(
        await db
          .from('wp_chat_conversations')
          .update({ customer_name: customerName })
          .eq('id', existing.id)
      )
    }
    return existing
  }

  const created = await db
    .from('wp_chat_conversations')
    .insert({
      account_id: accountId,
      customer_number: customerNumber,
      business_number: businessNumber,
      customer_name: customerName,
      unread_count: 0,
      status: 'open',
      created_source: source,
    })
    .select('id, account_id, customer_name, assigned_user_id')
    .single()

  if (created.error) {
    // (account_id, customer_number) is UNIQUE: another delivery for a brand-new
    // number raced us. Re-read and use theirs — and do NOT claim creation, or
    // both racers would fetch the same avatar.
    if (created.error.code === UNIQUE_VIOLATION) {
      const row = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, account_id, customer_name, assigned_user_id')
          .eq('customer_number', customerNumber)
          .eq('account_id', accountId)
          .maybeSingle()
      )
      if (row) return row
    }
    throw new Error(created.error.message)
  }

  return { ...created.data, __created: true }
}
