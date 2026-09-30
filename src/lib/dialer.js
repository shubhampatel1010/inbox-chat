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

/** RingQ's Android package id (from its Play Store listing). */
const RINGQ_ANDROID_PACKAGE = 'com.ringq.app'

/**
 * Link that opens the RingQ app, or null where there is none.
 *
 * Android: an intent URL pinned to RingQ's package. It opens RingQ (or its
 * Play Store page if not installed), but RingQ ignores the number in it, so
 * the chooser also offers the number to copy and paste.
 *
 * iOS: RingQ publishes no URL scheme, so there is no way to open it from a web
 * page. If RingQ support ever provides one, return it here for iOS.
 */
export function ringqHref(digits) {
  if (isAndroid) {
    return `intent:${digits}#Intent;scheme=tel;action=android.intent.action.DIAL;package=${RINGQ_ANDROID_PACKAGE};end`
  }
  return null
}
