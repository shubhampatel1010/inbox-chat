/**
 * Web Push (RFC 8030 / 8291 / 8188) implemented directly on WebCrypto.
 *
 * No library: every published web-push package depends on Node's `crypto`
 * (createECDH / createCipheriv), which does not exist on the Workers runtime.
 * The primitives needed here — ECDSA P-256 signing, ECDH, HKDF-SHA256 and
 * AES-128-GCM — are all in WebCrypto, so this is ~100 lines with no
 * compatibility risk.
 */

import { drainBody } from './http.js'

// ---------------------------------------------------------------- base64url
export function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const utf8 = (s) => new TextEncoder().encode(s)

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// ---------------------------------------------------------------- VAPID
/**
 * Apple validates the `sub` claim far more strictly than the other push
 * services, and rejects the whole token with 403 {"reason":"BadJwtToken"} when
 * it does not like it. It must be a well-formed `mailto:` address or an
 * `https:` URL — no angle brackets, no space after `mailto:`, no localhost or
 * other undeliverable host.
 *
 * Returns {ok, subject, reason, warnings}. Normalizes the recoverable
 * mistakes rather than shipping a token Apple will silently refuse.
 */
export function normalizeVapidSubject(raw) {
  const warnings = []
  let subject = String(raw ?? '').trim()

  if (!subject) return { ok: false, reason: 'VAPID_SUBJECT is empty' }

  // "mailto:<ops@x.com>" and "mailto: ops@x.com" are both rejected by Safari.
  if (/[<>]/.test(subject)) {
    subject = subject.replace(/[<>]/g, '').trim()
    warnings.push('stripped angle brackets')
  }
  if (/^mailto:\s+/i.test(subject)) {
    subject = subject.replace(/^mailto:\s+/i, 'mailto:')
    warnings.push('removed space after "mailto:"')
  }

  // A bare address is the most common misconfiguration — add the scheme.
  if (!/^(mailto:|https?:\/\/)/i.test(subject)) {
    if (/^[^\s@]+@[^\s@]+$/.test(subject)) {
      subject = `mailto:${subject}`
      warnings.push('added missing "mailto:" scheme')
    } else {
      return {
        ok: false,
        reason: `VAPID_SUBJECT must be a mailto: address or https: URL, got "${subject}"`,
      }
    }
  }

  // Normalize the scheme's case; the address itself is left alone.
  subject = subject.replace(/^MAILTO:/i, 'mailto:').replace(/^HTTP(S?):\/\//i, (m) => m.toLowerCase())

  if (/^mailto:/i.test(subject)) {
    const address = subject.slice('mailto:'.length)
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(address)) {
      return { ok: false, reason: `VAPID_SUBJECT is not a valid email address: "${address}"` }
    }
    if (/(^|\.)localhost$|\.local$|\.invalid$|\.test$/i.test(address.split('@')[1] || '')) {
      return {
        ok: false,
        reason: `Apple rejects undeliverable VAPID_SUBJECT domains, got "${address}"`,
      }
    }
  } else {
    if (!/^https:\/\//i.test(subject)) {
      return { ok: false, reason: 'VAPID_SUBJECT must use https, not http' }
    }
    try {
      const host = new URL(subject).hostname
      if (/(^|\.)localhost$|\.local$|\.invalid$|\.test$/i.test(host)) {
        return { ok: false, reason: `Apple rejects localhost VAPID_SUBJECT, got "${host}"` }
      }
    } catch {
      return { ok: false, reason: `VAPID_SUBJECT is not a valid URL: "${subject}"` }
    }
  }

  return { ok: true, subject, warnings }
}

export function vapidConfig(env) {
  const publicKey = env?.VAPID_PUBLIC_KEY
  const privateKey = env?.VAPID_PRIVATE_KEY

  if (!publicKey || !privateKey || !env?.VAPID_SUBJECT) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not configured')
  }

  const normalized = normalizeVapidSubject(env.VAPID_SUBJECT)
  if (!normalized.ok) {
    // Fail loudly here rather than letting Apple answer 403 BadJwtToken.
    throw new Error(`Invalid VAPID_SUBJECT — ${normalized.reason}`)
  }
  if (normalized.warnings.length) {
    console.warn('VAPID_SUBJECT normalized:', normalized.warnings.join('; '))
  }

  return { publicKey, privateKey, subject: normalized.subject }
}

/**
 * Rebuilds the signing key as a JWK. The private scalar alone is not enough
 * for WebCrypto — x and y come from the uncompressed public key
 * (0x04 || x(32) || y(32)).
 */
async function importVapidSigningKey({ publicKey, privateKey }) {
  const pub = b64urlToBytes(publicKey)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point')
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
}

/** ES256 JWT bound to the push service's origin. */
export async function vapidAuthHeader(endpoint, env) {
  const config = vapidConfig(env)
  const key = await importVapidSigningKey(config)

  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = bytesToB64url(
    utf8(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // Push services reject anything beyond 24h; 12h is the usual choice.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: config.subject,
      })
    )
  )

  const signingInput = `${header}.${claims}`
  // WebCrypto emits raw r||s, which is exactly the JOSE encoding — no DER
  // unwrapping needed.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(signingInput)
  )

  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${config.publicKey}`
}

// ---------------------------------------------------------------- encryption
async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8
  )
  return new Uint8Array(bits)
}

const RECORD_SIZE = 4096

/**
 * aes128gcm content encoding (RFC 8188) with the web-push key derivation
 * (RFC 8291). Returns the full request body:
 *
 *   salt(16) | rs(4) | idlen(1) | as_public(65) | AEAD(plaintext || 0x02)
 */
export async function encryptPayload(plaintext, p256dh, auth) {
  const uaPublic = b64urlToBytes(p256dh)
  const authSecret = b64urlToBytes(auth)

  if (uaPublic.length !== 65) throw new Error('bad p256dh length')
  if (authSecret.length !== 16) throw new Error('bad auth length')

  // Fresh ephemeral keypair per message — reusing one would leak across
  // recipients.
  const asKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey))

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256)
  )

  // RFC 8291 §3.3 — auth_secret is the HKDF salt at this step.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(utf8('WebPush: info\0'), uaPublic, asPublic),
    32
  )

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  const body = typeof plaintext === 'string' ? utf8(plaintext) : plaintext
  if (body.length + 1 + 16 > RECORD_SIZE) throw new Error('push payload too large')

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      aesKey,
      // 0x02 marks the last (only) record.
      concat(body, new Uint8Array([2]))
    )
  )

  const header = new Uint8Array(16 + 4 + 1 + 65)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = 65
  header.set(asPublic, 21)

  return concat(header, ciphertext)
}

// ---------------------------------------------------------------- send
/**
 * Delivers one notification.
 * Returns {ok, status, gone} — never throws, so one dead subscription cannot
 * abort a fan-out.
 */
export async function sendPush(env, subscription, payload, { ttl = 86400 } = {}) {
  try {
    const body = await encryptPayload(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      subscription.p256dh,
      subscription.auth
    )

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthHeader(subscription.endpoint, env),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body,
    })

    // On rejection, read the body — Apple and the other push services put the
    // actual reason there. On success the body is empty but the stream must
    // still be released, or every delivered push leaks a connection (this is
    // the fan-out that logs "two stalled responses per webhook invocation").
    let failureBody = null
    if (!res.ok) {
      try {
        failureBody = (await res.text()).slice(0, 300) || null
      } catch {
        failureBody = null
      }
    } else {
      await drainBody(res)
    }

    // 404/410 are the standard "this subscription is dead" signals.
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      body: failureBody,
    }
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: String(err?.message || err) }
  }
}
