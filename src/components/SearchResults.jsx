import { SearchX, AlertCircle, Sparkles } from 'lucide-react'
import { displayName, formatNumber, relativeStamp, avatarIndex } from '../lib/format.js'
import ContactAvatar from './ContactAvatar.jsx'
import { MIN_QUERY_LENGTH } from '../lib/useMessageSearch.js'

/**
 * Split a snippet into before / match / after.
 *
 * The server sends match_start as an index into the snippet it already
 * trimmed, so no re-searching happens here — which matters because the two
 * would disagree the moment a query appears twice in one message.
 *
 * match_start of -1 means the server could not attribute the hit to a single
 * field; the snippet is still shown, just unhighlighted.
 */
function Highlighted({ text, start, length }) {
  if (start == null || start < 0 || !length) return <>{text}</>
  return (
    <>
      {text.slice(0, start)}
      <mark className="search-mark">{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </>
  )
}

/** A search result carries its own conversation fields, so it shapes one for the avatar. */
const avatarSubject = (result) => ({
  customer_name: result.conversation_name,
  customer_number: result.conversation_number,
  is_group: result.is_group,
  avatar_path: result.avatar_path,
  avatar_error: result.avatar_error,
})

export default function SearchResults({
  query,
  nameMatches,
  search,
  openId,
  onOpen,
  // Opens the AI summary popover, same handler the unsearched list uses.
  // Omitted simply leaves the button off, keeping this component standalone.
  onSummary = null,
  // Maps a message hit's conversation_id back to the loaded conversation the
  // popover needs. Omitted leaves message rows without a Summary button.
  resolveConversation = null,
}) {
  const tooShort = query.trim().length < MIN_QUERY_LENGTH
  const loading = search.status === 'loading'
  const failed = search.status === 'error'

  // The two lists are counted together: a query that matches a contact by name
  // but no message body has still found something, and must not show "no
  // results".
  const total = nameMatches.length + search.results.length
  const settled = !loading && !failed

  if (settled && total === 0) {
    return (
      <div className="conv-list" role="region" aria-label="Search results">
        <div className="empty">
          <SearchX size={26} />
          <div className="empty-title">No matches for “{query.trim()}”</div>
          <div className="empty-sub">
            {tooShort
              ? `Type at least ${MIN_QUERY_LENGTH} characters to search message text.`
              : 'Searched contact names, numbers and every message.'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="conv-list" role="region" aria-label="Search results">
      {nameMatches.length ? (
        <>
          <div className="search-group">Conversations</div>
          {nameMatches.map((conversation) => {
            const isActive = String(conversation.id) === String(openId)
            return (
              <div
                key={`c-${conversation.id}`}
                role="button"
                tabIndex={0}
                aria-current={isActive ? 'true' : undefined}
                className={`conv-row search-row${isActive ? ' is-active' : ''}`}
                onClick={() => onOpen(conversation.id, null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(conversation.id, null)
                  }
                }}
              >
                <ContactAvatar conversation={conversation} />
                <div className="conv-body">
                  <div className="conv-top">
                    <span className="conv-name">{displayName(conversation)}</span>
                    <span className="conv-time">
                      {relativeStamp(conversation.last_message_at)}
                    </span>
                  </div>
                  {/* Number on the left, the same ✦ Summary button the
                      unsearched list carries on its right. A role=button div
                      above (not a <button>) so this one can nest inside. */}
                  <div className="search-sub-row">
                    <span className="search-sub">
                      {conversation.is_group
                        ? 'Group'
                        : formatNumber(conversation.customer_number)}
                    </span>
                    {onSummary ? (
                      <button
                        type="button"
                        className="conv-summary-btn"
                        aria-label={`AI summary for ${displayName(conversation)}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSummary(conversation, e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <Sparkles size={12} className="conv-summary-spark" />
                        <span className="conv-summary-label">Summary</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </>
      ) : null}

      {search.results.length ? (
        <>
          <div className="search-group">Messages</div>
          {search.results.map((result) => (
            <div
              key={`m-${result.message_id}`}
              role="button"
              tabIndex={0}
              className="conv-row search-row"
              onClick={() => onOpen(result.conversation_id, result.message_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(result.conversation_id, result.message_id)
                }
              }}
            >
              <ContactAvatar conversation={avatarSubject(result)} />
              <div className="conv-body">
                <div className="conv-top">
                  <span className="conv-name">{displayName(avatarSubject(result))}</span>
                  <span className="conv-time">{relativeStamp(result.created_at)}</span>
                </div>

                <div className="search-snippet">
                  {/* Groups name the individual sender; a 1:1 inbound sender IS
                      the contact already on the line above, so only outbound
                      needs distinguishing. */}
                  {result.is_group && result.sender_name ? (
                    <span
                      className="search-sender"
                      data-agent={avatarIndex(result.sender_number)}
                    >
                      {result.sender_name}:{' '}
                    </span>
                  ) : result.direction === 'outbound' ? (
                    <span className="search-sender is-you">You: </span>
                  ) : null}
                  <Highlighted
                    text={result.snippet}
                    start={result.match_start}
                    length={result.match_length}
                  />
                </div>

                {/* Summary for the conversation this message belongs to. Only
                    offered when the row resolves to a conversation already
                    loaded in the list — the result itself carries no full
                    conversation object for the popover to work from. */}
                {onSummary && resolveConversation ? (() => {
                  const conversation = resolveConversation(result.conversation_id)
                  if (!conversation) return null
                  return (
                    <div className="search-sub-row is-trailing">
                      <button
                        type="button"
                        className="conv-summary-btn"
                        aria-label={`AI summary for ${displayName(avatarSubject(result))}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSummary(conversation, e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <Sparkles size={12} className="conv-summary-spark" />
                        <span className="conv-summary-label">Summary</span>
                      </button>
                    </div>
                  )
                })() : null}
              </div>
            </div>
          ))}
        </>
      ) : null}

      {loading ? (
        <div className="search-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Searching messages…
        </div>
      ) : null}

      {failed ? (
        <div className="search-status is-error" role="status">
          <AlertCircle size={14} aria-hidden="true" />
          Message search failed. Contact matches are still shown.
        </div>
      ) : null}

      {settled && search.hasMore ? (
        <div className="search-status">
          Showing the {search.results.length} most recent matches. Narrow the search
          to see older ones.
        </div>
      ) : null}
    </div>
  )
}
