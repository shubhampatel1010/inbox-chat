import { getDb, unwrap } from './db.js'
import { checkHealth } from './whapi.js'
import { sendPush } from './push.js'
import { listAccounts, envForAccountRow, isAccountConfigured } from './accounts.js'

const STATE_KEY = 'channel'

// ---------------------------------------------------------------------------
// NO CALLER TODAY.
//
// This was written as the body of a Cloudflare Cron Trigger, but Pages rejects
// a [triggers] block outright — cron is Workers-only. The former entry point
// lived at functions/_scheduled.js and has been removed.
//
// The logic below is complete and tested; it only lacks a scheduler. To
// reconnect it, deploy a standalone Worker that imports monitorChannel and
// calls it from a scheduled handler on a */5 * * * * cron. See the note in
// wrangler.toml for the exact shape and the env vars it needs.
//
// Nothing else depends on this module, so it is dead code until then — the
// /api/channel/status endpoint the banner polls does its own live health
// check and does not go through here.
//
// MULTI-ACCOUNT. Even though nothing calls this, it is kept account-aware so
// that reviving it cannot quietly break gap detection. wp_chat_channel_state is
// now keyed (account_id, key); a monitor that wrote a row with a NULL account_id
// would not match the rows observeChannel() reads, so every account's recovery
// would silently stop working. monitorChannel() therefore iterates the accounts
// and checks each one on its own credentials, exactly as the status endpoint
// does for the account being viewed.
// ---------------------------------------------------------------------------

/**
 * Check health, and push to admins ONLY on a connected → disconnected
 * transition.
 *
 * The last state lives in wp_chat_channel_state (a single row keyed 'channel'),
 * because a Worker isolate does not survive between cron invocations — an
 * in-memory flag would make every 5-minute run look like a fresh transition and
 * notify admins forever.
 *
 * Never throws; a cron failure must not retry-storm.
 */
export async function monitorChannel(env) {
  // Every active account, each on its own channel. One account's failure must
  // not stop the others being checked, so each is wrapped individually inside
  // monitorAccount().
  try {
    const accounts = await listAccounts(env, { activeOnly: true })
    const results = []
    for (const account of accounts) {
      results.push({ account_id: account.id, ...(await monitorAccount(env, account)) })
    }
    return { accounts: results }
  } catch (err) {
    console.error('channel monitor failed:', err?.message || err)
    return { accounts: [], error: String(err?.message || err) }
  }
}

/** One account's health check + transition detection. Never throws. */
async function monitorAccount(baseEnv, account) {
  try {
    const db = getDb(baseEnv)
    const env = await envForAccountRow(baseEnv, account)

    // An account with no channel connected yet has no health to observe.
    if (!isAccountConfigured(env)) return { connected: null, notified: 0, skipped: 'not_configured' }

    const health = await checkHealth(env)

    const previous = unwrap(
      await db
        .from('wp_chat_channel_state')
        .select('id, connected, changed_at')
        .eq('key', STATE_KEY)
        .eq('account_id', account.id)
        .maybeSingle()
    )

    const wasConnected = previous ? previous.connected === true : null
    const now = new Date().toISOString()

    // First run has no baseline. Record it and stay quiet — we cannot know
    // whether this is a transition or simply the first observation.
    const isTransition = wasConnected === true && health.connected === false

    const row = {
      key: STATE_KEY,
      account_id: account.id,
      connected: health.connected,
      status: health.status,
      checked_at: now,
      ...(wasConnected !== health.connected ? { changed_at: now } : {}),
    }

    if (previous) {
      unwrap(await db.from('wp_chat_channel_state').update(row).eq('id', previous.id))
    } else {
      unwrap(await db.from('wp_chat_channel_state').insert({ ...row, changed_at: now }))
    }

    console.log(
      `channel monitor [${account.name}]: ${health.connected ? 'connected' : 'DISCONNECTED'} (${health.status})` +
        `${isTransition ? ' — transition, notifying admins' : ''}`
    )

    if (!isTransition) return { connected: health.connected, notified: 0 }

    return { connected: false, notified: await notifyAdmins(env, db, health, account) }
  } catch (err) {
    console.error(`channel monitor failed [${account?.name}]:`, err?.message || err)
    return { connected: null, notified: 0, error: String(err?.message || err) }
  }
}

async function notifyAdmins(env, db, health, account) {
  const admins =
    unwrap(
      await db.from('wp_chat_users').select('id').eq('role', 'admin').eq('is_active', true)
    ) || []
  if (!admins.length) return 0

  const subscriptions =
    unwrap(
      await db
        .from('wp_chat_push_subscriptions')
        .select('id, user_id, endpoint, p256dh, auth, failure_count')
        .in('user_id', admins.map((a) => a.id))
    ) || []
  if (!subscriptions.length) return 0

  const payload = {
    // Names the account — with several connected, "WhatsApp disconnected" alone
    // does not say which number an admin needs to go and fix.
    title: account?.name ? `${account.name}: WhatsApp disconnected` : 'WhatsApp disconnected',
    body: `The channel is ${health.status}. Messages are not being sent or received.`,
    // No conversation to deep-link to; the SW falls back to /inbox.
    conversation_id: null,
  }

  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      const result = await sendPush(env, subscription, payload)
      if (!result.ok) {
        console.error('channel alert push failed:', JSON.stringify({
          subscription_id: subscription.id,
          status: result.status,
          gone: Boolean(result.gone),
          response: result.body || null,
        }))
        if (result.gone) {
          await db
            .from('wp_chat_push_subscriptions')
            .delete()
            .eq('id', subscription.id)
            .catch(() => {})
        }
      }
      return result.ok
    })
  )

  return results.filter(Boolean).length
}
