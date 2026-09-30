// Automatic gap detection + recovery, driven by the 60s status poll.
//
// There is no cron (Pages does not support it). The only observer of the
// channel is the status endpoint, which any open tab hits every 60s. So:
//
//   connected -> disconnected : record when the gap began.
//   disconnected -> connected : the gap just closed — create a recovery sync
//                               for [gap start, now], buffered.
//
// ONE wp_chat_channel_state row PER ACCOUNT (account_id, key='channel') holds
// that account's last observed state. Per-account is essential: with a single
// shared row, account B's disconnect would overwrite account A's state and the
// reconnect would create a recovery job that walked the wrong channel's history.
// The reconnect flip is a compare-and-swap, so when several tabs observe the
// same reconnect only ONE creates the recovery job.
//
// The account is taken from the account-scoped env (env.ACCOUNT_ID), so callers
// pass the same scoped env they already use for the health check.
//
// Accepted, surfaced limitation: an outage that both starts AND ends while
// nobody has the app open is never observed, so never auto-recovered. But an
// outage that ended while the app was closed IS caught the next time the app
// opens: the first poll sees the persisted 'disconnected' against a live
// 'connected' — the same reconnect transition — and recovers it.

import { getDb, unwrap } from './db.js'

const STATE_KEY = 'channel'

// Buffer added to EACH side of the recovered window.
//
// The poll runs every 60s, so the true disconnect happened up to a poll
// interval before we noticed, and likewise for the reconnect; add clock skew
// between our server and Whapi's message timestamps. 5 minutes comfortably
// covers a 60s poll plus skew, so no boundary message is missed. Over-fetching
// is harmless — dedup on whapi_message_id means a message already stored is
// never written twice. It is kept small on purpose: a recovery buffer, never
// an import.
export const GAP_BUFFER_SECONDS = 5 * 60

// Above this, the "gap" is not an outage, it is a migration. Auto-running a
// multi-day unattended backfill is exactly what we must not do, so anything
// longer is recorded as a DEFERRED job for an admin to run deliberately.
// 24h covers a plausible real outage (e.g. down overnight) with margin.
export const MAX_AUTO_GAP_SECONDS = 24 * 60 * 60

const iso = (d) => d.toISOString()

/**
 * Observe the channel after a live health check. Persists state, detects the
 * two transitions, and on reconnect creates a recovery job for the gap.
 *
 * NEVER throws — a failure here must not break the status poll. Returns
 *   { auto: { job_id, from_ts, to_ts } | null, halted: string | null }
 * where `auto` is the recovery job an admin tab should drive, if any.
 */
export async function observeChannel(env, health) {
  try {
    const db = getDb(env)
    const now = new Date()
    const nowIso = iso(now)
    const connected = health.connected === true
    const status = health.status ?? null

    const accountId = env?.ACCOUNT_ID ?? null

    const prev = unwrap(
      await db
        .from('wp_chat_channel_state')
        .select('id, connected, status, checked_at, changed_at, gap_started_at, auto_halted_reason')
        .eq('key', STATE_KEY)
        .eq('account_id', accountId)
        .maybeSingle()
    )

    // First observation ever: seed, no gap to recover.
    if (!prev) {
      unwrap(
        await db
          .from('wp_chat_channel_state')
          .insert({ account_id: accountId, key: STATE_KEY, connected, status, checked_at: nowIso, changed_at: nowIso })
      )
      return { auto: null, halted: null }
    }

    const wasConnected = prev.connected === true

    // No transition: just refresh checked_at/status. Still report any pending
    // recovery so a freshly-opened admin tab picks it up and drives it.
    if (wasConnected === connected) {
      unwrap(
        await db
          .from('wp_chat_channel_state')
          .update({ status, checked_at: nowIso })
          .eq('id', prev.id)
      )
      return { auto: await currentAutoJob(db, accountId), halted: prev.auto_halted_reason || null }
    }

    // connected -> disconnected: mark the gap start at the LAST-known-good poll,
    // so the ~60s between that poll and now (when messages were already being
    // lost) is inside the window. CAS on connected=true so racing polls don't
    // double-write.
    if (wasConnected && !connected) {
      unwrap(
        await db
          .from('wp_chat_channel_state')
          .update({
            connected: false,
            status,
            checked_at: nowIso,
            changed_at: nowIso,
            gap_started_at: prev.checked_at || prev.changed_at || nowIso,
          })
          .eq('id', prev.id)
          .eq('connected', true)
      )
      return { auto: null, halted: prev.auto_halted_reason || null }
    }

    // disconnected -> connected: the gap closed. CAS-flip; only the winner
    // creates the recovery job.
    const flipped =
      unwrap(
        await db
          .from('wp_chat_channel_state')
          .update({
            connected: true,
            status,
            checked_at: nowIso,
            changed_at: nowIso,
            gap_started_at: null,
          })
          .eq('id', prev.id)
          .eq('connected', false)
          .select('id')
      ) || []

    if (!flipped.length) {
      // Another poll won the flip and (if appropriate) created the job.
      return { auto: await currentAutoJob(db, accountId), halted: prev.auto_halted_reason || null }
    }

    // A prior account-level error halted auto-recovery — do not start a new one.
    if (prev.auto_halted_reason) {
      return { auto: null, halted: prev.auto_halted_reason }
    }

    const gapStartMs = new Date(prev.gap_started_at || prev.changed_at || nowIso).getTime()
    const gapEndMs = now.getTime()
    const gapSeconds = Math.max(0, Math.floor((gapEndMs - gapStartMs) / 1000))

    const scope = {
      type: 'auto',
      from_ts: Math.floor(gapStartMs / 1000) - GAP_BUFFER_SECONDS,
      to_ts: Math.floor(gapEndMs / 1000) + GAP_BUFFER_SECONDS,
      gap_seconds: gapSeconds,
    }

    const tooLong = gapSeconds > MAX_AUTO_GAP_SECONDS
    const job = unwrap(
      await db
        .from('wp_chat_sync_jobs')
        .insert({
          // Too long -> recorded but NOT auto-run; an admin runs it from the
          // Sync page.
          status: tooLong ? 'deferred' : 'pending',
          account_id: accountId,
          scope,
          cursor: {},
          created_by: null,
          ...(tooLong
            ? {
                last_error: `Outage of ~${Math.round(gapSeconds / 3600)}h exceeds the ${Math.round(
                  MAX_AUTO_GAP_SECONDS / 3600
                )}h auto-recovery limit — run this manually.`,
              }
            : {}),
        })
        .select('id, status, scope')
        .single()
    )

    return {
      auto: tooLong ? null : { job_id: job.id, from_ts: scope.from_ts, to_ts: scope.to_ts },
      halted: null,
    }
  } catch (err) {
    // Swallow: the status poll must keep working even if state persistence fails.
    console.error('observeChannel failed:', err?.message || err)
    return { auto: null, halted: null }
  }
}

/**
 * The recovery job an admin tab should drive right now: the oldest pending or
 * running auto job, if any. Driving one at a time is what "only one auto-sync
 * at a time" means. Never throws.
 */
async function currentAutoJob(db, accountId = null) {
  try {
    let builder = db
      .from('wp_chat_sync_jobs')
      .select('id, status, scope')
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: true })
      .limit(20)

    // Scoped so an admin tab viewing account A never starts driving account B's
    // recovery — which would run against A's credentials and walk the wrong
    // channel.
    if (accountId != null) builder = builder.eq('account_id', accountId)

    const rows = unwrap(await builder) || []
    const auto = rows.find((j) => j?.scope?.type === 'auto')
    if (!auto) return null
    return { job_id: auto.id, from_ts: auto.scope.from_ts, to_ts: auto.scope.to_ts }
  } catch {
    return null
  }
}

/** Record an account-level halt (e.g. Whapi 402). Never throws. */
export async function haltAutoRecovery(env, reason) {
  try {
    let builder = getDb(env)
      .from('wp_chat_channel_state')
      .update({ auto_halted_reason: String(reason || 'account_error').slice(0, 300) })
      .eq('key', STATE_KEY)

    // One account's quota failure must not pause every other account's recovery.
    const accountId = env?.ACCOUNT_ID ?? null
    if (accountId != null) builder = builder.eq('account_id', accountId)

    unwrap(await builder)
  } catch (err) {
    console.error('haltAutoRecovery failed:', err?.message || err)
  }
}

/** Clear the account-level halt (admin intervened). Never throws. */
export async function clearAutoHalt(env) {
  try {
    let builder = getDb(env)
      .from('wp_chat_channel_state')
      .update({ auto_halted_reason: null })
      .eq('key', STATE_KEY)

    const accountId = env?.ACCOUNT_ID ?? null
    if (accountId != null) builder = builder.eq('account_id', accountId)

    unwrap(await builder)
  } catch (err) {
    console.error('clearAutoHalt failed:', err?.message || err)
  }
}
