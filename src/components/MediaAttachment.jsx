import { useState } from 'react'
import { FileText, Download, ImageOff, Film, Music, FileSpreadsheet, Forward } from 'lucide-react'
import { formatBytes } from '../lib/format.js'
import { useSignedUrl } from '../lib/mediaUrl.js'

function DocIcon({ mime, size = 18 }) {
  if (/spreadsheet|excel|csv/i.test(mime || '')) return <FileSpreadsheet size={size} />
  return <FileText size={size} />
}

/**
 * Forward this attachment straight into the picker, skipping the long-press →
 * select → forward path. Rendered only when a handler is supplied, so the
 * component still works anywhere forwarding is not wired up.
 *
 * Both hosts are themselves clickable (the image opens a lightbox, the chip
 * downloads), so the click must not reach them.
 */
function ForwardButton({ onForward, className }) {
  if (!onForward) return null
  return (
    <button
      type="button"
      className={className}
      aria-label="Forward this file"
      title="Forward"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onForward()
      }}
    >
      <Forward size={16} />
    </button>
  )
}

export default function MediaAttachment({ message, onOpenImage, stamp = null, onForward = null }) {
  const { url, error } = useSignedUrl(message.media_path)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const isImage = message.media_type === 'image'
  const name = message.media_filename || 'Attachment'

  // media_error is the authoritative flag: ingestion failed upstream, so the
  // row records what the attachment was but the bytes never reached our
  // bucket. The missing-path check is only a guard against a malformed row —
  // without it an image would spin on its skeleton forever.
  if (message.media_error || !message.media_path) {
    return (
      <div className="media-error">
        <ImageOff size={15} />
        <span>Media unavailable</span>
        {stamp}
      </div>
    )
  }

  if (error) {
    return (
      <div className="media-error">
        <ImageOff size={15} />
        <span>Attachment unavailable</span>
        {stamp}
      </div>
    )
  }

  if (isImage && !imgFailed) {
    // A wrapper, not a bare button: the forward control is itself a button and
    // cannot be nested inside one.
    return (
      <span className="media-image-wrap">
        <button
          type="button"
          className="media-image"
          onClick={() => url && onOpenImage({ url, name })}
          aria-label={`Open image ${name}`}
        >
          {/* Skeleton holds the space until the bytes arrive. */}
          {!imgLoaded ? <span className="media-skeleton" aria-hidden="true" /> : null}
          {url ? (
            <img
              src={url}
              alt={message.media_caption || name}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgFailed(true)}
              style={imgLoaded ? undefined : { visibility: 'hidden', position: 'absolute' }}
            />
          ) : null}
          {/* Timestamp rides on the image over a scrim, so an uncaptioned photo
              costs no extra text line. */}
          {stamp && imgLoaded ? <span className="media-stamp">{stamp}</span> : null}
        </button>
        {/* Only once the image is up — floating over a skeleton looks broken. */}
        {imgLoaded ? <ForwardButton onForward={onForward} className="media-fwd-float" /> : null}
      </span>
    )
  }

  // Documents — and video/audio, which render as chips by design.
  const TypeIcon =
    message.media_type === 'video' ? Film : message.media_type === 'audio' ? Music : null

  // Wrapped so the forward control can sit beside the download affordance
  // without nesting a button inside the anchor.
  return (
    <span className="media-doc-wrap">
      <a
        className="media-doc"
        href={url || undefined}
        download={name}
        target="_blank"
        rel="noreferrer"
        aria-disabled={!url}
      >
        <span className="media-doc-icon">
          {TypeIcon ? <TypeIcon size={18} /> : <DocIcon mime={message.media_mime} />}
        </span>
        <span className="media-doc-body">
          <span className="media-doc-name">{name}</span>
          <span className="media-doc-meta">
            <span>{formatBytes(message.media_size) || message.media_type}</span>
            {stamp}
          </span>
        </span>
        <span className="media-doc-dl">
          <Download size={16} />
        </span>
      </a>
      <ForwardButton onForward={onForward} className="media-fwd-chip" />
    </span>
  )
}
