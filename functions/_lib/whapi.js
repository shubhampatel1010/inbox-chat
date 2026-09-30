// Direct Whapi integration. The app calls Whapi itself — there is no n8n hop.

import { drainBody } from './http.js'

const DEFAULT_API_URL = 'https://gate.whapi.cloud'

export function whapiConfig(env) {
  if (!env?.WHAPI_TOKEN) throw new Error('WHAPI_TOKEN is not configured')
  return {
    token: env.WHAPI_TOKEN,
    apiUrl: String(env.WHAPI_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  }
}

/** Digits only — strips a `@s.whatsapp.net` suffix, spaces, plus signs. */
export const toDigits = (value) => String(value ?? '').split('@')[0].replace(/\D/g, '')

/**
 * Recipient for a send.
 *
 * A group JID must survive intact — toDigits() would strip "@g.us" and leave a
 * bare id Whapi cannot route. Anything else is normalised to bare digits as
 * before.
 */
export function recipientFor(value) {
  const raw = String(value ?? '').trim()
  if (/@g\.us$/i.test(raw)) return raw
  return toDigits(raw)
}

// ---------------------------------------------------------------------------
// Facebook LID (Linked ID) resolution.
//
// GHL/Meta-delivered 1:1 messages can arrive with a Facebook Linked ID as the
// chat_id, suffixed "@lid" (e.g. "250388305424512@lid"), which is not a phone
// number. Whapi resolves it to the real JID:
//   GET /contacts/ids/{LID}  ->  { "id": "919425344605@s.whatsapp.net" }
// The callers rewrite chat_id with the resolved id, or skip when it cannot be
// resolved. Detection is purely the "@lid" suffix — no number heuristics.
// ---------------------------------------------------------------------------

/**
 * Resolve a Facebook LID (e.g. "250388305424512@lid") to its real
 * @s.whatsapp.net JID via GET /contacts/ids/{LID}. Returns the resolved id
 * string, or null when Whapi cannot resolve it (or the call fails). Never throws.
 */
export async function resolveLid(env, lid) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const res = await fetch(`${apiUrl}/contacts/ids/${encodeURIComponent(lid)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data?.id || null
  } catch {
    return null
  }
}

/** Whapi has a distinct endpoint per media kind. */
const MEDIA_ENDPOINT = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
}

/**
 * Send a text message.
 * Resolves to {ok, messageId, error} — never throws, so a Whapi outage can't
 * take down /api/send after the row has already been persisted.
 *
 * `quoted` is Whapi's OWN id for the message being replied to (our row ids mean
 * nothing to them). Omitted entirely when absent — sending `quoted: null` is
 * rejected by some Whapi versions as a malformed field, which would turn a
 * quote we could not resolve into a failed send rather than a plain message.
 */
export async function sendText(env, to, body, { quoted = null } = {}) {
  return post(env, 'messages/text', {
    // Bare digits for a 1:1, e.g. "13135555657"; the full JID for a group.
    to: recipientFor(to),
    body,
    ...(quoted ? { quoted } : {}),
  })
}

/**
 * Send a media message. `mediaUrl` must be publicly fetchable by Whapi for the
 * life of the request — /api/send passes a 24h Supabase signed URL.
 * Same never-throws contract as sendText, and the same `quoted` handling.
 */
export async function sendMedia(env, to, { mediaUrl, mediaType, caption, filename, mime, quoted }) {
  const endpoint = MEDIA_ENDPOINT[mediaType] || 'document'

  const payload = { to: recipientFor(to), media: mediaUrl }
  if (caption) payload.caption = caption
  if (quoted) payload.quoted = quoted
  // Whapi uses the filename as the document's display name.
  if (endpoint === 'document') {
    if (filename) payload.filename = filename
    if (mime) payload.mime_type = mime
  }

  return post(env, `messages/${endpoint}`, payload)
}

/**
 * Download an inbound attachment's bytes from Whapi.
 * Resolves to {ok, bytes, mime, error} — never throws.
 */
export async function fetchMedia(env, mediaId, maxBytes = Infinity) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    if (!mediaId) return { ok: false, error: 'media_no_id' }

    const res = await fetch(`${apiUrl}/media/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120)
      return { ok: false, error: `media_fetch_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    // Trust Content-Length when present so an oversized body is rejected before
    // it is buffered into the isolate's memory.
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainBody(res)
      return { ok: false, error: 'media_too_large' }
    }

    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'media_too_large' }
    if (bytes.byteLength === 0) return { ok: false, error: 'media_empty' }

    const mime = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()

    return { ok: true, bytes, mime: mime || null }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'media_fetch_failed') }
  }
}

// Hosts a media `link` may point at. Whapi stores attachments on Wasabi S3 and
// serves them from its own domain; the allow-list is what stops a crafted
// webhook payload from turning this into an SSRF against an internal address.
// Extend it here if Whapi changes its storage host.
const MEDIA_LINK_HOSTS = /(?:^|\.)(wasabisys\.com|whapi\.cloud)$/i

/**
 * Download an attachment straight from its direct storage `link` (the
 * wasabisys S3 URL Whapi puts alongside the media id), bypassing /media/{id}.
 *
 * This is the recovery path for OLD messages whose /media/{id} has expired: the
 * link may outlive it. Strictly additive — only tried after the id fetch fails,
 * and if the link fails too the result is the same media_error as before.
 *
 * https-only and host-allow-listed (the URL comes from an inbound payload, so
 * it is not fully trusted). Resolves to {ok, bytes, mime, error}. Never throws.
 */
export async function fetchMediaUrl(link, maxBytes = Infinity) {
  try {
    let u
    try {
      u = new URL(String(link))
    } catch {
      return { ok: false, error: 'media_link_bad_url' }
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'media_link_not_https' }
    if (!MEDIA_LINK_HOSTS.test(u.hostname)) {
      return { ok: false, error: `media_link_host_blocked:${u.hostname}` }
    }

    const res = await fetch(u.toString(), { headers: { Accept: '*/*' } })
    if (!res.ok) {
      await drainBody(res)
      return { ok: false, error: `media_link_${res.status}` }
    }

    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainBody(res)
      return { ok: false, error: 'media_too_large' }
    }

    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'media_too_large' }
    if (bytes.byteLength === 0) return { ok: false, error: 'media_empty' }

    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim()
    return { ok: true, bytes, mime: mime || null }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'media_link_failed') }
  }
}

async function post(env, endpointPath, payload) {
  try {
    const { token, apiUrl } = whapiConfig(env)

    const res = await fetch(`${apiUrl}/${endpointPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })

    // Read the body once, defensively — errors are not always JSON.
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      /* non-JSON response */
    }

    if (!res.ok) {
      const detail = data?.error?.message || data?.message || raw?.slice(0, 120) || ''
      return { ok: false, error: `whapi_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    // Expected: { sent: true, message: { id: "..." } }. Shape varies, so probe
    // a couple of spots and just skip the id if it isn't there.
    const messageId = data?.message?.id ?? data?.id ?? null

    return { ok: true, messageId: messageId ? String(messageId) : null }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'whapi_request_failed') }
  }
}

/**
 * Contact profile picture.
 *
 * Whapi returns temporary pps.whatsapp.net URLs carrying an `oe=` expiry, so
 * the bytes must be downloaded and re-hosted — never stored or hotlinked.
 * We take `icon` (96x96) rather than `icon_full`: avatars render at 42px.
 *
 * Resolves to {ok, bytes, mime, error} — never throws. A disconnected channel
 * answers 401 "need channel authorization", which is a normal failure here.
 */
export async function fetchProfilePicture(env, chatId, maxBytes = 2 * 1024 * 1024) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = toDigits(chatId)
    if (!id) return { ok: false, error: 'profile_no_id' }

    const res = await fetch(`${apiUrl}/contacts/${encodeURIComponent(id)}/profile`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120)
      return { ok: false, error: `profile_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    const data = await res.json().catch(() => null)
    const icon = data?.icon
    // No picture set is the common case, not an error worth shouting about.
    if (!icon || typeof icon !== 'string') return { ok: false, error: 'profile_no_icon' }

    const img = await fetch(icon)
    if (!img.ok) {
      await drainBody(img)
      return { ok: false, error: `profile_image_${img.status}` }
    }

    const declared = Number(img.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainBody(img)
      return { ok: false, error: 'profile_too_large' }
    }

    const bytes = await img.arrayBuffer()
    if (bytes.byteLength === 0) return { ok: false, error: 'profile_empty' }
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'profile_too_large' }

    const mime = String(img.headers.get('content-type') || '').split(';')[0].trim()
    return { ok: true, bytes, mime: mime || 'image/jpeg' }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'profile_fetch_failed') }
  }
}

/**
 * Channel health.
 *
 * Keys on status.text === 'AUTH', NOT the numeric code: Whapi's live response
 * reports AUTH as code 4 while their documentation lists it as 5 (and lists 5
 * as ERROR elsewhere). The text is the only field both agree on. Anything we
 * cannot positively identify as AUTH counts as disconnected.
 *
 * Never throws — an unreachable Whapi is itself a disconnected state.
 *
 * With { wakeup: true } this becomes the documented "Check health & launch
 * channel" call — GET /health?wakeup=true — which asks Whapi to (re)launch a
 * sleeping/disconnected channel. The default is OFF so the passive 60s status
 * poll stays a pure read and only an explicit admin action launches anything.
 */
export async function checkHealth(env, { wakeup = false } = {}) {
  const checkedAt = new Date().toISOString()
  try {
    const { token, apiUrl } = whapiConfig(env)

    // channel_type=web — link an EXISTING WhatsApp account via WA Web (the QR
    // flow), never create a new mobile account.
    const url = wakeup ? `${apiUrl}/health?wakeup=true&channel_type=web` : `${apiUrl}/health`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      await drainBody(res)
      return {
        connected: false,
        status: `http_${res.status}`,
        uptime: null,
        checked_at: checkedAt,
        error: `health_${res.status}`,
      }
    }

    const data = await res.json().catch(() => null)
    const text = data?.status?.text ? String(data.status.text).toUpperCase() : null

    return {
      connected: text === 'AUTH',
      status: text || 'UNKNOWN',
      code: data?.status?.code ?? null,
      uptime: Number.isFinite(Number(data?.uptime)) ? Number(data.uptime) : null,
      channel_id: data?.channel_id ?? null,
      checked_at: checkedAt,
    }
  } catch (err) {
    return {
      connected: false,
      status: 'UNREACHABLE',
      uptime: null,
      checked_at: checkedAt,
      error: String(err?.message || 'health_failed'),
    }
  }
}

/**
 * Ask Whapi to (re)launch the channel, then report its health. Some
 * disconnections recover from this alone, with no QR scan. Never throws.
 */
export const launchChannel = (env) => checkHealth(env, { wakeup: true })

/** ArrayBuffer -> base64, chunked so a large image cannot blow the call stack. */
function base64FromBytes(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Fetch the WhatsApp-Web login QR from Whapi and return it as a self-contained
 * data URL, so the browser renders an <img> with NO QR library and the
 * WHAPI_TOKEN never leaves the Worker.
 *
 * GET /users/login — the JSON endpoint. It answers
 *   { status:"OK", type:"qr", expire:19, base64:"data:image/png;base64,…" }
 * where `base64` is already a complete data URL. Chosen over /users/login/image,
 * which intermittently 500s even at the QR-ready state. Status 409 (or an AUTH
 * body) means already authenticated, surfaced as { alreadyAuthed }.
 *
 * Resolves to { ok, dataUrl, expiresIn } | { ok:false, alreadyAuthed }
 * | { ok:false, status, body, error }. Never throws.
 */
export async function fetchLoginQr(env, { size = 400, wakeup = false } = {}) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    // size is accepted for signature compatibility; the JSON login endpoint
    // returns a ready-to-render base64 QR and does not need it.
    const qs = new URLSearchParams()
    if (wakeup) qs.set('wakeup', 'true')
    const url = `${apiUrl}/users/login?${qs}`

    // Log the EXACT outbound request (token is header-only, never logged).
    console.log(
      'whapi QR request',
      JSON.stringify({ method: 'GET', url, accept: 'application/json', authorization: 'Bearer <redacted>' })
    )

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    // 409 = "Channel already authenticated" — not an error, just no QR needed.
    if (res.status === 409) {
      await drainBody(res)
      return { ok: false, alreadyAuthed: true, status: 409 }
    }
    if (!res.ok) {
      // Keep the raw body (widened to 400 chars) so the caller can surface
      // EXACTLY what Whapi returned — status + body — not just a code.
      const detail = (await res.text()).slice(0, 400)
      console.error('whapi QR failed', JSON.stringify({ status: res.status, body: detail }))
      return { ok: false, status: res.status, body: detail || null, error: `qr_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    const data = await res.json().catch(() => null)
    const type = String(data?.type || '').toLowerCase()
    const statusText = String(data?.status || '').toUpperCase()

    // Some builds report an already-linked channel here instead of via 409.
    if (statusText === 'AUTH' || type === 'auth') {
      return { ok: false, alreadyAuthed: true, status: 200 }
    }

    // Expected QR shape: base64 is a complete data:image/png URL, ready to render.
    const b64 = typeof data?.base64 === 'string' ? data.base64 : null
    if (type === 'qr' && b64) {
      const dataUrl = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`
      const expire = Number(data?.expire)
      return { ok: true, dataUrl, expiresIn: Number.isFinite(expire) && expire > 0 ? Math.floor(expire) : null }
    }

    // OK response without a usable QR — surface the shape so it stays diagnosable.
    const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data
    return {
      ok: false,
      status: 200,
      body: `login_without_qr: status=${data?.status ?? null} type=${data?.type ?? null} keys=${keys}`,
      error: 'qr_no_data',
    }
  } catch (err) {
    // Transport failure (no HTTP status) — carry the message as the body.
    return { ok: false, status: null, body: String(err?.message || 'transport_error'), error: String(err?.message || 'qr_failed') }
  }
}

// ---------------------------------------------------------------------------
// Group / broadcast detection
//
// This app is 1:1 only. A group message must never create a conversation —
// previously it did, keyed on the SENDER's personal number, so one group with
// two participants produced two unrelated conversations.
// ---------------------------------------------------------------------------

/** JID suffixes that are never a 1:1 chat. */
const NON_DIRECT_SUFFIXES = ['@g.us', '@broadcast', '@newsletter', '@lid']

/**
 * Identifier fields that may carry a JID.
 *
 * Deliberately excludes body/text/caption: a customer can legitimately TYPE
 * "@g.us", and dropping their message because of that would be worse than the
 * bug this fixes.
 */
const ID_FIELDS = [
  'chat_id', 'chatId', 'from', 'to', 'author', 'participant',
  'recipient', 'group_id', 'groupId', 'source',
]

// E.164 caps a real phone number at 15 digits. A WhatsApp group id is 18+,
// so anything longer is a group whose suffix was stripped upstream.
const MAX_E164_DIGITS = 15

function idCandidates(msg) {
  const out = []
  for (const key of ID_FIELDS) {
    const v = msg?.[key]
    if (typeof v === 'string' && v) out.push([key, v])
  }
  // Nested shapes Whapi has used for the chat object.
  for (const [parent, key] of [['chat', 'id'], ['group', 'id'], ['chat', 'jid']]) {
    const v = msg?.[parent]?.[key]
    if (typeof v === 'string' && v) out.push([`${parent}.${key}`, v])
  }
  return out
}

/**
 * Returns the reasons a message looks like a group/broadcast, or [] if it is a
 * genuine 1:1 chat. Checks EVERY identifier field rather than one, because
 * Whapi puts the group JID in chat_id while `from` holds the individual
 * sender — checking only one field is exactly how this slipped through.
 */
export function groupEvidence(msg) {
  const reasons = []

  // Explicit flags, if the payload carries them.
  if (msg?.is_group === true) reasons.push('is_group=true')
  if (typeof msg?.chat_type === 'string' && /group|broadcast|newsletter/i.test(msg.chat_type)) {
    reasons.push(`chat_type=${msg.chat_type}`)
  }

  for (const [key, raw] of idCandidates(msg)) {
    const value = raw.toLowerCase()

    for (const suffix of NON_DIRECT_SUFFIXES) {
      if (value.endsWith(suffix) || value.includes(`${suffix}:`)) {
        reasons.push(`${key} ends with ${suffix}`)
      }
    }

    const local = raw.split('@')[0]

    // Legacy group ids look like <creator>-<timestamp>.
    if (/^\d{5,}-\d{5,}$/.test(local)) reasons.push(`${key} is a legacy group id`)

    // Suffix already stripped: too long to be a phone number.
    const digits = local.replace(/\D/g, '')
    if (digits.length > MAX_E164_DIGITS) {
      reasons.push(`${key} has ${digits.length} digits, over the E.164 maximum`)
    }
  }

  return [...new Set(reasons)]
}

export const isGroupMessage = (msg) => groupEvidence(msg).length > 0

/**
 * Whole payload for diagnosis, with anything credential-shaped masked.
 * Group payloads are rare and the field layout is what we need to see.
 */
export function redactPayload(value) {
  // Anchored: a bare substring match on "auth" also hits "author", which is a
  // group-sender field we specifically need to READ when diagnosing a leak.
  const SECRET_KEY = /^(token|authorization|auth|secret|apikey|api_key|password|passwd|pwd)$/i
  const SECRET_SUFFIX = /(_token|_secret|_key|_password)$/i
  const isSecret = (k) => SECRET_KEY.test(k) || SECRET_SUFFIX.test(k)
  const walk = (node, depth = 0) => {
    if (depth > 6 || node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1))
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = isSecret(k) ? '[REDACTED]' : walk(v, depth + 1)
    }
    return out
  }
  return walk(value)
}

/**
 * The canonical group JID for a message, or null for a 1:1 chat.
 *
 * Reuses the SAME field sweep as groupEvidence() rather than adding a second
 * detection path — chat_id normally carries it, but Whapi has put it in other
 * fields, which is how the one-conversation-per-sender bug happened.
 */
export function groupJidOf(msg) {
  if (!isGroupMessage(msg)) return null

  for (const [, raw] of idCandidates(msg)) {
    const value = String(raw)
    if (/@g\.us$/i.test(value)) return value.toLowerCase()
  }

  // Suffix already stripped upstream: rebuild it from the over-long id so the
  // stored JID is always canonical.
  for (const [, raw] of idCandidates(msg)) {
    const local = String(raw).split('@')[0]
    const digits = local.replace(/\D/g, '')
    if (digits.length > MAX_E164_DIGITS || /^\d{5,}-\d{5,}$/.test(local)) {
      return `${local}@g.us`
    }
  }
  return null
}

/** Bare group id for URL paths — Whapi wants the full JID including @g.us. */
export const groupIdForApi = (jid) => String(jid || '').trim()

/**
 * Account-level HTTP failures — they affect the whole channel, not one chat, so
 * an auto-sync must halt (not retry every poll) rather than skip and continue.
 * 402 = quota/payment. Kept deliberately narrow so a transient per-resource 4xx
 * does not wrongly halt everything.
 */
export const isAccountError = (status) => status === 402

// ---------------------------------------------------------------------------
// History listing — used ONLY by the admin sync/backfill, never live.
//
// Endpoints per Whapi's REST reference:
//   GET /messages/list/{ChatID}  — messages in a chat
//   GET /chats                   — the account's chats
//
// Both are paged with count/offset and return arrays of the SAME message /
// chat shapes the webhook already understands, which is what lets the sync
// feed straight into shapeInboundMessage(). Field access is defensive because
// this could not be exercised against live Whapi here.
// ---------------------------------------------------------------------------

/**
 * GET /messages/list/{ChatID}
 *
 * @param chatId  a JID: "<digits>@s.whatsapp.net" for 1:1, "<id>@g.us" for a group
 * @param opts    { offset, count, timeFrom, timeTo }  (unix SECONDS for the times)
 * Resolves to { ok, messages, total, error } — never throws.
 */
export async function listMessages(env, chatId, { offset = 0, count = 100, timeFrom, timeTo } = {}) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = String(chatId || '').trim()
    if (!id) return { ok: false, error: 'list_no_chat', messages: [] }

    const qs = new URLSearchParams({ count: String(count), offset: String(offset) })
    if (Number.isFinite(Number(timeFrom))) qs.set('time_from', String(Math.floor(timeFrom)))
    if (Number.isFinite(Number(timeTo))) qs.set('time_to', String(Math.floor(timeTo)))

    const res = await fetch(`${apiUrl}/messages/list/${encodeURIComponent(id)}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160)
      return {
        ok: false,
        error: `list_${res.status}${detail ? `: ${detail}` : ''}`,
        // 402 (and other account-level failures) affect the whole account, not
        // one chat — the caller must halt rather than skip-and-continue.
        accountError: isAccountError(res.status),
        status: res.status,
        messages: [],
      }
    }

    const data = await res.json().catch(() => null)
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null
    return { ok: true, messages, total }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'list_failed'), messages: [] }
  }
}

/**
 * GET /messages/{MessageID} — fetch a single message by its Whapi id.
 *
 * Used by the diff-based conversation sync (Phase 2): reconciliation collects
 * only the ids, then this pulls the full body/media for the few that are
 * missing. The response is the same message shape as /messages/list entries, so
 * it feeds straight into shapeInboundMessage()/persistHistorical(). Whapi may
 * return the object bare or wrapped under `message`; both are handled.
 *
 * Resolves to { ok, message, total?, accountError, status, error } — never
 * throws. A 404 (message deleted/expired on Whapi's side) comes back ok:false
 * with status 404, which the caller treats as a skip, not a halt.
 */
export async function getMessage(env, messageId) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = String(messageId || '').trim()
    if (!id) return { ok: false, error: 'get_no_id', message: null }

    const res = await fetch(`${apiUrl}/messages/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160)
      return {
        ok: false,
        error: `get_${res.status}${detail ? `: ${detail}` : ''}`,
        accountError: isAccountError(res.status),
        status: res.status,
        message: null,
      }
    }

    const data = await res.json().catch(() => null)
    const message =
      data && typeof data === 'object'
        ? data.message && typeof data.message === 'object'
          ? data.message
          : data
        : null
    // A body with no id is not a usable message — treat as absent.
    if (!message || !message.id) return { ok: false, error: 'get_empty', status: res.status, message: null }
    return { ok: true, message }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'get_failed'), message: null }
  }
}

/**
 * GET /chats — one page of the account's chats.
 * @param opts { offset, count }
 * Resolves to { ok, chats, total, error }. Each chat is normalised to
 * { id, name, isGroup }. Never throws.
 */
export async function listChats(env, { offset = 0, count = 100 } = {}) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const qs = new URLSearchParams({ count: String(count), offset: String(offset) })

    const res = await fetch(`${apiUrl}/chats?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160)
      return {
        ok: false,
        error: `chats_${res.status}${detail ? `: ${detail}` : ''}`,
        accountError: isAccountError(res.status),
        status: res.status,
        chats: [],
      }
    }

    const data = await res.json().catch(() => null)
    const raw = Array.isArray(data?.chats) ? data.chats : []
    const chats = raw
      .map((c) => {
        const id = String(c?.id ?? c?.chat_id ?? '').trim()
        if (!id) return null
        // A group chat id ends in @g.us; Whapi may also carry type: 'group'.
        const isGroup = /@g\.us$/i.test(id) || String(c?.type || '').toLowerCase() === 'group'
        const name =
          [c?.name, c?.subject, c?.title].find((v) => typeof v === 'string' && v.trim()) || null
        return { id, name, isGroup }
      })
      .filter(Boolean)

    const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null
    return { ok: true, chats, total }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'chats_failed'), chats: [] }
  }
}

/**
 * Who actually sent a group message.
 *
 * In a group, `from` is the individual participant while chat_id is the group.
 * That asymmetry is exactly what made the old code create a conversation per
 * sender; here it is what we WANT, recorded per message.
 */
export function senderOf(msg) {
  const candidates = [msg?.from, msg?.author, msg?.participant]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue
    const digits = toDigits(raw)
    // Skip anything that is itself the group.
    if (!digits || digits.length > MAX_E164_DIGITS) continue
    return {
      number: digits,
      name: typeof msg?.from_name === 'string' && msg.from_name.trim() ? msg.from_name.trim() : null,
    }
  }
  return { number: null, name: null }
}

/**
 * GET /groups/{GroupID} — group metadata and participants.
 * Confirmed against Whapi's endpoint list; participants are {id, rank} where
 * rank is "member" | "admin" | "creator".
 * Never throws.
 */
export async function fetchGroupInfo(env, groupJid) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = groupIdForApi(groupJid)
    if (!id) return { ok: false, error: 'group_no_id' }

    const res = await fetch(`${apiUrl}/groups/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160)
      return { ok: false, error: `group_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    const data = await res.json().catch(() => null)
    if (!data) return { ok: false, error: 'group_bad_json' }

    // Subject key varies across their docs and versions; probe in order.
    const subject =
      [data.name, data.subject, data.title].find((v) => typeof v === 'string' && v.trim()) || null

    const rawParticipants = Array.isArray(data.participants) ? data.participants : []
    const participants = rawParticipants
      .map((p) => {
        const number = toDigits(typeof p === 'string' ? p : p?.id ?? p?.jid ?? p?.number)
        if (!number) return null
        const rank = String(p?.rank ?? p?.role ?? '').toLowerCase()
        return {
          number,
          // Participant objects rarely carry a name; fall back to the number.
          name:
            [p?.name, p?.pushname, p?.notify].find((v) => typeof v === 'string' && v.trim()) || null,
          isAdmin: rank === 'admin' || rank === 'creator' || rank === 'superadmin' || p?.isAdmin === true,
        }
      })
      .filter(Boolean)

    return { ok: true, subject, participants, raw: data }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'group_fetch_failed') }
  }
}

/**
 * GET /groups/{GroupID}/icon — the group's picture.
 * Returns image bytes, mirroring fetchProfilePicture's contract so the same
 * storage pipeline handles both. Never throws.
 */
export async function fetchGroupIcon(env, groupJid, maxBytes = 2 * 1024 * 1024) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = groupIdForApi(groupJid)
    if (!id) return { ok: false, error: 'group_no_id' }

    const res = await fetch(`${apiUrl}/groups/${encodeURIComponent(id)}/icon`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120)
      return { ok: false, error: `group_icon_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    const type = String(res.headers.get('content-type') || '')
    // The endpoint may answer with the bytes directly, or with JSON holding a
    // temporary URL — handle both rather than assuming one.
    if (type.includes('application/json')) {
      const data = await res.json().catch(() => null)
      const url = [data?.icon, data?.url, data?.icon_full, data?.preview].find(
        (v) => typeof v === 'string' && v
      )
      if (!url) return { ok: false, error: 'group_icon_no_url' }

      const img = await fetch(url)
      if (!img.ok) {
        await drainBody(img)
        return { ok: false, error: `group_icon_image_${img.status}` }
      }
      const bytes = await img.arrayBuffer()
      if (!bytes.byteLength) return { ok: false, error: 'group_icon_empty' }
      if (bytes.byteLength > maxBytes) return { ok: false, error: 'group_icon_too_large' }
      return {
        ok: true,
        bytes,
        mime: String(img.headers.get('content-type') || 'image/jpeg').split(';')[0].trim(),
      }
    }

    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainBody(res)
      return { ok: false, error: 'group_icon_too_large' }
    }
    const bytes = await res.arrayBuffer()
    if (!bytes.byteLength) return { ok: false, error: 'group_icon_empty' }
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'group_icon_too_large' }
    return { ok: true, bytes, mime: type.split(';')[0].trim() || 'image/jpeg' }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'group_icon_failed') }
  }
}
