import { requireAuth } from '../../_lib/auth.js'
import { checkHealth, launchChannel, fetchLoginQr } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'
import { resolveAccountAccess, envForAccount, isAccountConfigured } from '../../_lib/accounts.js'

// WhatsApp rotates the pairing QR roughly every 20 seconds; the client uses
// this to show an expiry countdown and refetch before it dies.
const QR_TTL_SECONDS = 20

// Only 'QR' means Whapi can actually render the pairing image. STARTING/LAUNCHING
// are still coming up — we poll THROUGH them but must NOT fetch the image there
// (that is what 500s). Reaching 'QR' is what gates the fetch.
const QR_READY_STATE = 'QR'

// After asking Whapi to launch, poll /health this many times waiting to reach
// 'QR'. If it never does, we return soft "starting" and the client retries.
const READY_POLL_ATTEMPTS = 4
const READY_POLL_MS = 1200

// Whapi's image endpoint is INTERMITTENT even at 'QR' — it often succeeds on a
// later attempt. Give it several tries, spaced out, alternating no-wakeup /
// wakeup (the two read modes fail independently). Only 502 after genuinely
// exhausting these. A total-time cap keeps the request from hanging.
const IMAGE_FETCH_ATTEMPTS = 6
const IMAGE_RETRY_MS = 1500
const IMAGE_MAX_TOTAL_MS = 12000

// How long the client should wait before asking again while still starting.
const STARTING_RETRY_SECONDS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const starting = (status) =>
  json({ ok: false, connected: false, status: 'starting', channel_status: status ?? null, retry_in: STARTING_RETRY_SECONDS }, 200)

/**
 * GET /api/channel/qr  (any authenticated user)
 *
 * Returns a fresh login QR as a data URL, OR reports that the channel is
 * already connected, OR a soft "starting" the client should retry.
 *
 * Flow (Bug 2 fix — launch and fetch are decoupled):
 *   1. If already AUTH, no QR is needed.
 *   2. Ask Whapi to (re)launch the channel (wakeup), then poll /health until it
 *      reaches a QR-ready state (QR/STARTING).
 *   3. Fetch /users/login/image WITHOUT wakeup — a pure read of a QR that now
 *      exists. Whapi's transitional 500 is mapped to a soft "starting".
 *
 * Open to any signed-in user: when WhatsApp drops, whoever is on shift needs to
 * be able to scan the QR and reconnect — not just an admin. requireAuth still
 * keeps it behind a valid session.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  // Which account's channel to show a QR for. The whole flow below runs on this
  // account's credentials, so scanning connects the number the user expects.
  const url = new URL(request.url)
  const access = await resolveAccountAccess(env, auth.user, url.searchParams.get('account_id'))
  if (access.response) return access.response

  const accountEnv = await envForAccount(env, access.accountId)
  if (!isAccountConfigured(accountEnv)) {
    return json({
      ok: false,
      account_id: access.accountId,
      connected: false,
      status: 'not_configured',
      error: 'This account has no Whapi token configured yet',
    })
  }

  // Cheap guard first: if we are already AUTH, do not even mint a QR.
  const health = await checkHealth(accountEnv)
  if (health.connected) {
    return json({ ok: true, connected: true, status: health.status })
  }

  // Launch, then poll /health until the channel reaches 'QR' (or connects). We
  // poll THROUGH STARTING/LAUNCHING but never fetch the image there. launchChannel
  // is GET /health?wakeup=true, so its result is already the first health read.
  let state = await launchChannel(accountEnv)
  for (let i = 0; i < READY_POLL_ATTEMPTS && !state.connected && state.status !== QR_READY_STATE; i++) {
    await sleep(READY_POLL_MS)
    state = await checkHealth(accountEnv)
  }

  if (state.connected) {
    return json({ ok: true, connected: true, status: state.status })
  }

  console.log(
    'whapi QR: channel state before fetch',
    JSON.stringify({ status: state.status, code: state.code ?? null, connected: state.connected })
  )

  // Still coming up (not yet 'QR'): soft "starting" — the client retries, but
  // only up to a total-time cap so a stuck launch surfaces rather than spins.
  if (state.status !== QR_READY_STATE) {
    console.log('whapi QR: not QR-ready yet, returning starting', JSON.stringify({ status: state.status }))
    return starting(state.status)
  }

  // Channel reports 'QR' — the image SHOULD render now, but Whapi's image
  // endpoint is intermittent here. Retry several times, spaced out, alternating
  // no-wakeup / wakeup, and record EXACTLY what Whapi returned on each attempt.
  const attempts = []
  const startedAt = Date.now()
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt++) {
    const wakeup = attempt % 2 === 0 // alternate: 1 no-wakeup, 2 wakeup, 3 no-wakeup, …
    const qr = await fetchLoginQr(accountEnv, { size: 400, wakeup })

    // Whapi answered 409 "already authenticated" — treat as connected.
    if (qr.alreadyAuthed) {
      return json({ ok: true, connected: true, status: 'AUTH' })
    }
    if (qr.ok) {
      // Use Whapi's own `expire` (seconds) for the refresh countdown when given.
      return json({ ok: true, connected: false, status: 'QR', qr: qr.dataUrl, expires_in: qr.expiresIn ?? QR_TTL_SECONDS })
    }

    const record = { attempt, wakeup, image_status: qr.status ?? null, image_body: qr.body ?? qr.error ?? null }
    attempts.push(record)
    console.error(
      'whapi QR: image fetch FAILED while channel_status=QR',
      JSON.stringify({ of: IMAGE_FETCH_ATTEMPTS, channel_status: state.status, ...record })
    )

    // Stop early if we have run out of time; otherwise space out the next try.
    if (Date.now() - startedAt >= IMAGE_MAX_TOTAL_MS) break
    if (attempt < IMAGE_FETCH_ATTEMPTS) await sleep(IMAGE_RETRY_MS)
  }

  // Genuinely exhausted at 'QR'. Surface EXACTLY what Whapi returned on every
  // attempt (status + raw body, both read modes) in the 502 body, so it is
  // visible in the network tab — not only the server logs.
  console.error(
    'whapi QR: image persistently unavailable at QR-ready state',
    JSON.stringify({ channel_status: state.status, attempts })
  )
  const last = attempts[attempts.length - 1] || {}
  return json(
    {
      ok: false,
      connected: false,
      status: state.status,
      channel_status: state.status,
      image_status: last.image_status ?? null,
      image_body: last.image_body ?? null,
      attempts, // [{ attempt, wakeup, image_status, image_body }] — every Whapi response
      error: 'qr_unavailable',
    },
    502
  )
}
