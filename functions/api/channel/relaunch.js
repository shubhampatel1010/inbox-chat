import { requireAuth } from '../../_lib/auth.js'
import { launchChannel } from '../../_lib/whapi.js'
import { resolveAccountAccess, envForAccount, isAccountConfigured } from '../../_lib/accounts.js'
import { json, badRequest, readJson } from '../../_lib/respond.js'

/**
 * POST /api/channel/relaunch  (any authenticated user)
 *
 * The reconnect flow's first move: ask Whapi to relaunch the channel via
 * GET /health?wakeup=true. Some disconnections recover from this alone. The
 * client then polls /api/channel/status to see whether it worked, and only
 * falls back to the QR if it did not.
 *
 * Open to any signed-in user: it is the first step of the same reconnect flow as
 * the QR (below), so gating it to admin would 403 a non-admin before they ever
 * reached the QR. requireAuth still keeps it behind a valid session.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  // Accepted in the body (POST) or the query string, so the client can send it
  // whichever way suits the call site.
  const body = await readJson(request)
  const url = new URL(request.url)
  const requested = body?.account_id ?? url.searchParams.get('account_id')

  const access = await resolveAccountAccess(env, auth.user, requested)
  if (access.response) return access.response

  const accountEnv = await envForAccount(env, access.accountId)
  if (!isAccountConfigured(accountEnv)) {
    return badRequest('This account has no Whapi token configured yet')
  }

  const health = await launchChannel(accountEnv)

  return json({
    ok: true,
    account_id: access.accountId,
    connected: health.connected,
    status: health.status,
    uptime: health.uptime,
    checked_at: health.checked_at,
  })
}
