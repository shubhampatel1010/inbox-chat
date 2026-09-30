import { getDb, unwrap } from './db.js'
import { fetchProfilePicture } from './whapi.js'
import { uploadObject } from './storage.js'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Download a contact's profile picture and store it in our own bucket.
 *
 * PATH NOTE: stored at `{conversation_id}/avatar-{uuid}.{ext}`, NOT under an
 * `avatars/` prefix. The signed-URL route authorises by parsing the FIRST path
 * segment as a conversation id (functions/api/media/[[path]].js) — an
 * `avatars/…` key would make that Number('avatars') → NaN and 403 every
 * avatar. Keeping the conversation id leading reuses that authorisation
 * exactly, with no change to the media route: an agent can read an avatar
 * precisely when they can read that conversation.
 *
 * Never throws — the caller hands this to waitUntil, so a slow or failing
 * profile fetch must not affect the response. A missing avatar is not an error
 * state for the user; the coloured initials render instead.
 */
export async function ingestAvatar(env, conversationId, customerNumber) {
  const db = getDb(env)

  const markFailed = async (reason) => {
    console.error('avatar fetch failed:', JSON.stringify({
      conversation_id: conversationId,
      reason,
    }))
    try {
      unwrap(
        await db
          .from('wp_chat_conversations')
          .update({ avatar_error: true })
          .eq('id', conversationId)
      )
    } catch {
      /* the flag is a hint; failing to set it must not escalate */
    }
    return { ok: false, reason }
  }

  /**
   * The contact simply has no picture set. That is a normal, common outcome —
   * not a failure — so avatar_error stays false and this logs at info level.
   * Conflating it with a real failure would make avatar_error useless for
   * diagnosing 401s, network errors and upload problems.
   */
  const markNoPicture = async () => {
    console.log('avatar: no profile picture set', JSON.stringify({
      conversation_id: conversationId,
    }))
    try {
      // Explicit rather than relying on the column default, so the function is
      // correct for any caller — including a future refresh that runs against a
      // row where a previous attempt had set the flag.
      unwrap(
        await db
          .from('wp_chat_conversations')
          .update({ avatar_error: false })
          .eq('id', conversationId)
      )
    } catch {
      /* same as above — advisory only */
    }
    return { ok: false, reason: 'profile_no_icon' }
  }

  try {
    const fetched = await fetchProfilePicture(env, customerNumber, MAX_AVATAR_BYTES)
    if (!fetched.ok) {
      return fetched.error === 'profile_no_icon' ? markNoPicture() : markFailed(fetched.error)
    }

    const mime = EXT_BY_MIME[fetched.mime] ? fetched.mime : 'image/jpeg'
    const uploaded = await uploadObject(env, {
      conversationId,
      bytes: fetched.bytes,
      mime,
      filename: `avatar-${crypto.randomUUID()}.${EXT_BY_MIME[mime] || 'jpg'}`,
    })

    if (!uploaded.ok) return markFailed(uploaded.error)

    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({ avatar_path: uploaded.path, avatar_error: false })
        .eq('id', conversationId)
    )

    return { ok: true, path: uploaded.path }
  } catch (err) {
    return markFailed(String(err?.message || 'avatar_failed'))
  }
}
