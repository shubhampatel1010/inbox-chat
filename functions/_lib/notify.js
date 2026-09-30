import { getDb, unwrap } from './db.js'
import { sendPush } from './push.js'

const MAX_FAILURES = 5
const PREVIEW_LIMIT = 140

/** Notification body for a message, falling back to a media label. */
export function previewFor(message) {
  const text = (message?.body || message?.media_caption || '').trim()
  if (text) return text.slice(0, PREVIEW_LIMIT)

  switch (message?.media_type) {
    case 'image':
      return '📷 Photo'
    case 'video':
      return '🎥 Video'
    case 'audio':
      return '🎵 Audio'
    case 'document':
      return '📄 Document'
    default:
      return 'New message'
  }
}

/**
 * Who should hear about this conversation.
 *
 * Assigned → that agent alone. Unassigned → every active user WITH ACCESS TO
 * THIS CONVERSATION'S ACCOUNT, admins included: an unassigned conversation sits
 * in the inbox of everyone who can see it, so limiting it to role='agent' would
 * leave admins unaware of unclaimed messages.
 *
 * The account filter is what stops a push for account A reaching an agent who
 * only works account B — they would get a notification for a chat they cannot
 * open, which leaks the customer's name and message preview across the boundary
 * the rest of the system enforces.
 */
async function recipientIds(env, conversation) {
  const db = getDb(env)

  if (conversation?.assigned_user_id) {
    const user = unwrap(
      await db
        .from('wp_chat_users')
        .select('id')
        .eq('id', conversation.assigned_user_id)
        .eq('is_active', true)
        .maybeSingle()
    )
    return user ? [user.id] : []
  }

  const users =
    unwrap(await db.from('wp_chat_users').select('id, role').eq('is_active', true)) || []

  const accountId = conversation?.account_id ?? null
  // No account on the row (a pre-migration remnant) keeps the original
  // behaviour rather than silently notifying nobody.
  if (accountId == null) return users.map((u) => u.id)

  const members =
    unwrap(
      await db.from('wp_chat_user_accounts').select('user_id').eq('account_id', accountId)
    ) || []
  const assigned = new Set(members.map((m) => String(m.user_id)))

  // Admins reach every account by role, so they are included without a
  // membership row — matching accessibleAccountIds().
  return users.filter((u) => u.role === 'admin' || assigned.has(String(u.id))).map((u) => u.id)
}

/** Host only — the endpoint path contains the device token. */
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host
  } catch {
    return 'unknown-host'
  }
}

/** Records the outcome of one delivery, pruning subscriptions that are dead. */
async function recordOutcome(db, subscription, result) {
  if (!result.ok) {
    // Every rejection is logged, not just thrown ones — a non-2xx from the
    // push service previously left no trace at all in the tail.
    console.error(
      'push send failed:',
      JSON.stringify({
        subscription_id: subscription.id,
        user_id: subscription.user_id,
        host: endpointHost(subscription.endpoint),
        status: result.status,
        gone: Boolean(result.gone),
        error: result.error || null,
        // Body of the rejection — Apple returns the actual reason here.
        response: result.body || null,
        failure_count_before: Number(subscription.failure_count) || 0,
      })
    )
  }

  if (result.ok) {
    await db
      .from('wp_chat_push_subscriptions')
      .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
      .eq('id', subscription.id)
    return
  }

  // 404/410 mean the browser threw the subscription away — remove it now
  // rather than retrying a dead endpoint forever.
  if (result.gone) {
    await db.from('wp_chat_push_subscriptions').delete().eq('id', subscription.id)
    return
  }

  const failures = (Number(subscription.failure_count) || 0) + 1
  if (failures >= MAX_FAILURES) {
    await db.from('wp_chat_push_subscriptions').delete().eq('id', subscription.id)
    return
  }

  await db
    .from('wp_chat_push_subscriptions')
    .update({ failure_count: failures })
    .eq('id', subscription.id)
}

/**
 * Fan out one inbound message to every relevant subscription.
 *
 * Never throws — the caller hands this to waitUntil, so a failure here must
 * not affect the webhook's response.
 */
export async function notifyNewMessage(env, { conversation, message, title, senderName }) {
  try {
    const db = getDb(env)

    const userIds = await recipientIds(env, conversation)
    if (!userIds.length) {
      console.log(`push fan-out: conversation ${conversation.id} · no recipients`)
      return { sent: 0 }
    }

    const subscriptions =
      unwrap(
        await db
          .from('wp_chat_push_subscriptions')
          .select('id, user_id, endpoint, p256dh, auth, failure_count')
          .in('user_id', userIds)
      ) || []

    if (!subscriptions.length) {
      console.log(
        `push fan-out: conversation ${conversation.id} · 0 subscription(s) found for ${userIds.length} recipient(s)`
      )
      return { sent: 0 }
    }

    const preview = previewFor(message)
    const payload = {
      title: title || 'New message',
      // In a group the title is the group, so the sender goes in the body —
      // otherwise every group notification looks identical.
      body: senderName ? `${senderName}: ${preview}` : preview,
      conversation_id: conversation.id,
      message_id: message?.id ?? null,
    }

    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = await sendPush(env, subscription, payload)
        await recordOutcome(db, subscription, result).catch(() => {})
        return result.ok
      })
    )

    const sent = results.filter(Boolean).length
    const failed = results.length - sent

    console.log(
      `push fan-out: conversation ${conversation.id} · ${subscriptions.length} subscription(s) found · ${sent} sent · ${failed} failed`
    )

    return { sent, total: subscriptions.length, failed }
  } catch (err) {
    console.error('push fan-out failed:', err?.message || err)
    return { sent: 0, error: String(err?.message || err) }
  }
}
