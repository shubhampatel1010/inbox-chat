import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { signUrl } from '../../_lib/storage.js'
import { json, badRequest, forbidden } from '../../_lib/respond.js'

const SIGNED_TTL_SECONDS = 60 * 60 // 60 minutes

/**
 * GET /api/media/<conversation_id>/<object>
 *
 * Cloudflare Pages spells a catch-all segment [[path]] (not [...path]), and
 * hands the matched segments to params.path as an array.
 *
 * Returns { url } — a short-lived Supabase signed URL the client sets directly
 * as an <img src> / download href. The bucket stays private; the service key
 * never leaves the Worker.
 */
export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const segments = Array.isArray(params?.path) ? params.path : [params?.path]
  const path = segments.filter(Boolean).join('/')

  if (!path) return badRequest('A media path is required')
  // No traversal out of the bucket, and no absolute paths.
  if (path.includes('..') || path.startsWith('/')) return badRequest('Invalid media path')

  // Objects live at {conversation_id}/{uuid}.{ext} — reuse that to authorize,
  // so an agent cannot read media from a conversation they don't own.
  const conversationId = Number(segments[0])
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return forbidden('Invalid media path')
  }

  const access = await requireConversationAccess(env, auth.user, conversationId)
  if (access.response) return access.response

  const signed = await signUrl(env, path, SIGNED_TTL_SECONDS)
  if (!signed.ok) {
    return json({ ok: false, error: 'Could not load this attachment' }, 502)
  }

  return json(
    { ok: true, url: signed.url, expires_in: SIGNED_TTL_SECONDS },
    200,
    { 'Referrer-Policy': 'no-referrer' }
  )
}
