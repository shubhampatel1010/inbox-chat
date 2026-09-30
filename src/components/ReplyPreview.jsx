import { X, Image, FileText, Video, Music } from 'lucide-react'
import { avatarIndex, quoteLabel, senderLabelFor } from '../lib/format.js'

const MEDIA_ICON = {
  image: Image,
  video: Video,
  audio: Music,
  document: FileText,
}

/** Longest preview shown in the composer bar. One line, per the design. */
const MAX_CHARS = 100

/**
 * The bar above the composer while a reply is being written.
 *
 * Built from the message the user picked in the thread, so it shows the same
 * sender name and colour the bubble does — the confirmation that the right
 * message was picked has to be legible at a glance.
 */
export default function ReplyPreview({ target, conversation, onCancel }) {
  if (!target) return null

  const isOut = target.direction === 'outbound'
  const who = senderLabelFor(target, conversation)

  // Reuses the quote-label rule so the composer and the sent bubble never
  // disagree about what the quoted message says.
  const raw =
    quoteLabel({
      found: true,
      body: target.body || target.media_caption || '',
      media_type: target.media_type,
    }) || 'Message'

  const label = raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}…` : raw
  const Icon = target.body || target.media_caption ? null : MEDIA_ICON[target.media_type]

  return (
    <div className="reply-quote">
      <div
        className="reply-quote-bar"
        data-agent={isOut ? undefined : avatarIndex(target.sender_number)}
        data-out={isOut ? '' : undefined}
      >
        <span className="reply-quote-sender">{who || 'Unknown'}</span>
        <span className="reply-quote-body">
          {Icon ? <Icon size={12} aria-hidden="true" /> : null}
          {label}
        </span>
      </div>

      <button
        type="button"
        className="reply-quote-close"
        aria-label="Cancel reply"
        onClick={onCancel}
      >
        <X size={15} />
      </button>
    </div>
  )
}
