import { requireAdmin } from '../../_lib/auth.js'
import {
  vapidAuthHeader,
  vapidConfig,
  normalizeVapidSubject,
  b64urlToBytes,
} from '../../_lib/push.js'
import { json, badRequest } from '../../_lib/respond.js'

/**
 * GET /api/push/token?endpoint=<push endpoint URL>
 *
 * TEMPORARY diagnostic. Admin only. Builds the exact Authorization header that
 * would be sent to the given endpoint and returns the DECODED JWT header and
 * claims, so a rejected token can be inspected without a debugger.
 *
 * The private key never leaves the Worker: only the decoded (already public)
 * header/claims are returned, and the signature is reported by length only.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const endpoint = url.searchParams.get('endpoint') || 'https://web.push.apple.com/diagnostic'

  let origin
  try {
    origin = new URL(endpoint).origin
  } catch {
    return badRequest('endpoint must be an absolute URL')
  }

  const report = {
    endpoint_origin: origin,
    // Reported before normalization so a misconfigured value is visible.
    subject_raw: env?.VAPID_SUBJECT ?? null,
    subject_check: normalizeVapidSubject(env?.VAPID_SUBJECT),
    public_key_present: Boolean(env?.VAPID_PUBLIC_KEY),
    private_key_present: Boolean(env?.VAPID_PRIVATE_KEY),
  }

  // Confirm the public key is a well-formed uncompressed P-256 point.
  try {
    const pub = b64urlToBytes(env?.VAPID_PUBLIC_KEY || '')
    report.public_key_bytes = pub.length
    report.public_key_uncompressed = pub.length === 65 && pub[0] === 0x04
  } catch (err) {
    report.public_key_bytes = `decode failed: ${err.message}`
  }

  try {
    const config = vapidConfig(env)
    report.subject_sent = config.subject

    const header = await vapidAuthHeader(endpoint, env)
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)

    if (!match) {
      report.authorization_parse = 'UNEXPECTED FORMAT'
      report.authorization_prefix = header.slice(0, 24)
    } else {
      const [, jwt, k] = match
      const [h, p, sig] = jwt.split('.')

      report.authorization_scheme = 'vapid (single header, RFC 8292 §3)'
      report.jwt_header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))
      report.jwt_claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)))
      report.jwt_signature_bytes = b64urlToBytes(sig).length
      report.k_matches_public_key = k === env.VAPID_PUBLIC_KEY

      const claims = report.jwt_claims
      const now = Math.floor(Date.now() / 1000)
      report.exp_in_seconds = claims.exp - now
      report.exp_within_24h = claims.exp - now > 0 && claims.exp - now <= 24 * 60 * 60
      report.aud_matches_endpoint_origin = claims.aud === origin
      // Apple wants the origin, NOT the full endpoint URL.
      report.aud_is_full_endpoint_url = claims.aud === endpoint
    }

    // What actually goes on the wire alongside the token.
    report.request_headers = {
      Authorization: 'vapid t=<jwt>, k=<public key>',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    }
  } catch (err) {
    report.error = String(err?.message || err)
  }

  return json({ ok: true, report })
}
