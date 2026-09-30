import { useEffect, useState } from 'react'
import { X, Download, Check } from 'lucide-react'

export default function Lightbox({ image, onClose }) {
  // 'idle' | 'saving' | 'done' — the button is the only place a slow or failed
  // save can be reported, since the browser gives no feedback of its own until
  // the file lands.
  const [saveState, setSaveState] = useState('idle')

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Stop the thread scrolling behind the overlay.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  // A new image in the same overlay must not inherit the previous one's tick.
  useEffect(() => {
    setSaveState('idle')
  }, [image?.url])

  if (!image) return null

  /**
   * Save the image to disk.
   *
   * Fetched into a blob rather than pointing an <a download> straight at the
   * signed URL: that URL is cross-origin to us, and a cross-origin `download`
   * attribute is ignored by every browser — the image would open in a tab
   * instead of saving, which is the behaviour this is meant to replace. The
   * blob is same-origin, so the filename is honoured.
   */
  const download = async () => {
    if (!image.url || saveState === 'saving') return
    setSaveState('saving')

    let objectUrl = null
    try {
      const res = await fetch(image.url)
      if (!res.ok) throw new Error(`http_${res.status}`)

      objectUrl = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = image.name || 'image'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setSaveState('done')
    } catch {
      // Fall back to opening the image in a tab, where the browser's own save
      // is still available. Better than a dead button on a flaky connection.
      window.open(image.url, '_blank', 'noopener')
      setSaveState('idle')
    } finally {
      // Revoked on the next frame — revoking synchronously can cancel the
      // download in Safari before it has read the blob.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
    }
  }

  let saveIcon = <Download size={20} aria-hidden="true" />
  if (saveState === 'saving') saveIcon = <span className="spinner" aria-hidden="true" />
  else if (saveState === 'done') saveIcon = <Check size={20} aria-hidden="true" />

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={image.name || 'Image'}
      onMouseDown={(e) => {
        // Click outside the image closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="lightbox-actions">
        <button
          type="button"
          className="lightbox-btn"
          aria-label={saveState === 'done' ? 'Image saved' : 'Download image'}
          title="Download"
          onClick={download}
          disabled={!image.url || saveState === 'saving'}
        >
          {saveIcon}
        </button>

        <button type="button" className="lightbox-btn" aria-label="Close image" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <img className="lightbox-img" src={image.url} alt={image.name || ''} />
    </div>
  )
}
