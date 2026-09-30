import { AlertTriangle, RotateCcw } from 'lucide-react'
import { formatNumber } from '../lib/format.js'
import { REASON_CATEGORIES } from '../lib/attentionReasons.js'

const CATEGORY_LABEL = new Map(REASON_CATEGORIES.map((c) => [c.id, c.label]))

const LEVEL_LABEL = { management: 'Management', team: 'Team', general: 'General' }

const ACTION_LABEL = {
  dismissed: 'Closed',
  restored: 'Re-opened',
  auto_raised: 'Raised by AI',
  reopened: 'Re-opened',
}

/**
 * Absolute, to the minute, and never relative.
 *
 * Everywhere else in the app a "2h ago" stamp is the friendlier read, but this
 * is an audit trail: the question it answers is "when exactly did this happen",
 * often months later and often against someone's account of events. A relative
 * stamp cannot answer that, and drifts every time the page re-renders.
 */
function auditStamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Renders closure-audit events. Shared by the admin log page and the per-chat
 * history panel so both read identically — the same event seen from the log and
 * from inside the chat must not look like two different records.
 *
 * `showConversation` is the only difference between the two: the log lists many
 * chats and has to name each one, while the panel is already scoped to one and
 * would just repeat the header.
 */
export default function AttentionEventList({ events, showConversation = false }) {
  if (!events.length) {
    return (
      <p className="attn-log-empty">
        No attention flags have been closed here yet.
      </p>
    )
  }

  return (
    <ul className="attn-log-list">
      {events.map((event) => {
        const dismissed = event.action === 'dismissed'
        const level = event.attention_level_at_time
        return (
          <li key={event.id} className="attn-log-item">
            <span
              className={`attn-log-icon attn-log-icon--${dismissed ? 'dismissed' : 'restored'}`}
              aria-hidden="true"
            >
              {dismissed ? <AlertTriangle size={14} /> : <RotateCcw size={14} />}
            </span>

            <div className="attn-log-body">
              <div className="attn-log-head">
                <span className="attn-log-action">
                  {ACTION_LABEL[event.action] || event.action}
                </span>
                {level ? (
                  <span className={`pill attn-log-level attn-log-level--${level}`}>
                    {LEVEL_LABEL[level] || level}
                  </span>
                ) : null}
                <time className="attn-log-time" dateTime={event.created_at}>
                  {auditStamp(event.created_at)}
                </time>
              </div>

              {showConversation ? (
                <div className="attn-log-conv">
                  {event.customer_name ||
                    (event.customer_number ? formatNumber(event.customer_number) : `Chat #${event.conversation_id}`)}
                </div>
              ) : null}

              {/* The actor. Falls back to the raw id when the user row is gone:
                  an event whose author has since left the company is precisely
                  the one worth still being able to read. */}
              <div className="attn-log-actor">
                {event.actor_name || (event.actor_user_id ? `User #${event.actor_user_id}` : 'Unknown user')}
                {event.actor_role ? (
                  <span className="attn-log-role"> · {event.actor_role}</span>
                ) : null}
              </div>

              {event.reason_category ? (
                <div className="attn-log-reason">
                  {CATEGORY_LABEL.get(event.reason_category) || event.reason_category}
                </div>
              ) : null}

              {event.reason_note ? (
                <p className="attn-log-note">{event.reason_note}</p>
              ) : null}

              {/* What the AI had flagged, shown under the agent's own account of
                  it — the two together are what let a manager judge whether the
                  closure actually answered the problem. */}
              {event.attention_reason_at_time ? (
                <p className="attn-log-flag">
                  <span className="attn-log-flag-label">Flagged:</span>{' '}
                  {event.attention_reason_at_time}
                </p>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
