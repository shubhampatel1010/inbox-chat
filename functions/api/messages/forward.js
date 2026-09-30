import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { sendText, sendMedia, toDigits } from '../../_lib/whapi.js'
import { signUrl, MESSAGE_COLUMNS } from '../../_lib/storage.js'
import { envForConversation } from '../../_lib/accounts.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

// Forward existing messages into other conversations.
//
// A forward is a NEW outbound message, not a reference to the original: the
// bytes already live in our bucket, so each target gets its own row pointing at
// the SAME media_path. Nothing is re-uploaded and the original is untouched.
//
// The per-target sequence deliberately mirrors /api/send — persist first, then
// hand to Whapi, then patch the outcome onto the row — so a Whapi failure is
// visible in the thread as a failed message rather than vanishing.

// Matches /api/send: Whapi fetches media itself, so the URL must outlive the
// request comfortably.
const OUTBOUND_MEDIA_TTL = 24 * 60 * 60

// Caps on one request. A forward fans out to (messages x targets) Whapi calls,
// each a subrequest, and Workers bound how many a single request may make.
// These keep the worst case well inside that budget.
const MAX_MESSAGES = 30
const MAX_TARGETS = 20

/** Parse a JSON array of positive integer ids, de-duplicated, order preserved. */
function readIds(value) {
  if (!Array.isArray(value)) return null
  const seen = new Set()
  for (const raw of value) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) return null
    seen.add(n)
  }
  return [...seen]
}

function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/**
 * Deliver ONE source message into ONE target conversation.
 * Returns {ok, error} and never throws — one bad pairing must not abort the
 * rest of the fan-out, so every caller can keep going and report per-item.
 */
async function forwardOne(env, db, source, target, agentName) {
  const now = new Date().toISOString()

  // Scoped PER TARGET, not once for the whole fan-out: forwarding one message
  // into conversations on two different accounts must send each copy over its
  // own account's channel. requireConversationAccess has already confirmed the
  // caller may reach every target.
  const accountEnv = await envForConversation(env, target)

  // The target's own number wins over the env fallback — see /api/send.
  const businessNumber =
    target.business_number || toDigits(accountEnv.BUSINESS_NUMBER) || null
  const destination = target.is_group ? target.group_jid : target.customer_number

  const hasMedia = Boolean(source.media_path)
  // The caption travels with the message. On a media row the text may live in
  // either column depending on how it was ingested.
  const text = (hasMedia ? source.body || source.media_caption : source.body) || ''

  // (1) Persist first, exactly as /api/send does, so a Whapi failure leaves a
  //     visible failed message rather than losing the forward silently.
  const message = unwrap(
    await db
      .from('wp_chat_messages')
      .insert({
        conversation_id: target.id,
        direction: 'outbound',
        from_number: businessNumber,
        to_number: destination,
        body: text || null,
        status: 'queued',
        is_read: true,
        sent_by: agentName,
        created_at: now,
        // Point at the SAME stored object as the original. The bucket is not
        // per-conversation-authorised — /api/media signs by path — so sharing
        // the path is safe and avoids re-uploading bytes we already hold.
        ...(hasMedia
          ? {
              media_path: source.media_path,
              media_type: source.media_type,
              media_mime: source.media_mime,
              media_filename: source.media_filename,
              media_size: source.media_size,
              media_caption: text || null,
              media_error: false,
            }
          : {}),
      })
      .select(MESSAGE_COLUMNS)
      .single()
  )

  // (2) Keep the target's list preview in sync.
  unwrap(
    await db
      .from('wp_chat_conversations')
      .update({
        last_message_body: text || mediaPreviewLabel(source),
        last_message_at: now,
        last_direction: 'outbound',
        updated_at: now,
      })
      .eq('id', target.id)
  )

  // (3) Hand off to Whapi. Neither send call throws.
  let result
  if (hasMedia) {
    // Storage is system-wide, so this stays on the base env.
    const signed = await signUrl(env, source.media_path, OUTBOUND_MEDIA_TTL)
    result = signed.ok
      ? await sendMedia(accountEnv, destination, {
          mediaUrl: signed.url,
          mediaType: source.media_type,
          caption: text || null,
          filename: source.media_filename,
          mime: source.media_mime,
        })
      : { ok: false, error: signed.error }
  } else {
    result = await sendText(accountEnv, destination, text)
  }

  if (result.ok) {
    const patch = { status: 'sent' }
    if (result.messageId) patch.whapi_message_id = result.messageId
    await db.from('wp_chat_messages').update(patch).eq('id', message.id)
    return { ok: true, message: { ...message, ...patch } }
  }

  const code = String(result.error || 'send_failed').slice(0, 200)
  await db
    .from('wp_chat_messages')
    .update({ status: 'send_failed', error_code: code })
    .eq('id', message.id)

  return { ok: false, error: code, message: { ...message, status: 'send_failed', error_code: code } }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const payload = await readJson(request)

  const messageIds = readIds(payload?.message_ids)
  const targetIds = readIds(payload?.target_conversation_ids)

  if (!messageIds?.length) return badRequest('message_ids is required')
  if (!targetIds?.length) return badRequest('target_conversation_ids is required')
  if (messageIds.length > MAX_MESSAGES) {
    return badRequest(`Cannot forward more than ${MAX_MESSAGES} messages at once`)
  }
  if (targetIds.length > MAX_TARGETS) {
    return badRequest(`Cannot forward to more than ${MAX_TARGETS} chats at once`)
  }

  try {
    const db = getDb(env)

    // Load the sources. Selecting by id set in one round trip, then ordering to
    // the caller's sequence, so a multi-message forward arrives in thread order
    // rather than in whatever order PostgREST returns.
    const sources = unwrap(
      await db.from('wp_chat_messages').select(MESSAGE_COLUMNS).in('id', messageIds)
    )

    if (sources.length !== messageIds.length) {
      return badRequest('One or more messages no longer exist')
    }

    // Authorise every SOURCE conversation: forwarding reads a message out of a
    // thread, so the same access rule that guards reading it applies here.
    for (const conversationId of new Set(sources.map((m) => m.conversation_id))) {
      const access = await requireConversationAccess(env, auth.user, conversationId)
      if (access.response) return access.response
    }

    // Authorise every TARGET, and keep the row — the send needs its number/JID.
    const targets = []
    for (const id of targetIds) {
      const access = await requireConversationAccess(env, auth.user, id)
      if (access.response) return access.response
      targets.push(access.conversation)
    }

    // Media whose bytes never landed cannot be forwarded — there is nothing for
    // Whapi to fetch. Rejected up front, as a whole, so the user gets one clear
    // error instead of a partial fan-out they must reason about.
    const expired = sources.filter((m) => m.media_error || (m.media_type && !m.media_path))
    if (expired.length) {
      return badRequest('Media unavailable — cannot forward')
    }

    const ordered = messageIds.map((id) => sources.find((m) => m.id === id))

    // Sequential on purpose. Whapi rate-limits, and a burst of parallel sends
    // to the same channel is the reliable way to trip it; ordering also has to
    // hold within each target thread.
    let forwarded = 0
    const failures = []
    const created = []

    for (const target of targets) {
      for (const source of ordered) {
        try {
          const result = await forwardOne(env, db, source, target, auth.user.name)
          created.push(result.message)
          if (result.ok) forwarded++
          else failures.push({ conversation_id: target.id, message_id: source.id, error: result.error })
        } catch (err) {
          // A DB failure on one pairing (not a Whapi rejection, which
          // forwardOne already absorbs) — record and continue.
          failures.push({
            conversation_id: target.id,
            message_id: source.id,
            error: String(err?.message || 'forward_failed'),
          })
        }
      }
    }

    // 200 with counts even on partial failure: rows were created and some sends
    // landed, so this is not an error the client should retry wholesale. The
    // client surfaces `failed` and the per-thread failed bubbles show the rest.
    return json({
      ok: true,
      success: failures.length === 0,
      forwarded,
      failed: failures.length,
      failures: failures.slice(0, 10),
      messages: created,
    })
  } catch (err) {
    return serverError(err.message || 'Failed to forward messages')
  }
}
