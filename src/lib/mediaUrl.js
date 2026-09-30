import { useEffect, useState } from 'react'
import { api } from './api.js'

// One signed-URL cache for the whole app — media attachments AND avatars.
// Signed URLs last 60 minutes; without this the 4s thread poll and every
// conversation-list render would re-mint them.
const urlCache = new Map()
// Dedupes concurrent requests for the same path, e.g. a list of rows that all
// mount at once.
const inFlight = new Map()

const REFRESH_BEFORE_MS = 50 * 60 * 1000

export function getCachedUrl(path) {
  return path ? urlCache.get(path) : undefined
}

async function resolve(path, signal) {
  if (urlCache.has(path)) return urlCache.get(path)
  if (inFlight.has(path)) return inFlight.get(path)

  const request = api
    .mediaUrl(path, signal)
    .then((data) => {
      urlCache.set(path, data.url)
      // Re-mint comfortably before the 60 minute expiry.
      setTimeout(() => urlCache.delete(path), REFRESH_BEFORE_MS)
      return data.url
    })
    .finally(() => inFlight.delete(path))

  inFlight.set(path, request)
  return request
}

/**
 * Resolves a private storage path to a signed URL.
 * Returns {url, error} — url is null until it resolves.
 */
export function useSignedUrl(path) {
  const [state, setState] = useState(() =>
    path && urlCache.has(path) ? { url: urlCache.get(path), error: null } : { url: null, error: null }
  )

  useEffect(() => {
    if (!path) {
      setState({ url: null, error: null })
      return undefined
    }
    if (urlCache.has(path)) {
      setState({ url: urlCache.get(path), error: null })
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false

    resolve(path, controller.signal)
      .then((url) => {
        if (!cancelled) setState({ url, error: null })
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return
        setState({ url: null, error: err.message })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [path])

  return state
}
