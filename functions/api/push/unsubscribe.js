import { getDb } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

/**
 * POST /api/push/unsubscribe
 * Body: {endpoint}
 *
 * Scoped to the caller's own rows so one user cannot delete another's
 * subscription by guessing an endpoint.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { endpoint } = await readJson(request)
  if (typeof endpoint !== 'string' || !endpoint) {
    return badRequest('endpoint is required')
  }

  try {
    await getDb(env)
      .from('wp_chat_push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', auth.user.id)

    return json({ ok: true })
  } catch (err) {
    return serverError(err.message || 'Could not remove the subscription')
  }
}
