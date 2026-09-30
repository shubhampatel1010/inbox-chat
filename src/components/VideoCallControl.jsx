import { useState } from 'react'
import { Video, Loader2 } from 'lucide-react'
import { api } from '../lib/api.js'

/**
 * Video call for the thread header.
 *
 * One click mints an instant Cal.com meeting on the server, then hands the
 * invite text to `onSend` — the same send path as a typed reply — so the
 * customer gets the link on WhatsApp and it shows in the thread like any other
 * outbound message. The agent joins from the link in that message.
 */
export default function VideoCallControl({ conversation, onSend, onError }) {
  const [busy, setBusy] = useState(false)

  const start = async () => {
    if (busy) return
    setBusy(true)
    try {
      let url
      try {
        ;({ url } = await api.createVideoCall(conversation.id))
      } catch (err) {
        onError?.(err)
        return
      }
      // onSend reports its own failures; swallow the rethrow here.
      await onSend(`Join me on a video call: ${url}`).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="icon-btn call-btn"
      aria-label="Send video call link"
      title="Send video call link"
      disabled={busy}
      aria-busy={busy}
      onClick={start}
    >
      {busy ? <Loader2 size={18} className="is-spinning" /> : <Video size={18} />}
    </button>
  )
}
