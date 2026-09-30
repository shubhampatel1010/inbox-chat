import { useEffect, useState } from 'react'
import Modal from './Modal.jsx'
import { api } from '../lib/api.js'
import AttentionEventList from './AttentionEventList.jsx'

/**
 * One conversation's attention-closure history, opened from the thread header.
 *
 * ADMIN ONLY, and the caller is responsible for not rendering it otherwise —
 * though the endpoint answers 403 regardless, so a mis-render leaks nothing.
 *
 * Deliberately a separate surface from the full audit log rather than a link to
 * it with a filter pre-applied: the question being asked here is "what happened
 * to THIS chat", usually while reading the chat itself, and bouncing an admin
 * out to another page loses the thread they were looking at.
 */
export default function AttentionHistoryModal({ conversation, onClose }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    api
      .attentionEvents({ conversation_id: conversation.id }, { signal: controller.signal })
      .then((data) => {
        if (cancelled) return
        setEvents(data.events || [])
        setLoading(false)
      })
      .catch((err) => {
        // An abort is this component unmounting, not a failure to report.
        if (cancelled || err.name === 'AbortError') return
        setError(err.message)
        setLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [conversation.id])

  return (
    <Modal
      title="Attention history"
      subtitle="Every time this chat had an attention flag closed or re-opened."
      onClose={onClose}
    >
      <div className="attn-history-body">
        {loading ? (
          <div className="card-body">
            <span className="spinner" style={{ color: 'var(--text-3)' }} />
          </div>
        ) : error ? (
          <div className="alert alert-error">{error}</div>
        ) : (
          <AttentionEventList events={events} />
        )}
      </div>
    </Modal>
  )
}
