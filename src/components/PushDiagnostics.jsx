import { useCallback, useEffect, useState } from 'react'
import { Copy, Check, RefreshCw, Bell } from 'lucide-react'
import Modal from './Modal.jsx'
import { collectPushDiagnostics, requestPushPermission } from '../lib/push.js'

/**
 * TEMPORARY on-device diagnostics for the iOS push subscription failure.
 * Delete this file, its menu entry in AccountMenuExtras, and the tracing in
 * lib/push.js once the cause is known.
 */
export default function PushDiagnostics({ onClose }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(true)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setData(await collectPushDiagnostics())
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Runs the real flow so the panel can show exactly where it fails. This is
  // the same call the menu toggle makes — nothing is bypassed.
  const attempt = async () => {
    setBusy(true)
    try {
      const result = await requestPushPermission()
      // eslint-disable-next-line no-console
      console.log('[push] manual attempt result', result)
      await refresh()
      setData((current) =>
        current
          ? { ...current, attempt: `${result.ok ? 'ok' : result.reason}${result.error ? ` — ${result.error}` : ''}` }
          : current
      )
    } finally {
      setBusy(false)
    }
  }

  const asText = () => {
    if (!data) return ''
    const lines = Object.entries(data.fields).map(([k, v]) => `${k}: ${v}`)
    if (data.attempt) lines.push(`attempt: ${data.attempt}`)
    lines.push('', '--- trace ---')
    for (const t of data.trace) {
      lines.push(`${t.at} ${t.name}${t.detail !== undefined ? ` ${JSON.stringify(t.detail)}` : ''}`)
    }
    return lines.join('\n')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText())
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* selection fallback: the text is on screen and selectable */
    }
  }

  return (
    <Modal
      title="Push diagnostics"
      subtitle="Temporary. Share this with the developer, then it will be removed."
      onClose={onClose}
    >
      <div className="modal-form">
        <div className="diag-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={refresh} disabled={busy}>
            {busy ? <span className="spinner" /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={attempt} disabled={busy}>
            <Bell size={14} />
            Try subscribe
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            Copy
          </button>
        </div>

        {!data ? (
          <div className="diag-block">Collecting…</div>
        ) : (
          <>
            <div className="diag-block">
              {Object.entries(data.fields).map(([key, value]) => (
                <div className="diag-row" key={key}>
                  <span className="diag-key">{key}</span>
                  <span className="diag-value">{String(value)}</span>
                </div>
              ))}
              {data.attempt ? (
                <div className="diag-row">
                  <span className="diag-key">attempt</span>
                  <span className="diag-value">{data.attempt}</span>
                </div>
              ) : null}
            </div>

            {data.trace.length ? (
              <div className="diag-block">
                <div className="diag-title">Trace</div>
                {data.trace.map((t, i) => (
                  <div className="diag-trace" key={i}>
                    <span className="diag-key">{t.at}</span> {t.name}
                    {t.detail !== undefined ? ` ${JSON.stringify(t.detail)}` : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
