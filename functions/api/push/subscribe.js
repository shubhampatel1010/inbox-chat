import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

/**
 * POST /api/push/subscribe
 * Body: the browser's PushSubscription JSON — {endpoint, keys:{p256dh, auth}}.
 *
 * Idempotent: endpoint is UNIQUE, so re-subscribing (which iOS forces after it
 * silently drops a subscription) updates the existing row rather than failing.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
  const p256dh = body?.keys?.p256dh
  const authKey = body?.keys?.auth

  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return badRequest('A valid https push endpoint is required')
  }
  if (typeof p256dh !== 'string' || typeof authKey !== 'string' || !p256dh || !authKey) {
    return badRequest('Subscription keys are required')
  }

  try {
    const db = getDb(env)
    const now = new Date().toISOString()
    const userAgent = (request.headers.get('User-Agent') || '').slice(0, 400) || null

    const existing = unwrap(
      await db
        .from('wp_chat_push_subscriptions')
        .select('id')
        .eq('endpoint', endpoint)
        .maybeSingle()
    )

    if (existing) {
      // The endpoint may have been re-issued to a different user on a shared
      // device, so reassign ownership and reset the failure counter.
      unwrap(
        await db
          .from('wp_chat_push_subscriptions')
          .update({
            user_id: auth.user.id,
            p256dh,
            auth: authKey,
            user_agent: userAgent,
            failure_count: 0,
          })
          .eq('id', existing.id)
      )
      return json({ ok: true, updated: true })
    }

    unwrap(
      await db.from('wp_chat_push_subscriptions').insert({
        user_id: auth.user.id,
        endpoint,
        p256dh,
        auth: authKey,
        user_agent: userAgent,
        created_at: now,
        failure_count: 0,
      })
    )

    return json({ ok: true, created: true })
  } catch (err) {
    return serverError(err.message || 'Could not save the subscription')
  }
}
