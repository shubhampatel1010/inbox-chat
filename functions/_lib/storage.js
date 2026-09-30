import { serviceKey } from './db.js'
import { drainBody } from './http.js'

// Supabase Storage over the plain REST API — no SDK on this path, so nothing
// extra is pulled into the Worker bundle for uploads.

export const BUCKET = 'wp-chat-media'

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 // 16MB

/** mime -> {type, ext}. Anything not listed here is rejected outright. */
export const ALLOWED_MIME = {
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/png': { type: 'image', ext: 'png' },
  'image/webp': { type: 'image', ext: 'webp' },
  'image/gif': { type: 'image', ext: 'gif' },
  'application/pdf': { type: 'document', ext: 'pdf' },
  'application/msword': { type: 'document', ext: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    type: 'document',
    ext: 'docx',
  },
  'application/vnd.ms-excel': { type: 'document', ext: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    type: 'document',
    ext: 'xlsx',
  },
  'text/plain': { type: 'document', ext: 'txt' },
  'text/csv': { type: 'document', ext: 'csv' },
  // Media types are uploadable but still render as chips — no players.
  'video/mp4': { type: 'video', ext: 'mp4' },
  'audio/mpeg': { type: 'audio', ext: 'mp3' },
  'audio/ogg': { type: 'audio', ext: 'ogg' },
  'audio/mp4': { type: 'audio', ext: 'm4a' },
  'audio/webm': { type: 'audio', ext: 'webm' },
}

/** Whapi message type -> our media_type. */
export function mediaTypeFromWhapi(type, mime) {
  if (type === 'image' || type === 'sticker') return 'image'
  if (type === 'video' || type === 'gif') return 'video'
  if (type === 'audio' || type === 'voice' || type === 'ptt') return 'audio'
  if (type === 'document') return 'document'

  const m = String(mime || '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

export const MEDIA_TYPES = ['image', 'document', 'video', 'audio']

function storageBase(env) {
  const key = serviceKey(env)
  if (!env?.SUPABASE_URL || !key) {
    throw new Error('SUPABASE_URL / service key are not configured')
  }
  return {
    url: `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1`,
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  }
}

/** Strip anything that could escape the conversation's folder. */
export function safeExt(filename, mime) {
  const fromName = String(filename || '').split('.').pop()
  if (fromName && /^[a-zA-Z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  return ALLOWED_MIME[mime]?.ext || 'bin'
}

/**
 * Upload bytes to {conversation_id}/{uuid}.{ext}.
 * Returns {ok, path, error} — never throws.
 */
export async function uploadObject(env, { conversationId, bytes, mime, filename }) {
  try {
    const { url, headers } = storageBase(env)
    const path = `${conversationId}/${crypto.randomUUID()}.${safeExt(filename, mime)}`

    const res = await fetch(`${url}/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': mime,
        'Cache-Control': 'max-age=3600',
        // Never overwrite: the path is a fresh uuid, so a collision is a bug.
        'x-upsert': 'false',
      },
      body: bytes,
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      return { ok: false, error: `storage_${res.status}: ${detail}` }
    }
    // Supabase returns a small JSON ack we don't use; drain it so the upload's
    // connection is released (this fires on every synced attachment).
    await drainBody(res)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'upload_failed') }
  }
}

/**
 * Mint a signed URL for a private object.
 * Returns {ok, url, error} — never throws.
 */
export async function signUrl(env, path, expiresInSeconds = 3600) {
  try {
    const { url, headers } = storageBase(env)

    const res = await fetch(`${url}/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      return { ok: false, error: `sign_${res.status}: ${detail}` }
    }

    const data = await res.json()
    // The API returns a root-relative path like "/object/sign/bucket/x?token=…"
    const signed = data?.signedURL || data?.signedUrl
    if (!signed) return { ok: false, error: 'sign_no_url' }

    return { ok: true, url: signed.startsWith('http') ? signed : `${url}${signed}` }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'sign_failed') }
  }
}

/** Normalizes and validates the media fields that arrive on a message write. */
export function readMediaFields(source) {
  const path = typeof source?.media_path === 'string' ? source.media_path.trim() : ''
  if (!path) return null

  const type = MEDIA_TYPES.includes(source?.media_type) ? source.media_type : 'document'
  const size = Number(source?.media_size)

  return {
    media_path: path,
    media_type: type,
    media_mime: source?.media_mime ? String(source.media_mime).slice(0, 255) : null,
    media_filename: source?.media_filename ? String(source.media_filename).slice(0, 255) : null,
    media_size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
    media_caption: source?.media_caption ? String(source.media_caption) : null,
    // A supplied path means the bytes are already in the bucket.
    media_error: source?.media_error === true,
  }
}

/** Columns selected wherever a message row is returned. */
export const MESSAGE_COLUMNS = `id, conversation_id, direction, from_number, to_number, body,
   whapi_message_id, status, error_code, is_read, sent_by, created_at,
   media_path, media_type, media_mime, media_filename, media_size, media_caption,
   media_error, sender_number, sender_name, reply_to_message_id, reply_to_whapi_id`
