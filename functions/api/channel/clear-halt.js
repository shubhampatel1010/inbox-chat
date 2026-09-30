import { requireAdmin } from '../../_lib/auth.js'
import { clearAutoHalt } from '../../_lib/channel-gap.js'
import { resolveAccountAccess, envForAccount } from '../../_lib/accounts.js'
import { json, readJson } from '../../_lib/respond.js'

/**
 * POST /api/channel/clear-halt  (admin)
 *
 * Clears an account-level auto-recovery halt (e.g. after a Whapi 402 was
 * resolved), so automatic gap recovery resumes on the next reconnect. Explicit
 * admin action — the "Clear" control on the Sync page.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const url = new URL(request.url)
  const access = await resolveAccountAccess(
    env,
    auth.user,
    body?.account_id ?? url.searchParams.get('account_id')
  )
  if (access.response) return access.response

  // Scoped env so only THIS account's halt is cleared — clearing every
  // account's would silently resume recoveries the admin never looked at.
  const accountEnv = await envForAccount(env, access.accountId)
  await clearAutoHalt(accountEnv)

  return json({ ok: true, account_id: access.accountId })
}
