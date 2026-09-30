// Quoted replies — resolving the message a reply points at.
//
// Two directions, both living here so the read path and the webhook cannot
// drift apart on what a "quote" is:
//
//   quotedIdFromWhapi()  inbound  — Whapi's payload -> their message id
//   attachQuoted()       outbound — our rows -> the compact quote each carries
//
// Deliberately NOT part of ingest.js's shapeInboundMessage(): that function is
// pure and quoted-message resolution needs a database read.

import { unwrap } from './db.js'

/** Longest quoted body sent to the client. The block renders 1-2 lines. */
export const QUOTE_MAX_CHARS = 150

/**
 * Whapi's id for the message this one quotes, or null.
 *
 * The field has moved around across Whapi's versions and is documented
 * inconsistently, so every shape we have seen is probed rather than assuming
 * one. `context.quoted_id` is the current shape; the rest are legacy/variant
 * spellings kept because an unrecognised shape degrades silently to "not a
 * reply", which is indistinguishable from a normal message and would be very
 * hard to notice in production.
 */
export function quotedIdFromWhapi(msg) {
  const context = msg?.context ?? msg?.quoted ?? null

  const candidates = [
    context?.quoted_id,
    context?.quoted_msg_id,
    context?.quotedMsgId,
    context?.quoted_message_id,
    context?.id,
    context?.stanza_id,
    msg?.quoted_id,
    msg?.quoted_msg_id,
  ]

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * The reply_to_* columns for an inbound message, ready to spread into an insert.
 *
 * Returns {} when the message is not a reply, so the caller spreads nothing and
 * both columns keep their defaults.
 *
 * reply_to_whapi_id is set whenever the payload carries a quote, even if the
 * original is not in our database — a backfill walks history newest-first, so
 * the quoted message frequently has not landed yet. Keeping the whapi id means
 * the thread renders the quote block in its "original not available" form
 * instead of losing the fact that the message was a reply at all.
 */
export async function resolveQuotedRef(db, conversationId, msg) {
  const quotedWhapiId = quotedIdFromWhapi(msg)
  if (!quotedWhapiId) return {}

  const original = unwrap(
    await db
      .from('wp_chat_messages')
      .select('id')
      .eq('whapi_message_id', quotedWhapiId)
      .eq('conversation_id', conversationId)
      .maybeSingle()
  )

  return {
    reply_to_message_id: original?.id ?? null,
    reply_to_whapi_id: quotedWhapiId,
  }
}

/** One-line preview of a quoted row: its text, or a label naming its media. */
export function quotePreview(row) {
  const text = row?.body || row?.media_caption || ''
  if (text) return text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text
  return null
}

/**
 * Who a quoted row should be labelled as.
 *
 * Mirrors the rule Thread.jsx uses for the messages themselves, so a message
 * and a quote of it never carry different names.
 *
 * The 1:1 case is why `conversation` is needed at all: sender_number and
 * sender_name are written ONLY for group messages (in a 1:1 the conversation
 * already identifies the other party), so an inbound 1:1 row has neither and
 * the only place its name exists is on the conversation.
 */
function quotedSenderName(row, conversation) {
  if (row.direction === 'outbound') return row.sent_by || 'You'

  // Group participant: their own name, else their number.
  const participant = row.sender_name || (row.sender_number ? `+${row.sender_number}` : null)
  if (participant) return participant

  // 1:1 inbound: the customer. Falls back to their number, formatted the same
  // way a participant's is, so the two never look like different kinds of thing.
  const customerName = conversation?.customer_name?.trim()
  if (customerName) return customerName
  return conversation?.customer_number ? `+${conversation.customer_number}` : null
}

/**
 * Attach a `quoted` object to every message in `messages` that is a reply.
 *
 * One extra query per page, not per message: the ids are collected and read
 * back in a single `in (...)`. Mutates and returns the array.
 *
 * The quote carries only what the block renders — who wrote it, a truncated
 * body, and the media type for the "[Photo]" style label. Never the full
 * message: a quoted row can be arbitrarily long and may hold media the reader
 * of THIS page has no other reason to load.
 *
 * `conversation` supplies the customer's name for quotes of inbound 1:1
 * messages, which carry no per-message sender of their own. Optional — omitting
 * it degrades the label to the customer's number, never to a crash.
 *
 * A reply whose original is not in our database still gets a `quoted` object,
 * with `found: false`. That is what lets the thread render "Original message"
 * instead of dropping the quote entirely — the reply visibly IS a reply either
 * way, and hiding that would misrepresent the conversation.
 */
export async function attachQuoted(db, messages, conversation = null) {
  const list = Array.isArray(messages) ? messages : []

  const ids = [...new Set(list.map((m) => m?.reply_to_message_id).filter(Boolean))]

  // Rows resolved to one of our own messages. Anything referenced only by
  // whapi id stays unresolved and falls through to the `found: false` branch.
  let byId = new Map()
  if (ids.length) {
    const rows =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select('id, body, media_type, media_caption, direction, sender_name, sender_number, sent_by')
          .in('id', ids)
      ) || []
    byId = new Map(rows.map((row) => [String(row.id), row]))
  }

  for (const message of list) {
    if (!message?.reply_to_message_id && !message?.reply_to_whapi_id) continue

    const row = message.reply_to_message_id
      ? byId.get(String(message.reply_to_message_id))
      : null

    if (!row) {
      // Referenced but unresolvable — quoted before our backfill, or deleted.
      message.quoted = { found: false }
      continue
    }

    message.quoted = {
      found: true,
      id: row.id,
      sender_name: quotedSenderName(row, conversation),
      sender_number: row.sender_number ?? null,
      direction: row.direction,
      body: quotePreview(row),
      media_type: row.media_type ?? null,
    }
  }

  return list
}
