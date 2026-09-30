/**
 * Which app places a call on a phone.
 *
 * On desktop a browser extension (Linku) picks up the plain `tel:` anchor and
 * dials through RingQ, so nothing here is involved. A phone has no extension:
 * `tel:` goes straight to the OS dialer, which rings from the SIM (iOS then
 * only asks "Primary / Personal" — both SIM lines, never RingQ). So on mobile
 * the call control asks first and hands the number to the RingQ app directly.
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
// iPadOS reports itself as a Mac, so a touch-capable "Mac" counts as iOS.
export const isIOS =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
export const isAndroid = /Android/i.test(ua)

/** True where there is no dialer extension and the chooser should be shown. */
export const isMobileDialer = isIOS || isAndroid

/**
 * Link that opens RingQ with `digits` in its dialer, or null where there is
 * none — in which case the chooser copies the number for pasting instead.
 *
 * None is known today. iOS: RingQ publishes no URL scheme. Android: an intent
 * pinned to RingQ's package (com.ringq.app) falls through to the Play Store,
 * because RingQ has no browsable activity for Chrome to launch.
 *
 * public/ringq-test.html tries every candidate on a real phone; return the
 * one that works here.
 */
export function ringqHref(digits) {
  return null
}
