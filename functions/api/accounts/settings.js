import { getDb, unwrap, UNIQUE_VIOLATION } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import {
  getAccount,
  publicAccount,
  envForAccountRow,
  isAccountConfigured,
} from '../../_lib/accounts.js'
import {
  encryptSecret,
  decryptSecret,
  sha256Hex,
  generateSecret,
  maskSecret,
  canEncrypt,
} from '../../_lib/crypto.js'
import { toDigits, checkHealth } from '../../_lib/whapi.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'

/**
 * Per-account credentials and settings. Admin only.
 *
 * WHICH CREDENTIALS LIVE HERE — everything that belongs to ONE WhatsApp channel:
 *   whapi_token          the account's Whapi API token
 *   whapi_api_url        its Whapi gateway (defaults to gate.whapi.cloud)
 *   business_number      the WhatsApp number it sends from
 *   webhook_secret       the per-account inbound webhook credential
 *
 * WHICH DO NOT — these stay system-wide in the platform's encrypted env and are
 * intentionally NOT editable here:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   one database for the whole system
 *   OPENROUTER_API_KEY                        one AI account for the whole system
 *   JWT_SECRET, VAPID_*                       properties of this deployment and
 *                                             its browser-push identity, not of
 *                                             any WhatsApp account
 *
 * Secrets are written encrypted (AES-GCM, functions/_lib/crypto.js) and are
 * NEVER returned in plaintext. GET returns masked previews so an admin can
 * confirm which token is set without the value reaching the browser.
 */

/** Whether this account's values come from its own row or from the env fallback. */
function sourceOf(account, scoped, key) {
  if (key === 'whapi_token') return account.whapi_token_enc ? 'account' : scoped.WHAPI_TOKEN ? 'environment' : 'unset'
  if (key === 'business_number') return account.business_number ? 'account' : scoped.BUSINESS_NUMBER ? 'environment' : 'unset'
  if (key === 'whapi_api_url') return account.whapi_api_url ? 'account' : scoped.WHAPI_API_URL ? 'environment' : 'unset'
  if (key === 'webhook_secret') return account.webhook_secret_hash ? 'account' : scoped.WHAPI_WEBHOOK_SECRET ? 'environment' : 'unset'
  return 'unset'
}

/**
 * GET /api/accounts/settings?account_id=N  (admin)
 *
 * The account's effective configuration: what is stored on it, what it is
 * falling back to from the environment, and masked previews of the secrets.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  try {
    const url = new URL(request.url)
    const account = await getAccount(env, url.searchParams.get('account_id'))
    if (!account) return notFound('Account not found')

    const scoped = await envForAccountRow(env, account)
    const webhookSecret = await decryptSecret(env, account.webhook_secret_enc)

    return json({
      ok: true,
      account: publicAccount(account, { configured: isAccountConfigured(scoped) }),
      settings: {
        business_number: account.business_number || null,
        whapi_api_url: account.whapi_api_url || null,

        // Masked, never the value. The mask is of the EFFECTIVE token, so an
        // admin can tell an account using its own token from one still riding
        // the environment fallback.
        whapi_token_masked: maskSecret(scoped.WHAPI_TOKEN),

        // The webhook URL is not itself a secret to the admin who must paste it
        // into the Whapi dashboard, so it is returned whole — but only for a
        // secret stored ON the account. An account still on the legacy env
        // secret returns null rather than leaking the shared one.
        webhook_url: webhookSecret ? `${url.origin}/api/whapi/webhook/${webhookSecret}` : null,

        // Where each effective value actually comes from.
        sources: {
          whapi_token: sourceOf(account, scoped, 'whapi_token'),
          whapi_api_url: sourceOf(account, scoped, 'whapi_api_url'),
          business_number: sourceOf(account, scoped, 'business_number'),
          webhook_secret: sourceOf(account, scoped, 'webhook_secret'),
        },
      },

      // Shown read-only so the admin can SEE that these are deliberately shared
      // rather than wonder why they are missing from the per-account form.
      system: {
        supabase_url: env.SUPABASE_URL ? 'configured' : 'not set',
        supabase_service_role_key: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY ? 'configured' : 'not set',
        openrouter_api_key: env.OPENROUTER_API_KEY ? 'configured' : 'not set',
        encryption_key: canEncrypt(env) ? 'configured' : 'not set',
      },
    })
  } catch (err) {
    return serverError(err.message || 'Failed to load account settings')
  }
}

/**
 * POST /api/accounts/settings  (admin)
 *
 * Body: { account_id, name?, business_number?, whapi_api_url?, whapi_token?,
 *         rotate_webhook_secret?, is_active? }
 *
 * PARTIAL UPDATE by design — only the keys present are written. This is what
 * lets the UI submit a form whose secret field was left blank without wiping the
 * stored token. Sending an explicit empty string clears a value; omitting the
 * key leaves it alone.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)

  try {
    const account = await getAccount(env, body?.account_id)
    if (!account) return notFound('Account not found')

    const patch = { updated_at: new Date().toISOString() }

    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return badRequest('Account name cannot be empty')
      patch.name = name
    }

    if (body.business_number !== undefined) {
      const digits = body.business_number ? toDigits(body.business_number) : null
      if (body.business_number && !digits) return badRequest('business_number must contain digits')
      patch.business_number = digits
    }

    if (body.whapi_api_url !== undefined) {
      const raw = typeof body.whapi_api_url === 'string' ? body.whapi_api_url.trim() : ''
      // A malformed URL here would fail on every send with an opaque fetch
      // error, so it is rejected at the point of entry instead.
      if (raw && !/^https?:\/\//i.test(raw)) return badRequest('whapi_api_url must start with http:// or https://')
      patch.whapi_api_url = raw ? raw.replace(/\/+$/, '') : null
    }

    if (body.whapi_token !== undefined) {
      const token = typeof body.whapi_token === 'string' ? body.whapi_token.trim() : ''
      if (token && !canEncrypt(env)) {
        return badRequest(
          'ENCRYPTION_KEY is not configured on this deployment — per-account credentials cannot be stored securely'
        )
      }
      patch.whapi_token_enc = token ? await encryptSecret(env, token) : null
    }

    // Generating a webhook secret is always an explicit act — never implicit in
    // an unrelated save, because rotating it silently would break inbound
    // delivery until the admin re-pasted the new URL into Whapi.
    let newWebhookUrl = null
    if (body.rotate_webhook_secret === true) {
      if (!canEncrypt(env)) {
        return badRequest('ENCRYPTION_KEY is not configured — cannot store a webhook secret')
      }
      const secret = generateSecret()
      patch.webhook_secret_hash = await sha256Hex(secret)
      patch.webhook_secret_enc = await encryptSecret(env, secret)
      newWebhookUrl = `${new URL(request.url).origin}/api/whapi/webhook/${secret}`
    }

    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active

    const updated = await getDb(env)
      .from('wp_chat_accounts')
      .update(patch)
      .eq('id', account.id)
      .select('*')
      .single()

    if (updated.error) {
      if (updated.error.code === UNIQUE_VIOLATION) {
        return badRequest('Another account is already using that WhatsApp number')
      }
      throw new Error(updated.error.message)
    }

    const scoped = await envForAccountRow(env, updated.data)

    return json({
      ok: true,
      account: publicAccount(updated.data, { configured: isAccountConfigured(scoped) }),
      // Returned ONCE, on the rotate that created it. The admin copies it into
      // Whapi now; afterwards it is only retrievable via GET.
      webhook_url: newWebhookUrl,
    })
  } catch (err) {
    return serverError(err.message || 'Failed to save account settings')
  }
}

/**
 * PUT /api/accounts/settings  (admin) — connection test.
 *
 * Body: { account_id }. Calls Whapi health with THIS account's resolved
 * credentials, so an admin can verify a token before relying on it. Always 200:
 * a bad token is a test result, not a server error.
 */
export async function onRequestPut({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)

  try {
    const account = await getAccount(env, body?.account_id)
    if (!account) return notFound('Account not found')

    const scoped = await envForAccountRow(env, account)
    if (!isAccountConfigured(scoped)) {
      return json({ ok: true, connected: false, status: 'no_token', error: 'No Whapi token is configured for this account' })
    }

    const health = await checkHealth(scoped)
    return json({
      ok: true,
      connected: health.connected === true,
      status: health.status ?? null,
      uptime: health.uptime ?? null,
      error: health.error ?? null,
    })
  } catch (err) {
    return serverError(err.message || 'Connection test failed')
  }
}
