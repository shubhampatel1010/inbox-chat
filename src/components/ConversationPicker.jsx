import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Check } from 'lucide-react'
import ContactAvatar from './ContactAvatar.jsx'
import { displayName, matchesQuery } from '../lib/format.js'

/**
 * Pick one or more conversations to forward into.
 *
 * Full-screen on mobile, centred sheet on desktop — both from the same markup,
 * switched in the stylesheet. Search reuses matchesQuery, the same predicate
 * the inbox list filters with, so "which chats match" means the same thing in
 * both places.
 */
export default function ConversationPicker({
  conversations,
  excludeId = null,
  count,
  sending = false,
  onSend,
  onClose,
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const searchRef = useRef(null)

  // Desktop gets focus on open; on touch this would raise the keyboard over
  // the list before the user has seen it, so it is left alone there.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) searchRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The source thread is not a forwarding target — forwarding a message into
  // the conversation it already lives in is never the intent.
  const candidates = useMemo(
    () => conversations.filter((c) => c.id !== excludeId),
    [conversations, excludeId]
  )

  const visible = useMemo(
    () => (query.trim() ? candidates.filter((c) => matchesQuery(c, query)) : candidates),
    [candidates, query]
  )

  const toggle = (id) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = [...selected]

  return (
    <div
      className="overlay picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Forward to"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="picker">
        <div className="picker-head">
          <h2 className="modal-title">
            Forward {count} {count === 1 ? 'message' : 'messages'}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="picker-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search chats"
            aria-label="Search chats"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="picker-list">
          {visible.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No chats found</div>
            </div>
          ) : (
            visible.map((conversation) => {
              const isSelected = selected.has(conversation.id)
              return (
                <button
                  type="button"
                  key={conversation.id}
                  className={`picker-row${isSelected ? ' is-selected' : ''}`}
                  // Communicates multi-select state to assistive tech — this is
                  // a toggle, not navigation.
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => toggle(conversation.id)}
                >
                  <span className={`pick-box${isSelected ? ' is-on' : ''}`} aria-hidden="true">
                    {isSelected ? <Check size={14} strokeWidth={3} /> : null}
                  </span>
                  <ContactAvatar conversation={conversation} size={38} />
                  <span className="picker-row-text">
                    <span className="picker-row-name">{displayName(conversation)}</span>
                    {conversation.last_message_body ? (
                      <span className="picker-row-snippet">{conversation.last_message_body}</span>
                    ) : null}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="picker-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={chosen.length === 0 || sending}
            onClick={() => onSend(chosen)}
          >
            {sending
              ? 'Sending…'
              : `Send to ${chosen.length} ${chosen.length === 1 ? 'chat' : 'chats'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
