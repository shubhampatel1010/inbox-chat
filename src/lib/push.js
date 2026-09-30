import { api } from './api.js'
import { isIOS, isStandalone } from './pwa.js'

// Web push. Deliberately defensive: iOS only supports this from an installed
// PWA on 16.4+, it is unavailable to EU PWAs on 17.4+, and it silently drops
// subscriptions — so every path here has to degrade rather than throw.

// ---------------------------------------------------------------- tracing
// TEMPORARY diagnostics. Remove together with the diagnostics panel once the
// iOS subscription failure is understood.
const LOG_PREFIX = '[push]'
const trace = []
let lastError = null

function step(name, detail) {
  const entry = { at: new Date().toISOString().slice(11, 23), name, detail }
  trace.push(entry)
  if (trace.length > 60) trace.shift()
  // eslint-disable-next-line no-console
  console.log(`${LOG_PREFIX} ${name}`, detail === undefined ? '' : detail)
  return entry
}

/** Verbatim, including the error name — the generic catch used to eat this. */
function describeError(err) {
  if (!err) return null
  if (typeof err === 'string') return err
  const name = err.name || 'Error'
  const message = err.message || String(err)
  return err.code ? `${name}: ${message} (code ${err.code})` : `${name}: ${message}`
}

function recordError(where, err) {
  lastError = `${where} → ${describeError(err)}`
  step(`error:${where}`, lastError)
  return lastError
}

export const getPushTrace = () => [...trace]
export const getLastPushError = () => lastError

export const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied' */
export function pushState() {
  // On iOS, push exists only once the app is on the home screen. In a Safari
  // tab PushManager may be absent entirely, so check this before support.
  if (isIOS() && !isStandalone()) return 'needs-install'
  if (!PUSH_SUPPORTED) return 'unsupported'
  return Notification.permission
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.ready
}

/**
 * Creates (or reuses) a subscription and registers it server-side.
 * Returns {ok, reason}. Never throws.
 */
export async function subscribeToPush() {
  const state = pushState()
  step('subscribeToPush:start', { state })

  if (state === 'needs-install') return { ok: false, reason: 'needs-install' }
  if (state === 'unsupported') return { ok: false, reason: 'unsupported' }
  if (state === 'denied') return { ok: false, reason: 'denied' }

  try {
    const reg = await registration()
    step('serviceWorker.ready', reg ? { scope: reg.scope, active: !!reg.active } : null)
    if (!reg) return { ok: false, reason: 'unsupported' }

    let key
    try {
      const res = await api.pushKey()
      key = res?.key
      step('GET /api/push/key', { status: 200, keyPresent: Boolean(key) })
    } catch (err) {
      recordError('GET /api/push/key', err)
      return { ok: false, reason: 'key-fetch-failed', error: describeError(err) }
    }
    if (!key) return { ok: false, reason: 'not-configured' }

    let subscription = await reg.pushManager.getSubscription()
    step('getSubscription', { existing: Boolean(subscription) })

    if (!subscription) {
      try {
        subscription = await reg.pushManager.subscribe({
          // Required by every browser, and mandatory on iOS.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        })
        step('pushManager.subscribe', { ok: true })
      } catch (err) {
        // iOS 17.4+ in the EU throws here; so does a revoked permission.
        recordError('pushManager.subscribe', err)
        return { ok: false, reason: 'subscribe-failed', error: describeError(err) }
      }
    }

    try {
      await api.pushSubscribe(subscription.toJSON())
      step('POST /api/push/subscribe', { ok: true })
    } catch (err) {
      recordError('POST /api/push/subscribe', err)
      return { ok: false, reason: 'save-failed', error: describeError(err) }
    }

    lastError = null
    return { ok: true }
  } catch (err) {
    recordError('subscribeToPush', err)
    return { ok: false, reason: 'failed', error: describeError(err) }
  }
}

/** Must be called from a real user gesture — iOS ignores it otherwise. */
export async function requestPushPermission() {
  const state = pushState()
  step('requestPushPermission:start', {
    state,
    standalone: navigator.standalone,
    displayMode: window.matchMedia('(display-mode: standalone)').matches,
  })

  if (state === 'needs-install') return { ok: false, reason: 'needs-install' }
  if (state === 'unsupported') return { ok: false, reason: 'unsupported' }
  // The prompt can only ever be shown once; after that it is a Settings trip.
  if (state === 'denied') return { ok: false, reason: 'denied' }

  try {
    const permission = await Notification.requestPermission()
    step('Notification.requestPermission', { result: permission })

    if (permission !== 'granted') {
      // 'default' means the prompt was dismissed or never shown — previously
      // this returned silently with no toast at all.
      lastError = `Notification.requestPermission returned "${permission}"`
      return { ok: false, reason: permission, error: lastError }
    }
    return subscribeToPush()
  } catch (err) {
    recordError('Notification.requestPermission', err)
    return { ok: false, reason: 'failed', error: describeError(err) }
  }
}

export async function disablePush() {
  try {
    const reg = await registration()
    const subscription = reg && (await reg.pushManager.getSubscription())
    if (!subscription) return { ok: true }

    const endpoint = subscription.endpoint
    await subscription.unsubscribe().catch(() => {})
    await api.pushUnsubscribe(endpoint).catch(() => {})
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * Called on every app start once signed in.
 *
 * iOS is known to discard push subscriptions silently while leaving the
 * permission granted, so "permission is granted" is not evidence that a
 * subscription still exists — re-subscribe whenever one is missing.
 */
export async function ensurePushSubscription() {
  if (pushState() !== 'granted') return { ok: false, reason: 'not-granted' }
  return subscribeToPush()
}

/**
 * TEMPORARY. Gathers everything needed to diagnose an iOS subscription
 * failure on-device, with no debugger attached. Never returns the VAPID key
 * or the subscription's crypto material — only whether they are present.
 */
export async function collectPushDiagnostics() {
  const out = {}
  const safe = (label, fn) => {
    try {
      out[label] = fn()
    } catch (err) {
      out[label] = `threw: ${describeError(err)}`
    }
  }

  safe('navigator.standalone', () => String(navigator.standalone))
  safe('display-mode: standalone', () =>
    String(window.matchMedia('(display-mode: standalone)').matches)
  )
  safe('display-mode: fullscreen', () =>
    String(window.matchMedia('(display-mode: fullscreen)').matches)
  )
  safe('isStandalone()', () => String(isStandalone()))
  safe('isIOS()', () => String(isIOS()))
  safe('typeof Notification', () => typeof Notification)
  safe('Notification.permission', () =>
    typeof Notification === 'undefined' ? 'n/a' : Notification.permission
  )
  safe('PushManager on window', () => String('PushManager' in window))
  safe('serviceWorker in navigator', () => String('serviceWorker' in navigator))
  safe('pushState()', () => pushState())
  safe('userAgent', () => navigator.userAgent)

  // Service worker
  try {
    const reg = (await navigator.serviceWorker?.getRegistration?.()) || null
    if (!reg) {
      out['sw registration'] = 'none'
    } else {
      out['sw registration'] = 'present'
      out['sw scope'] = reg.scope
      out['sw state'] = reg.active
        ? `active (${reg.active.state})`
        : reg.installing
          ? 'installing'
          : reg.waiting
            ? 'waiting'
            : 'unknown'
      out['sw script'] = (reg.active || reg.installing || reg.waiting)?.scriptURL || 'n/a'
    }
  } catch (err) {
    out['sw registration'] = `threw: ${describeError(err)}`
  }

  // Existing subscription.
  //
  // serviceWorker.ready NEVER resolves when there is no registration — it does
  // not reject, it just hangs. That is a prime suspect for the reported
  // symptom (toggle stuck, no network call, no error), so it is raced against
  // a timeout and reported explicitly rather than being allowed to hang.
  try {
    const reg = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000)),
    ])

    if (reg === 'TIMEOUT') {
      out['serviceWorker.ready'] = 'DID NOT RESOLVE within 3s — subscribe would hang here'
      out['getSubscription()'] = 'not reached'
      throw new Error('skip')
    }
    out['serviceWorker.ready'] = 'resolved'

    const sub = reg ? await reg.pushManager.getSubscription() : null
    if (!sub) {
      out['getSubscription()'] = 'null (no existing subscription)'
    } else {
      const json = sub.toJSON()
      const endpoint = json.endpoint || ''
      // Host plus a short tail only — never the full endpoint or the keys.
      out['getSubscription()'] = `present · ${new URL(endpoint).host} · …${endpoint.slice(-8)}`
      out['subscription keys'] = `p256dh ${json.keys?.p256dh ? 'present' : 'ABSENT'}, auth ${
        json.keys?.auth ? 'present' : 'ABSENT'
      }`
    }
  } catch (err) {
    if (err?.message !== 'skip') out['getSubscription()'] = `threw: ${describeError(err)}`
  }

  // VAPID key endpoint — status and presence only.
  try {
    const res = await api.pushKey()
    out['GET /api/push/key'] = `HTTP 200 · key ${res?.key ? 'present' : 'ABSENT'}`
  } catch (err) {
    out['GET /api/push/key'] = `HTTP ${err?.status ?? '?'} · ${describeError(err)}`
  }

  out['last error'] = lastError || 'none recorded'

  // eslint-disable-next-line no-console
  console.log(`${LOG_PREFIX} diagnostics`, out)
  return { fields: out, trace: getPushTrace() }
}

/**
 * App badge. iOS 16.4+ supports this for installed PWAs; everywhere else the
 * call simply does not exist, so it is guarded rather than feature-detected
 * per platform.
 */
export function setAppBadge(count) {
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count).catch(() => {})
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {})
  } catch {
    /* badge support is cosmetic — never let it surface */
  }
}
