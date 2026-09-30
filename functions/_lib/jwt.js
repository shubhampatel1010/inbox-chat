// HS256 JWTs via Web Crypto. No jsonwebtoken — this runs on Workers.

// Access tokens are short-lived by design — the refresh cookie is what keeps a
// session alive, so a stolen access token is only useful for minutes.
const TTL_SECONDS = 15 * 60

function b64urlEncode(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const encode = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)))

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export async function signJWT(payload, env, ttlSeconds = TTL_SECONDS) {
  if (!env?.JWT_SECRET) throw new Error('JWT_SECRET is not configured')

  const now = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat: now, exp: now + ttlSeconds }
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(body)}`

  const key = await hmacKey(env.JWT_SECRET)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${b64urlEncode(sig)}`
}

/** Returns the decoded payload, or null if the token is invalid or expired. */
export async function verifyJWT(token, env) {
  if (!token || !env?.JWT_SECRET) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null

  const data = `${parts[0]}.${parts[1]}`
  try {
    const key = await hmacKey(env.JWT_SECRET)
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(data)
    )
    if (!ok) return null

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])))
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }
    return payload
  } catch {
    return null
  }
}
