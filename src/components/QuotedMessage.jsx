import { Image, FileText, Video, Music } from 'lucide-react'
import { avatarIndex, quoteLabel, senderLabelFor } from '../lib/format.js'

/** Icon shown beside the label when the quoted message is media. */
const MEDIA_ICON = {
  image: Image,
  video: Video,
  audio: Music,
  document: FileText,
}

/**
 * The compact block above a bubble showing the message being replied to.
 *
 * Clicking it jumps to the original — the whole point of a quote is that the
 * thing it refers to is elsewhere in the thread. When the original is not in
 * our database (quoted before the backfill, or since deleted) the block still
 * renders, greyed and inert: the message IS a reply, and hiding that would
 * misrepresent the conversation.
 */
export default function QuotedMessage({ quoted, conversation, onJump }) {
  if (!quoted) return null

  if (quoted.found === false) {
    return (
      <div className="quote is-missing">
        <span className="quote-body">Original message</span>
      </div>
    )
  }

  const label = quoteLabel(quoted)
  // Media with no caption gets an icon; a text quote does not.
  const Icon = quoted.body ? null : MEDIA_ICON[quoted.media_type]
  const jump = onJump ? () => onJump(quoted.id) : null

  // The server resolves this already; re-running the same rule here covers a
  // quote that has not been through the read path yet, and keeps the label
  // correct if the conversation was renamed since the message was fetched.
  const who = quoted.sender_name || senderLabelFor(quoted, conversation)

  return (
    <button
      type="button"
      className="quote"
      // Outbound quotes are the agent's own words, so they take the accent the
      // rest of the UI uses for "us"; inbound takes the sender's group colour.
      data-agent={quoted.direction === 'outbound' ? undefined : avatarIndex(quoted.sender_number)}
      data-out={quoted.direction === 'outbound' ? '' : undefined}
      onClick={jump}
      disabled={!jump}
      aria-label={`Replying to ${who || 'a message'}. Jump to it.`}
    >
      <span className="quote-sender">{who || 'Unknown'}</span>
      <span className="quote-body">
        {Icon ? <Icon size={12} aria-hidden="true" /> : null}
        {label || 'Message'}
      </span>
    </button>
  )
}
