// Accounts — the multi-tenant layer.
//
// THE CENTRAL IDEA: an account-scoped `env` overlay.
//
// Every Whapi function in whapi.js takes `env` as its first argument and reads
// its credentials through whapiConfig(env). Every ingest/sync helper threads the
// same `env` down. That single convention is what makes multi-account possible
// without rewriting the call graph: instead of adding an `account` parameter to
// ~40 functions, we hand them an env whose WHAPI_* values are THIS account's.
//
//   const scoped = await envForAccount(env, accountId)
//   await sendText(scoped, to, body)     // unchanged function, account's channel
//
// So whapi.js, ingest.js, sync.js, group.js and avatar.js needed no signature
// changes at all — they keep reading `env.WHAPI_TOKEN`, it is simply a different
// token now.
//
// BACKWARD COMPATIBILITY: an account with no stored credentials falls back to
// the environment variables. That is what lets the existing single-account
// deployment keep running untouched after the migration — the seeded default
// account has NULL credentials, so it resolves to exactly the env vars it used
// before. Credentials can then be moved into the DB per account, at leisure.

import { getDb, unwrap } from './db.js'
import { decryptSecret, sha256Hex } from './crypto.js'

// Columns safe to read internally. whapi_token_enc/webhook_secret_enc are
// included because resolution needs them; publicAccount() strips them before
// anything reaches the browser.
const ACCOUNT_COLUMNS = `
  id, name, business_number, whapi_api_url,
  whapi_token_enc, webhook_secret_hash, webhook_secret_enc,
  is_active, created_at, updated_at
`

/** Columns the client may see — no ciphertext, no hashes. */
const PUBLIC_COLUMNS = 'id, name, business_number, whapi_api_url, is_active, created_at, updated_at'

/**
 * Per-request memo of resolved account envs.
 *
 * Resolution decrypts, which is real work, and a single webhook delivery can
 * touch the same account for every message in the batch. A WeakMap keyed on the
 * base env object means the cache dies with the request rather than living in
 * module scope, where it would leak credentials across requests on a warm
 * isolate and go stale the moment an admin edits them.
 */
const envCache = new WeakMap()

/** The lowest-id account — the one the 018 migration adopted all legacy rows into. */
export async function defaultAccount(env) {
  const db = getDb(env)
  const rows =
    unwrap(
      await db
        .from('wp_chat_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .limit(1)
    ) || []
  return rows[0] || null
}

export async function getAccount(env, accountId) {
  const id = Number(accountId)
  if (!Number.isInteger(id) || id <= 0) return null
  return (
    unwrap(
      await getDb(env)
        .from('wp_chat_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('id', id)
        .maybeSingle()
    ) || null
  )
}

/** All accounts, newest last. `activeOnly` is what the pickers want. */
export async function listAccounts(env, { activeOnly = false } = {}) {
  let builder = getDb(env).from('wp_chat_accounts').select(ACCOUNT_COLUMNS).order('id', { ascending: true })
  if (activeOnly) builder = builder.eq('is_active', true)
  return unwrap(await builder) || []
}

/** Resolve the account owning an inbound webhook, by the secret in the URL. */
export async function accountForWebhookSecret(env, secret) {
  if (!secret || typeof secret !== 'string') return null

  // Indexed equality on the hash — no decrypt-and-compare across every account,
  // and no timing signal worth worrying about since the hash is of a 256-bit
  // random value, not a guessable password.
  const hash = await sha256Hex(secret)
  return (
    unwrap(
      await getDb(env)
        .from('wp_chat_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('webhook_secret_hash', hash)
        .eq('is_active', true)
        .maybeSingle()
    ) || null
  )
}

/**
 * Build the account-scoped env.
 *
 * Each account value falls back to the corresponding env var when it is not
 * configured, so a partially-migrated account (say, a token in the DB but no
 * business number yet) still works, and the default account with nothing stored
 * behaves precisely as the single-account deployment did.
 *
 * Only the four account-scoped variables are overridden. SUPABASE_*,
 * OPENROUTER_*, JWT_SECRET and VAPID_* pass through untouched by construction —
 * they are system-wide and spreading `env` first is what keeps them so.
 */
export async function envForAccountRow(env, account) {
  if (!account) return env

  const token = (await decryptSecret(env, account.whapi_token_enc)) || env.WHAPI_TOKEN || null
  const webhookSecret =
    (await decryptSecret(env, account.webhook_secret_enc)) || env.WHAPI_WEBHOOK_SECRET || null

  return {
    ...env,
    WHAPI_TOKEN: token,
    WHAPI_API_URL: account.whapi_api_url || env.WHAPI_API_URL || null,
    WHAPI_WEBHOOK_SECRET: webhookSecret,
    BUSINESS_NUMBER: account.business_number || env.BUSINESS_NUMBER || null,

    // Carried so downstream code that needs the identity (channel state keying,
    // conversation stamping) can read it off the env it already holds instead of
    // threading a second argument through every call.
    ACCOUNT_ID: account.id,
    ACCOUNT_NAME: account.name,
  }
}

/**
 * The main entry point: an env scoped to `accountId`, memoised per request.
 * Falls back to the default account when no id is given, which is what keeps
 * every existing single-account code path working unchanged.
 */
export async function envForAccount(env, accountId) {
  const account = accountId ? await getAccount(env, accountId) : await defaultAccount(env)
  if (!account) return env

  let perEnv = envCache.get(env)
  if (!perEnv) {
    perEnv = new Map()
    envCache.set(env, perEnv)
  }

  const cached = perEnv.get(account.id)
  if (cached) return cached

  const scoped = await envForAccountRow(env, account)
  perEnv.set(account.id, scoped)
  return scoped
}

/** Account-scoped env for a conversation, read from its account_id. */
export async function envForConversation(env, conversation) {
  return envForAccount(env, conversation?.account_id)
}

/**
 * Is this account actually usable — does it have a Whapi token, from either
 * source? Used to explain an unconfigured account in the UI instead of letting
 * it fail later with a raw "WHAPI_TOKEN is not configured".
 */
export const isAccountConfigured = (scopedEnv) => Boolean(scopedEnv?.WHAPI_TOKEN)

/** Strip everything secret. The ONLY shape an account is sent to a browser in. */
export function publicAccount(account, { configured = null } = {}) {
  if (!account) return null
  return {
    id: account.id,
    name: account.name,
    business_number: account.business_number || null,
    whapi_api_url: account.whapi_api_url || null,
    is_active: account.is_active !== false,
    // Presence flags, never the values — enough for the Settings page to show
    // "configured" vs "not set" without shipping the secret.
    has_whapi_token: Boolean(account.whapi_token_enc),
    has_webhook_secret: Boolean(account.webhook_secret_hash),
    ...(configured === null ? {} : { configured }),
    created_at: account.created_at,
    updated_at: account.updated_at,
  }
}

// --------------------------------------------------------------------
// ACCESS CONTROL
//
// An admin reaches every account by role. An agent reaches only the accounts
// they have a membership row for. Admins are deliberately not given membership
// rows: a new account would otherwise be invisible to the admin who just made it
// until they remembered to add themselves.
// --------------------------------------------------------------------

/** The account ids a user may access. Admins get every active account. */
export async function accessibleAccountIds(env, user) {
  const db = getDb(env)

  if (user?.role === 'admin') {
    const rows = unwrap(await db.from('wp_chat_accounts').select('id').eq('is_active', true)) || []
    return rows.map((r) => Number(r.id))
  }

  const rows =
    unwrap(await db.from('wp_chat_user_accounts').select('account_id').eq('user_id', user.id)) || []
  const ids = rows.map((r) => Number(r.account_id))
  if (!ids.length) return []

  // An agent must not keep reaching an account that has been deactivated.
  const active =
    unwrap(await db.from('wp_chat_accounts').select('id').eq('is_active', true).in('id', ids)) || []
  return active.map((r) => Number(r.id))
}

/** Full account rows a user may access, in public shape, for the switcher. */
export async function accessibleAccounts(env, user) {
  const ids = await accessibleAccountIds(env, user)
  if (!ids.length) return []

  const rows =
    unwrap(
      await getDb(env)
        .from('wp_chat_accounts')
        .select(PUBLIC_COLUMNS)
        .in('id', ids)
        .order('id', { ascending: true })
    ) || []

  return rows.map((row) => publicAccount(row))
}

/**
 * Gate one account. Returns {response} to return, or {accountId} to use.
 *
 * `requested` may be null, in which case the user's first accessible account is
 * chosen — so a client that has not picked one yet still gets a working answer
 * rather than an error.
 */
export async function resolveAccountAccess(env, user, requested) {
  const allowed = await accessibleAccountIds(env, user)

  if (!allowed.length) {
    return { response: forbidden('You are not assigned to any account') }
  }

  if (requested == null || requested === '') {
    return { accountId: allowed[0], allowed }
  }

  const id = Number(requested)
  if (!Number.isInteger(id) || !allowed.includes(id)) {
    // Deliberately identical to the not-assigned message: an agent probing ids
    // learns nothing about which accounts exist.
    return { response: forbidden('You do not have access to this account') }
  }

  return { accountId: id, allowed }
}

function forbidden(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}
