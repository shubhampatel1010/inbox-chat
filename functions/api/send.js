import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { sendText, sendMedia, toDigits } from '../_lib/whapi.js'
import { readMediaFields, signUrl, MESSAGE_COLUMNS } from '../_lib/storage.js'
import { json, badRequest, serverError, readJson } from '../_lib/respond.js'
import { attachQuoted } from '../_lib/reply.js'
import { envForConversation } from '../_lib/accounts.js'

// Whapi fetches the media itself, so the URL has to outlive the request by a
// comfortable margin.
const OUTBOUND_MEDIA_TTL = 24 * 60 * 60

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const payload = await readJson(request)
  const { conversation_id, body, reply_to } = payload

  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  // Optional. Absent and explicitly-null both mean "not a reply".
  const replyToId = reply_to == null ? null : Number(reply_to)
  if (replyToId !== null && (!Number.isInteger(replyToId) || replyToId <= 0)) {
    return badRequest('reply_to must be a message id')
  }

  const media = readMediaFields(payload)
  const text = typeof body === 'string' ? body.trim() : ''

  // body is nullable now — a message needs text, media, or both.
  if (!text && !media) {
    return badRequest('Message body or an attachment is required')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    const conversation = access.conversation

    const db = getDb(env)
    const now = new Date().toISOString()

    // Send over THIS conversation's account channel. Every Whapi call below
    // takes `accountEnv` rather than `env`, so a reply always leaves from the
    // number the customer wrote to — never from another account's channel.
    const accountEnv = await envForConversation(env, conversation)

    // The conversation's OWN number wins over the env fallback. The original
    // order (env first) was correct when there was one number; with several it
    // would stamp every account's outbound with the legacy number.
    const businessNumber =
      conversation.business_number || toDigits(accountEnv.BUSINESS_NUMBER) || null

    // Whapi's send endpoints take the recipient in `to` either way; for a
    // group that is the JID rather than a bare number. sendText/sendMedia run
    // it through toDigits, which would strip "@g.us", so the JID is passed
    // pre-normalised and toDigits is bypassed for groups.
    const destination = conversation.is_group ? conversation.group_jid : conversation.customer_number

    // (0) Resolve the quoted message, if this is a reply.
    const { rowId: quotedRowId, whapiId: quotedWhapiId } = await resolveQuoted(
      db,
      conversationId,
      replyToId
    )

    // (1) Persist first, so a Whapi failure is visible rather than losing the message.
    const message = unwrap(
      await db
        .from('wp_chat_messages')
        .insert({
          conversation_id: conversationId,
          direction: 'outbound',
          from_number: businessNumber,
          to_number: conversation.is_group ? conversation.group_jid : conversation.customer_number,
          // With media, body carries the caption (or null).
          body: text || null,
          status: 'queued',
          is_read: true,
          sent_by: auth.user.name,
          created_at: now,
          // Both recorded: the row id is what the thread renders from, the
          // whapi id is the durable reference if the quoted row is ever removed.
          reply_to_message_id: quotedRowId,
          reply_to_whapi_id: quotedWhapiId,
          // Outbound media is uploaded before this call, so it is never errored.
          ...(media ? { ...media, media_caption: text || null, media_error: false } : {}),
        })
        .select(MESSAGE_COLUMNS)
        .single()
    )

    // (2) Keep the list preview in sync. Media with no caption gets a label.
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: text || mediaPreviewLabel(media),
          last_message_at: now,
          last_direction: 'outbound',
          updated_at: now,
        })
        .eq('id', conversationId)
    )

    // (3) Hand off to Whapi. Neither send call throws.
    let result
    if (media) {
      // Whapi pulls the bytes from this URL, so it must be reachable without
      // Supabase credentials — hence a signed URL rather than the object path.
      // Storage is system-wide, so this stays on the base env.
      const signed = await signUrl(env, media.media_path, OUTBOUND_MEDIA_TTL)
      result = signed.ok
        ? await sendMedia(accountEnv, destination, {
            mediaUrl: signed.url,
            mediaType: media.media_type,
            caption: text || null,
            filename: media.media_filename,
            mime: media.media_mime,
            quoted: quotedWhapiId,
          })
        : { ok: false, error: signed.error }
    } else {
      result = await sendText(accountEnv, destination, text, { quoted: quotedWhapiId })
    }

    if (result.ok) {
      const patch = { status: 'sent' }
      if (result.messageId) patch.whapi_message_id = result.messageId

      await db.from('wp_chat_messages').update(patch).eq('id', message.id)
      Object.assign(message, patch)
    } else {
      const code = String(result.error || 'send_failed').slice(0, 200)
      await db
        .from('wp_chat_messages')
        .update({ status: 'send_failed', error_code: code })
        .eq('id', message.id)
      message.status = 'send_failed'
      message.error_code = code
    }

    // The client appends this row straight into the open thread rather than
    // refetching, so it needs the same `quoted` block the read path attaches —
    // without it the reply would render unquoted until the next poll.
    if (quotedRowId) await attachQuoted(db, [message], conversation)

    return json({ ok: true, message })
  } catch (err) {
    return serverError(err.message || 'Failed to send message')
  }
}

/**
 * The message a reply quotes: our row id, plus Whapi's id for it.
 *
 * Scoped by conversation_id — without it, any message id in the database could
 * be quoted into any thread the sender has access to, which both leaks that the
 * id exists and would have Whapi quote a message from a different chat.
 *
 * An unresolvable quote returns nulls rather than raising: the message still
 * sends, just unquoted. Refusing the whole send would lose the text the agent
 * actually typed over what is ultimately a decoration.
 */
async function resolveQuoted(db, conversationId, replyToId) {
  const none = { rowId: null, whapiId: null }
  if (replyToId === null) return none

  const quoted = unwrap(
    await db
      .from('wp_chat_messages')
      .select('id, whapi_message_id')
      .eq('id', replyToId)
      .eq('conversation_id', conversationId)
      .maybeSingle()
  )
  if (!quoted) return none

  return {
    rowId: quoted.id,
    // Whapi can only quote a message IT knows about. A row with no whapi id (a
    // send that failed, or one still awaiting its echo) is still recorded as the
    // reply target locally — our thread renders the quote correctly even though
    // WhatsApp shows the message unquoted.
    whapiId: quoted.whapi_message_id || null,
  }
}

function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}
