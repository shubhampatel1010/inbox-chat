import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../_lib/respond.js'

const CALCOM_API_VERSION = '2026-02-25'

/**
 * Create an instant Cal.com meeting for a conversation and return its link.
 *
 * This endpoint only MINTS the link. Sending it to the customer goes through
 * the ordinary /api/send from the client, so the invite is a normal outbound
 * message — persisted, previewed and delivered exactly like a typed reply.
 *
 * The meeting is a Cal.com booking that starts now on CALCOM_EVENT_TYPE_ID
 * (set that event type's location to Cal Video, or any video app, so the
 * booking comes back with a join URL). allowConflicts/allowBookingOutOfBounds
 * let "now" be booked even outside the host's configured availability — an
 * instant call is by definition not a scheduled slot.
 *
 * The attendee on the booking is the agent, not the customer: WhatsApp gives
 * us no email for the customer, and Cal.com requires one. The agent therefore
 * receives the Cal.com confirmation; the customer receives the link on
 * WhatsApp.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { conversation_id } = await readJson(request)
  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  const apiKey = env.CALCOM_API_KEY
  const eventTypeId = Number(env.CALCOM_EVENT_TYPE_ID)
  if (!apiKey || !Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return serverError('Video calls are not configured (CALCOM_API_KEY / CALCOM_EVENT_TYPE_ID)')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    const conversation = access.conversation

    const attendeeEmail = env.CALCOM_ATTENDEE_EMAIL || auth.user.email
    if (!attendeeEmail) return badRequest('Your user has no email address for the Cal.com booking')

    const customer =
      conversation.customer_name?.trim() || conversation.customer_number || 'WhatsApp contact'

    const baseUrl = (env.CALCOM_API_URL || 'https://api.cal.com').replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/v2/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CALCOM_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Cal.com rejects a start in the past, and the request takes a moment
        // to arrive — start on the next whole minute.
        start: nextMinuteIso(),
        eventTypeId,
        attendee: {
          name: auth.user.name || 'Agent',
          email: attendeeEmail,
          timeZone: env.CALCOM_TIMEZONE || 'UTC',
        },
        metadata: { conversation_id: String(conversationId), customer: String(customer).slice(0, 100) },
        allowConflicts: true,
        allowBookingOutOfBounds: true,
      }),
    })

    const data = await res.json().catch(() => null)
    if (!res.ok || data?.status === 'error') {
      const reason = data?.error?.message || data?.message || `HTTP ${res.status}`
      return json({ ok: false, error: `Cal.com: ${reason}` }, 502)
    }

    // A recurring event type answers with an array; the first occurrence is
    // the one starting now.
    const booking = Array.isArray(data?.data) ? data.data[0] : data?.data
    const url = [booking?.meetingUrl, booking?.location].find(
      (v) => typeof v === 'string' && /^https?:\/\//i.test(v)
    )
    if (!url) {
      return json(
        { ok: false, error: 'Cal.com booking has no video link — set the event type location to Cal Video' },
        502
      )
    }

    return json({ ok: true, url, booking_uid: booking?.uid || null })
  } catch (err) {
    return serverError(err.message || 'Failed to create video call')
  }
}

function nextMinuteIso() {
  const d = new Date(Date.now() + 60_000)
  d.setUTCSeconds(0, 0)
  return d.toISOString()
}
