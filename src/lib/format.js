/**
 * Strips everything but digits. Exported because the call control needs the
 * bare E.164 digits for `tel:` — a formatted number with spaces and brackets
 * is not a dialable href, and the click-to-call extension reads the href.
 */
export const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '')

/**
 * Country codes we know the SUBSCRIBER length for, so a local number can be
 * recovered from a stored E.164 one.
 *
 * `total` is the full digit count INCLUDING the country code — it is the
 * check that stops a wrong strip. Without it, '1' matches any number starting
 * with a 1 (every +1... and, say, a +12 country) and would eat a real digit.
 * Longest prefix wins, so 971 is tested before 97 and 1 before nothing.
 *
 * Add a row here when a new country appears in the data; an unlisted country
 * is deliberately left whole rather than guessed at, because a number short
 * by one digit is not a number that rings.
 */
const COUNTRY_CODES = [
  { cc: '91', total: 12 },  // India        +91 94253 44605
  { cc: '65', total: 10 },  // Singapore    +65 8753 3650
  { cc: '1', total: 11 },   // US / Canada  +1 202 555 0143
  { cc: '44', total: 12 },  // UK           +44 7700 900123
  { cc: '61', total: 11 },  // Australia    +61 412 345 678
  { cc: '971', total: 12 }, // UAE          +971 50 123 4567
  { cc: '60', total: 11 },  // Malaysia     +60 12 345 6789
  { cc: '62', total: 12 },  // Indonesia    +62 812 3456 7890
]

/**
 * Drops the country code, leaving the local subscriber number.
 *
 * The dialer platform rejects numbers that carry a country code, so this is
 * what gets dialed and what gets shown. Only strips when BOTH the prefix and
 * the total length match a known country — anything else is returned as bare
 * digits, unchanged, because trimming a guessed number of digits produces a
 * number that silently fails to connect.
 *
 * 919425344605 -> 9425344605
 * 6587533650   -> 87533650
 * 255712345678 -> 255712345678  (unlisted country, left whole)
 */
export function localNumber(number) {
  const d = digitsOnly(number)
  if (!d) return ''
  // Longest prefix first, so '971' is not shadowed by '97'/'9'.
  const match = [...COUNTRY_CODES]
    .sort((a, b) => b.cc.length - a.cc.length)
    .find((c) => d.startsWith(c.cc) && d.length === c.total)
  return match ? d.slice(match.cc.length) : d
}

/**
 * The local number, spaced for reading. Grouping is chosen by length alone —
 * the country code is already gone by this point, so there is nothing left to
 * key a per-country rule off.
 *
 * 9425344605 -> 94253 44605
 * 87533650   -> 8753 3650
 */
export function formatLocalNumber(number) {
  const n = localNumber(number)
  if (!n) return ''
  if (n.length === 10) return `${n.slice(0, 5)} ${n.slice(5)}`
  if (n.length === 8) return `${n.slice(0, 4)} ${n.slice(4)}`
  if (n.length === 9) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`
  return n
}

/** 919669229223 -> +91 96692 29223 (best effort; falls back to +digits). */
export function formatNumber(number) {
  const d = digitsOnly(number)
  if (!d) return ''
  if (d.length === 12 && d.startsWith('91')) {
    return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  }
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  }
  return `+${d}`
}

export const displayName = (conversation) =>
  conversation?.customer_name?.trim() || formatNumber(conversation?.customer_number)

/**
 * First character of the first and last word.
 *
 * Uses Array.from so it splits by code POINT, not code unit — otherwise a name
 * beginning with an emoji or an astral-plane character (and many CJK/Indic
 * scripts once combining marks are involved) would be cut mid-character and
 * render as a replacement glyph. toUpperCase is a no-op for scripts without
 * case, which is correct.
 */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'

  const first = Array.from(parts[0])[0] || ''
  if (parts.length === 1) return first.toUpperCase()

  const last = Array.from(parts[parts.length - 1])[0] || ''
  return (first + last).toUpperCase()
}

/**
 * Deterministic avatar colour index, 0–7.
 *
 * Keyed on the phone number rather than the name so the colour survives a
 * contact being renamed. Plain FNV-1a — stable across sessions and devices,
 * which a random or insertion-order colour would not be.
 */
export function avatarIndex(identifier) {
  const key = String(identifier ?? '').replace(/\D/g, '') || String(identifier ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 8
}

/**
 * Who to label a message as, for a quote of it.
 *
 * The fallback chain matters because sender_number and sender_name are written
 * ONLY for group messages — in a 1:1 the conversation already identifies the
 * other party, so an inbound 1:1 row carries neither and the customer's name
 * exists only on the conversation. Without that last step every 1:1 quote
 * reads "Unknown".
 *
 * Mirrors quotedSenderName() in functions/_lib/reply.js, which applies the same
 * rule to quotes coming back from the server.
 */
export function senderLabelFor(message, conversation) {
  if (message?.direction === 'outbound') return message.sent_by || 'You'

  // Group participant: their own name, else their number.
  if (message?.sender_name) return message.sender_name
  if (message?.sender_number) return `+${message.sender_number}`

  // 1:1 inbound: the customer, from the conversation.
  const customerName = conversation?.customer_name?.trim()
  if (customerName) return customerName
  return conversation?.customer_number ? `+${conversation.customer_number}` : null
}

/** Media-type labels used when a quoted message has no text of its own. */
const MEDIA_LABEL = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
}

/**
 * The one line a quoted-reply block shows.
 *
 * Text wins when present (a captioned photo reads better as its caption than as
 * "Photo"). Media with no caption falls back to its type. A quote whose original
 * we could not resolve returns null, and the caller renders the grey
 * "Original message" placeholder instead.
 */
export function quoteLabel(quoted) {
  if (!quoted || quoted.found === false) return null
  if (quoted.body) return quoted.body
  return MEDIA_LABEL[quoted.media_type] || (quoted.media_type ? 'Attachment' : null)
}

/** Compact stamp for the conversation list: time today, weekday this week, else date. */
export function relativeStamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function clockTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

export const dayKey = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toDateString()
}

/** "Priya Sharma" -> "Priya". Rows only have room for one name. */
export function firstName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return ''
  return trimmed.split(/\s+/)[0]
}

/** 4096 -> "4.0 KB". Documents show size under the filename. */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Label for a media message with no caption. */
export function mediaLabel(mediaType) {
  if (mediaType === 'image') return '📷 Photo'
  if (mediaType === 'video') return '🎥 Video'
  if (mediaType === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/**
 * Live filter: case-insensitive substring on the name, OR a digits-only
 * substring on the number so "732" matches "917326198427".
 */
export function matchesQuery(conversation, rawQuery) {
  const query = String(rawQuery || '').trim()
  if (!query) return true

  const name = String(conversation.customer_name || '').toLowerCase()
  if (name && name.includes(query.toLowerCase())) return true

  const queryDigits = digitsOnly(query)
  if (queryDigits && digitsOnly(conversation.customer_number).includes(queryDigits)) {
    return true
  }

  return false
}
