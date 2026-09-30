// PWA plumbing: service-worker registration, standalone detection, and the
// install affordance. No UI here — components read these.

/** True when launched from the home screen / installed, on any platform. */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  // navigator.standalone is the iOS-only signal; display-mode covers the rest.
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches
  )
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; the touch check disambiguates.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  )
}

/** iOS Safari can install, but only via Share → Add to Home Screen. */
export const canShowIOSInstallHint = () => isIOS() && !isStandalone()

/**
 * Marks the document so CSS can react to standalone mode. The display-mode
 * media query alone misses older iOS, which only exposes navigator.standalone.
 */
export function markStandalone() {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-standalone', isStandalone() ? 'true' : 'false')
}

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // Registered after load so it never competes with the first paint or the
  // cold-start /api/refresh.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      // Explicit root scope: the worker is served from the domain root by
      // Cloudflare Pages, so it controls every route including /inbox.
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Ask a worker that is already waiting to take over immediately.
        if (registration.waiting) registration.waiting.postMessage('SKIP_WAITING')

        registration.addEventListener('updatefound', () => {
          const next = registration.installing
          if (!next) return
          next.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              next.postMessage('SKIP_WAITING')
            }
          })
        })
      })
      .catch((err) => {
        // A failed registration must never break the app.
        console.warn('Service worker registration failed:', err?.message || err)
      })
  })
}

/**
 * Captures beforeinstallprompt (Chrome/Edge, Android + desktop) so the app can
 * offer installation from its own menu. iOS never fires this.
 */
let deferredPrompt = null
const listeners = new Set()

const notify = () => listeners.forEach((fn) => fn(Boolean(deferredPrompt)))

export function watchInstallPrompt() {
  if (typeof window === 'undefined') return

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the mini-infobar; we surface it in the account menu instead.
    event.preventDefault()
    deferredPrompt = event
    notify()
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
    markStandalone()
  })
}

export function onInstallAvailabilityChange(fn) {
  listeners.add(fn)
  fn(Boolean(deferredPrompt))
  return () => listeners.delete(fn)
}

/** Returns true if the user accepted. Safe to call when nothing is deferred. */
export async function promptInstall() {
  if (!deferredPrompt) return false
  const event = deferredPrompt
  // A deferred prompt can only be used once.
  deferredPrompt = null
  notify()

  try {
    await event.prompt()
    const choice = await event.userChoice
    return choice?.outcome === 'accepted'
  } catch {
    return false
  }
}
