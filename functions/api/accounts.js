import { getDb, unwrap, UNIQUE_VIOLATION } from '../_lib/db.js'
import { requireAuth, requireAdmin } from '../_lib/auth.js'
import {
  accessibleAccounts,
  listAccounts,
  publicAccount,
  envForAccountRow,
  isAccountConfigured,
} from '../_lib/accounts.js'
import { toDigits } from '../_lib/whapi.js'
import { json, badRequest, serverError, readJson } from '../_lib/respond.js'

/**
 * GET /api/accounts
 *
 * The accounts the caller may use — this is what populates the account switcher
 * and every account picker. An admin sees all active accounts (by role); an
 * agent sees only the ones they are assigned to.
 *
 * Secrets never appear here: publicAccount() reduces a row to its id, name,
 * number and boolean "is it configured" flags.
 *
 * ?all=1 (admin only) also returns DEACTIVATED accounts, which the Settings page
 * needs in order to show and reactivate them.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    const url = new URL(request.url)
    const wantsAll = url.searchParams.get('all') === '1' && auth.user.role === 'admin'

    if (!wantsAll) {
      return json({ ok: true, accounts: await accessibleAccounts(env, auth.user) })
    }

    // Admin/Settings view. `configured` reports whether the account can actually
    // reach Whapi at all — from its own stored token OR the env fallback — so
    // the UI can flag a half-set-up account instead of letting it fail later
    // with a raw "WHAPI_TOKEN is not configured".
    const rows = await listAccounts(env)
    const accounts = await Promise.all(
      rows.map(async (row) => {
        const scoped = await envForAccountRow(env, row)
        return publicAccount(row, { configured: isAccountConfigured(scoped) })
      })
    )

    return json({ ok: true, accounts })
  } catch (err) {
    return serverError(err.message || 'Failed to load accounts')
  }
}

/**
 * POST /api/accounts  (admin)
 *
 * Create an account. Only the name is required — credentials and the WhatsApp
 * number are configured afterwards via /api/accounts/settings, so an admin can
 * create the account first and connect its channel when they have the token.
 *
 * A new account starts with NO members, so it is private to admins until users
 * are assigned to it. That is deliberate: a new account must not silently appear
 * in every agent's inbox.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('Account name is required')

  // Optional at creation; normalised to bare digits so it can be compared with
  // the numbers Whapi reports.
  const businessNumber = body?.business_number ? toDigits(body.business_number) : null
  if (body?.business_number && !businessNumber) {
    return badRequest('business_number must contain digits')
  }

  try {
    const created = await getDb(env)
      .from('wp_chat_accounts')
      .insert({
        name,
        business_number: businessNumber,
        whapi_api_url: typeof body?.whapi_api_url === 'string' && body.whapi_api_url.trim()
          ? body.whapi_api_url.trim().replace(/\/+$/, '')
          : null,
        is_active: true,
      })
      .select('*')
      .single()

    if (created.error) {
      if (created.error.code === UNIQUE_VIOLATION) {
        return badRequest('Another account is already using that WhatsApp number')
      }
      throw new Error(created.error.message)
    }

    return json({ ok: true, account: publicAccount(created.data, { configured: false }) })
  } catch (err) {
    return serverError(err.message || 'Failed to create account')
  }
}
