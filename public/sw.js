/* Service worker — app shell only.
 *
 * Deliberately narrow: it caches the HTML/JS/CSS shell with a NETWORK-FIRST
 * strategy so a deploy is live immediately, and it stays completely out of the
 * way of everything else. Anything it does not explicitly handle falls through
 * to the browser untouched.
 *
 * Never handled (must always hit the network, uncached):
 *   - /api/*            message data, the 4s/5s polls, uploads, auth
 *   - cross-origin      Supabase signed media URLs (they expire; a cached copy
 *                       would 403 later, and their query token varies)
 *   - non-GET           logins, sends, refreshes
 */

const VERSION = 'v1'
const SHELL_CACHE = `inbox-shell-${VERSION}`

// Minimum needed to boot offline. Hashed asset filenames change per build, so
// they are cached opportunistically on first fetch rather than precached.
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {
        // A failed precache must not block activation of a new deploy.
      })
      // Take over immediately so a new deploy activates without the user
      // force-quitting the app.
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

// Lets the page trigger activation of a waiting worker.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

// ---------------------------------------------------------------- push
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'New message', body: event.data ? event.data.text() : '' }
  }

  const conversationId = data.conversation_id ?? null

  event.waitUntil(
    self.registration.showNotification(data.title || 'New message', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Keyed to the conversation so several messages from one contact replace
      // each other instead of stacking up on the lock screen.
      tag: conversationId ? `conversation-${conversationId}` : 'inbox',
      renotify: true,
      data: { conversationId, url: conversationId ? `/inbox?c=${conversationId}` : '/inbox' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = event.notification.data?.url || '/inbox'
  const conversationId = event.notification.data?.conversationId ?? null

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Prefer focusing a window that is already open — launching a second one
      // would lose the agent's place.
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        // The page listens for this and routes without a reload.
        client.postMessage({ type: 'OPEN_CONVERSATION', conversationId })
        return
      }

      if (self.clients.openWindow) await self.clients.openWindow(target)
    })()
  )
})

function isShellRequest(request, url) {
  if (request.method !== 'GET') return false
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false

  // SPA navigations resolve to index.html via _redirects.
  if (request.mode === 'navigate') return true

  return /\.(?:js|css|html|webmanifest)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Not ours — no respondWith, so the browser handles it normally. This is
  // what keeps the polls and signed media URLs completely untouched.
  if (!isShellRequest(event.request, url)) return

  event.respondWith(
    (async () => {
      try {
        // Network first: a fresh deploy wins over anything cached.
        const response = await fetch(event.request)
        if (response && response.ok) {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      } catch {
        // Offline — fall back to the cached shell.
        const cached = await caches.match(event.request)
        if (cached) return cached

        // A navigation with no exact match still needs the SPA entry point.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html')
          if (shell) return shell
        }
        throw new Error('offline and not cached')
      }
    })()
  )
})
