// AES-GCM encryption for per-account secrets at rest.
//
// Account Whapi tokens and webhook secrets live in Postgres so an admin can
// manage them from the Settings page. Storing them as plaintext would mean any
// read of wp_chat_accounts — a leaked service key, a support query, a backup —
// hands over live WhatsApp channels. So they are encrypted here, in the Worker,
// and Postgres only ever sees ciphertext.
//
// WebCrypto only: the Workers runtime has no Node `crypto`, which is the same
// reason push.js implements Web Push by hand.
//
// FORMAT — "v1.<iv-b64url>.<ciphertext-b64url>"
// The version prefix is what makes a future key rotation or algorithm change
// decidable per-value rather than a flag day: decrypt() dispatches on it, so
// old rows stay readable while new rows are written in the new format.

const VERSION = 'v1'
const IV_BYTES = 12 // 96 bits — the size AES-GCM is specified for.

// --------------------------------------------------------------------
// base64url, because the encoded value is stored in a text column and
// travels through JSON. Standard base64's +/= are avoidable noise here.
// --------------------------------------------------------------------
function bytesToB64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/')
  // atob demands the padding that base64url strips.
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Derive the AES key from ENCRYPTION_KEY.
 *
 * The env value is hashed to exactly 256 bits rather than used raw, so ANY
 * passphrase works — a 32-byte random string, a long sentence, a base64 blob.
 * Requiring an exactly-32-byte key is a well-known source of "it works locally
 * and 500s in production", and SHA-256 costs microseconds.
 *
 * This is NOT password hashing (that is hash.js, PBKDF2 at 100k iterations).
 * The input here is a high-entropy machine-generated secret from the platform's
 * encrypted env, not a human-chosen password, so stretching buys nothing.
 */
async function aesKey(env) {
  const secret = env?.ENCRYPTION_KEY
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY is not configured — required to store per-account credentials'
    )
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** True when the deployment can store per-account secrets at all. */
export const canEncrypt = (env) => Boolean(env?.ENCRYPTION_KEY)

/**
 * Encrypt a secret for storage. Returns null for an empty input, so "no token
 * configured" round-trips as NULL rather than as the ciphertext of "".
 *
 * A fresh random IV per call is mandatory for AES-GCM — reusing one across two
 * values under the same key breaks the cipher outright.
 */
export async function encryptSecret(env, plaintext) {
  if (plaintext == null || plaintext === '') return null

  const key = await aesKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(String(plaintext))
    )
  )

  return `${VERSION}.${bytesToB64url(iv)}.${bytesToB64url(ciphertext)}`
}

/**
 * Decrypt a stored secret. Returns null rather than throwing on anything
 * malformed, wrong-key or tampered-with.
 *
 * Never throwing is deliberate: these values are read on the hot path of every
 * send and every webhook. A single unreadable row (a half-finished migration, a
 * rotated ENCRYPTION_KEY) must degrade to "this account has no token" — which
 * the callers already handle, falling back to env — instead of throwing an
 * exception that would take down an unrelated account's message delivery.
 */
export async function decryptSecret(env, stored) {
  if (!stored || typeof stored !== 'string') return null

  try {
    const [version, ivPart, dataPart] = stored.split('.')
    if (version !== VERSION || !ivPart || !dataPart) return null

    const key = await aesKey(env)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(ivPart) },
      key,
      b64urlToBytes(dataPart)
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // Wrong key, tampered ciphertext, or garbage in the column.
    return null
  }
}

/**
 * SHA-256 hex. Used for the webhook secret's lookup column: the inbound route
 * finds an account by hashing the URL segment and doing an indexed equality
 * lookup, instead of decrypting every account's secret to compare.
 *
 * A fast hash is right here for the same reason it is in tokens.js — the input
 * is 256 bits of uniform randomness from generateSecret(), not a password, so
 * there is no dictionary to attack.
 */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh webhook secret: 32 random bytes, base64url — URL-safe by construction. */
export function generateSecret() {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Mask a secret for display, e.g. "HgrP…Ptx9". The Settings page must be able
 * to show that a token IS set, and let an admin recognise WHICH one it is,
 * without the plaintext ever reaching the browser.
 *
 * Short values collapse to a fixed bullet string rather than revealing most of
 * themselves — masking "abcdef" as "abc…def" would be no masking at all.
 */
export function maskSecret(plaintext) {
  const value = String(plaintext ?? '')
  if (!value) return null
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
