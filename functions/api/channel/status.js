import { requireAuth } from '../../_lib/auth.js'
import { checkHealth } from '../../_lib/whapi.js'
import { observeChannel } from '../../_lib/channel-gap.js'
import { resolveAccountAccess, envForAccount, isAccountConfigured } from '../../_lib/accounts.js'
import { json } from '../../_lib/respond.js'

/**
 * GET /api/channel/status
 *
 * Normalised channel health for the banner and the account dropdown, AND the
 * heartbeat that drives automatic gap recovery: observeChannel persists the
 * connected/disconnected state and, on a reconnect, creates a recovery sync for
 * the outage window. observeChannel never throws, so this endpoint always
 * returns health even if recovery bookkeeping fails.
 *
 * `auto_recovery` is the recovery job an admin tab should drive (or null).
 * `auto_halted` is set when an account-level Whapi error paused auto-recovery.
 *
 * ?account_id=N selects WHICH account's channel to report on; omitted, it is the
 * caller's first accessible account. Health, gap observation and recovery are
 * all per-account, so one account's outage never appears as another's.
 *
 * Always 200: an unreachable Whapi is a disconnected channel, not a server
 * error, and the client must be able to render that state.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const access = await resolveAccountAccess(env, auth.user, url.searchParams.get('account_id'))
  if (access.response) return access.response

  const accountEnv = await envForAccount(env, access.accountId)

  // An account whose channel is not connected yet reports as disconnected
  // rather than throwing "WHAPI_TOKEN is not configured" — the admin has simply
  // not finished setting it up, which the UI shows as an unconfigured state.
  if (!isAccountConfigured(accountEnv)) {
    return json({
      ok: true,
      account_id: access.accountId,
      configured: false,
      connected: false,
      status: 'not_configured',
      uptime: null,
      checked_at: new Date().toISOString(),
      auto_recovery: null,
      auto_halted: null,
    })
  }

  const health = await checkHealth(accountEnv)
  // observeChannel reads env.ACCOUNT_ID off the scoped env to key its state row.
  const observed = await observeChannel(accountEnv, health)

  return json({
    ok: true,
    account_id: access.accountId,
    configured: true,
    connected: health.connected,
    status: health.status,
    uptime: health.uptime,
    checked_at: health.checked_at,
    auto_recovery: observed.auto || null,
    auto_halted: observed.halted || null,
  })
}
