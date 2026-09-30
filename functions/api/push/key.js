import { requireAuth } from '../../_lib/auth.js'
import { json } from '../../_lib/respond.js'

/**
 * GET /api/push/key
 *
 * Serves the VAPID public key for PushManager.subscribe(). Delivered at
 * runtime rather than baked in at build time so the key lives in one place
 * (Cloudflare env) and rotating it does not require a rebuild.
 *
 * The public key is not a secret — it is transmitted to the push service on
 * every subscribe — but this stays behind auth since only signed-in agents
 * ever need it.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  return json({ ok: true, key: env.VAPID_PUBLIC_KEY || null })
}
