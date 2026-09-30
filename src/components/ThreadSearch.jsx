import { useEffect, useRef, useState } from 'react'
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react'
import { useMessageSearch, MIN_QUERY_LENGTH } from '../lib/useMessageSearch.js'

/**
 * The stepper needs every match at once to say "3 of 12" and to wrap at the
 * ends, so it asks for the scoped ceiling rather than a page.
 */
const MATCH_LIMIT = 200

/**
 * In-thread search bar.
 *
 * Owns the query, the match list and the cursor into it. It does NOT own
 * scrolling — it reports the current match up to Inbox, which decides whether
 * that message is already in the loaded window or needs an anchored reload.
 */
export default function ThreadSearch({ conversationId, onGoTo, onQueryChange, onClose }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)

  const search = useMessageSearch(query, { conversationId, limit: MATCH_LIMIT })

  // Results are oldest-first from the server, which is reading order.
  const matches = search.results
  const ready = search.status === 'ready'
  const tooShort = query.trim().length < MIN_QUERY_LENGTH

  // Opening the bar should put the caret in it — the whole point is to type.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Publish the term so the thread can highlight every match in its window.
  // Only once the query is long enough to have been searched, otherwise a
  // single character would light up most of the thread.
  useEffect(() => {
    onQueryChange(tooShort ? '' : query.trim())
  }, [query, tooShort, onQueryChange])

  // A new result set invalidates the old cursor. Jumping to the first match
  // as soon as one exists is what makes typing feel like it is searching.
  const signature = ready ? matches.map((m) => m.message_id).join(',') : null
  useEffect(() => {
    if (!ready || !matches.length) return
    setIndex(0)
    onGoTo(matches[0].message_id)
  }, [signature])

  const step = (delta) => {
    if (!matches.length) return
    // Wraps at both ends: +length before the modulo keeps -1 from going
    // negative, which JS's % would otherwise preserve.
    const next = (index + delta + matches.length) % matches.length
    setIndex(next)
    onGoTo(matches[next].message_id)
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      // Shift-Enter walks backwards, matching every find bar on the platform.
      step(event.shiftKey ? -1 : 1)
    }
  }

  let status = ''
  if (tooShort) status = query.trim() ? `${MIN_QUERY_LENGTH}+ characters` : ''
  else if (search.status === 'loading') status = '…'
  else if (search.status === 'error') status = 'Failed'
  else if (!matches.length) status = 'No matches'
  else status = `${index + 1} of ${matches.length}${search.hasMore ? '+' : ''}`

  const canStep = ready && matches.length > 0

  return (
    <div className="thread-search" role="search">
      <div className="thread-search-field">
        <Search size={15} className="search-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          className="input"
          type="text"
          placeholder="Search this conversation"
          aria-label="Search this conversation"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* aria-live so a screen reader hears the count change on each step,
          without the count itself having to take focus. */}
      <span
        className={`thread-search-count${status === 'No matches' ? ' is-empty' : ''}`}
        role="status"
        aria-live="polite"
      >
        {status}
      </span>

      <div className="thread-search-nav">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous match"
          title="Previous match"
          disabled={!canStep}
          onClick={() => step(-1)}
        >
          <ChevronUp size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next match"
          title="Next match"
          disabled={!canStep}
          onClick={() => step(1)}
        >
          <ChevronDown size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close search"
          title="Close search"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
    </div>
  )
}
