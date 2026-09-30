import { useState } from 'react'
import { initials, avatarIndex, displayName } from '../lib/format.js'
import { useSignedUrl } from '../lib/mediaUrl.js'

/**
 * Contact avatar: stored profile picture when we have one, coloured initials
 * otherwise.
 *
 * Initials render underneath at all times and the image sits on top once it
 * has loaded — so the circle is never blank while the signed URL resolves, and
 * a broken or expired image simply reveals the initials again.
 */
export default function ContactAvatar({ conversation, size = 42, className = '' }) {
  const [failed, setFailed] = useState(false)
  const path = conversation?.avatar_path || null
  const { url } = useSignedUrl(failed ? null : path)

  const name = displayName(conversation)
  const showImage = Boolean(url) && !failed

  return (
    <span
      className={`conv-avatar ${className}`.trim()}
      data-color={avatarIndex(conversation?.customer_number)}
      style={size !== 42 ? { width: size, height: size, fontSize: Math.round(size * 0.31) } : undefined}
      aria-hidden="true"
    >
      {initials(name)}
      {showImage ? (
        <img
          className="conv-avatar-img"
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  )
}
