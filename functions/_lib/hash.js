// PBKDF2 password hashing via Web Crypto. No bcrypt — this runs on Workers.
// Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64>

const ITERATIONS = 100000
const KEY_BITS = 256
const SALT_BYTES = 16

function toB64(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

function fromB64(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS
  )
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const bits = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false

  const iterations = parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations <= 0) return false

  let salt, expected
  try {
    salt = fromB64(parts[2])
    expected = fromB64(parts[3])
  } catch {
    return false
  }

  const bits = new Uint8Array(await derive(password, salt, iterations))
  if (bits.length !== expected.length) return false

  // Constant-time compare.
  let diff = 0
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i]
  return diff === 0
}

/** Random temporary password for the admin reset flow. */
export function generateTempPassword(length = 10) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}
