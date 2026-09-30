import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'

/** Long enough that a typist never fires a query mid-word, short enough to feel live. */
const DEBOUNCE_MS = 300

/** Mirrors MIN_QUERY_LENGTH in functions/_lib/search.js. */
export const MIN_QUERY_LENGTH = 2

const IDLE = { status: 'idle', results: [], hasMore: false, query: '' }

/**
 * Debounced message search.
 *
 * Deliberately independent of the 4s conversation poll and the 4s thread poll:
 * it owns its own AbortController and never touches inbox state, so a search
 * in flight cannot delay, cancel or be cancelled by either of them.
 *
 * Returns {status, results, hasMore, query} where status is
 * idle | loading | ready | error. `loading` is reported from the first
 * keystroke past the minimum length — not from when the request leaves —
 * because the debounce window is itself part of the wait, and a field that
 * looks settled while a query is pending reads as "no results".
 */
export function useMessageSearch(rawQuery, { conversationId = null, limit = null } = {}) {
  const [state, setState] = useState(IDLE)

  // Guards a slow response from overwriting a newer one, exactly as the
  // thread poll does. Aborting is not sufficient on its own: an abort that
  // lands after the response has already been parsed still resolves.
  const seqRef = useRef(0)

  useEffect(() => {
    const query = String(rawQuery || '').trim()

    if (query.length < MIN_QUERY_LENGTH) {
      seqRef.current++
      setState(IDLE)
      return undefined
    }

    const seq = ++seqRef.current
    const controller = new AbortController()

    setState((current) => ({ ...current, status: 'loading', query }))

    const timer = setTimeout(() => {
      api
        .search(query, { conversationId, limit, signal: controller.signal })
        .then((data) => {
          if (seq !== seqRef.current) return
          setState({
            status: 'ready',
            results: data.results || [],
            hasMore: Boolean(data.has_more),
            query,
          })
        })
        .catch((err) => {
          // A 401 has already triggered the session-lost path in api.js, and
          // an abort is the expected outcome of typing another character.
          if (seq !== seqRef.current) return
          if (err.name === 'AbortError' || err.status === 401) return
          setState({ status: 'error', results: [], hasMore: false, query })
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // Switching conversation with a query still typed must re-run the search
    // against the new thread, not keep the old thread's matches on screen.
  }, [rawQuery, conversationId, limit])

  return state
}
