import { useEffect, useRef, useState } from 'react'
import { Sparkles, AlertTriangle, X, Send, Copy, Check, CornerDownLeft } from 'lucide-react'
import { api } from '../lib/api.js'
import { displayName } from '../lib/format.js'

const ATTENTION = { management: 'Management', team: 'Team', general: 'General' }

// The endpoint now returns immediately and generates in the background, so we
// poll for the finished text instead of holding one long request open.
const POLL_MS = 3000
const MAX_POLLS = 12 // ~36s, then stop and keep whatever we have

/**
 * Fixed-position anchored to the tapped icon. Fixed (not absolute) so it escapes
 * the conversation list's overflow, and clamped to the viewport so it never
 * overflows a 390px screen. Flips above the anchor when the row sits low.
 */
function computePosition(rect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Wider than the old summary-only panel: it now also holds the AI chat,
  // whose drafts and action buttons need the room. Still clamped to the
  // viewport so it never overflows a 390px screen.
  const width = Math.min(360, vw - 16)
  const left = Math.max(8, Math.min(Math.round(rect.right - width), vw - width - 8))
  const style = { position: 'fixed', width, left }

  // Open downward when there is genuinely room, otherwise flip above. This
  // measures the actual gap rather than testing the row against a fixed
  // fraction of the viewport: the panel grew to fit the AI chat, so a row at
  // (say) 55% height would have passed the old test and then overflowed the
  // bottom of the screen. Whichever side wins also caps the panel's height, so
  // the composer stays on screen either way.
  const below = vh - rect.bottom - 14
  const above = rect.top - 14
  if (below >= Math.min(above, 320) || below >= 420) {
    style.top = Math.round(rect.bottom + 6)
    style.maxHeight = Math.round(below)
  } else {
    style.bottom = Math.round(vh - rect.top + 6)
    style.maxHeight = Math.round(above)
  }
  return style
}

/**
 * Compact AI short-summary popover launched from a conversation row. Reuses the
 * SAME summary endpoint (api.summary) — no second summary path — and caches the
 * result per conversation so re-opening is instant and taps stay lazy.
 */
export default function SummaryPopover({ conversation, anchorRect, cache, onDismiss, onSend, onClose }) {
  const cached = cache.get(conversation.id)
  const [pos] = useState(() => computePosition(anchorRect))
  // A cached summary paints on the FIRST render — no request, no spinner. Only
  // a genuine miss starts in 'loading'; the batch preload no longer caches
  // misses, so those fall through to the fetch below instead of sticking on a
  // permanent "No summary yet".
  const [status, setStatus] = useState(cached?.summary ? 'ready' : 'loading')
  const [summary, setSummary] = useState(cached?.summary ?? null)
  const [stale, setStale] = useState(Boolean(cached?.stale))
  // A background regenerate is running while we already have text on screen.
  // Purely a footnote — it never suppresses the summary.
  const [refreshing, setRefreshing] = useState(false)

  // --- Chat with AI ------------------------------------------------------
  // The panel's conversation with the assistant. Session-only and deliberately
  // NOT cached across opens: it is a scratchpad for the agent, not part of the
  // stored summary, and nothing here is ever written server-side.
  //
  // Each turn is { role, content, draft? }. `draft` is a ready-to-send message
  // the agent can copy or push straight into the thread.
  const [turns, setTurns] = useState([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState(null)
  // Which draft was just copied / just sent, for the transient confirmations.
  const [copiedAt, setCopiedAt] = useState(null)
  const [sentAt, setSentAt] = useState(null)
  const [sendingAt, setSendingAt] = useState(null)
  const askAbort = useRef(null)
  const turnsEndRef = useRef(null)
  // The panel element. Nothing dismisses on outside interaction any more, so
  // this is just a handle on the panel itself.
  const panelRef = useRef(null)

  // Abort any in-flight ask when the popover closes, so a late reply cannot
  // set state on an unmounted component.
  useEffect(() => () => askAbort.current?.abort(), [])

  // --- Keyboard-aware panel geometry -------------------------------------
  // On a phone the panel is a full-height sheet whose composer must sit on the
  // keyboard. `position: fixed` and `100dvh` are both measured against the
  // LAYOUT viewport, and iOS Safari does not shrink that when the soft keyboard
  // opens - it scrolls the page up behind it instead. So the panel floor ends
  // up under the keyboard, and any scroll of the page behind drags the whole
  // panel (composer included) along with it. That is exactly the reported bug.
  //
  // window.visualViewport reports the actually-visible rectangle: `height`
  // shrinks by the keyboard and `offsetTop` tracks how far the page was scrolled
  // up to make room. Publishing both as CSS variables on the panel lets the
  // stylesheet pin the sheet to the VISUAL viewport, so the composer is glued
  // to the top of the keyboard and stays there no matter what scrolls behind.
  //
  // Desktop and engines without visualViewport never get the variables and fall
  // through to the dvh/svh/vh rules already in the stylesheet.
  useEffect(() => {
    const vv = window.visualViewport
    const panel = panelRef.current
    if (!vv || !panel) return

    let frame = null
    const apply = () => {
      frame = null
      const el = panelRef.current
      if (!el) return
      el.style.setProperty('--vv-height', `${Math.round(vv.height)}px`)
      el.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`)
      // The keyboard's height, i.e. how much of the layout viewport it covers.
      // Zero while it is closed, so the panel keeps its normal full-height
      // geometry and only reacts once a field is actually focused.
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      el.style.setProperty('--vv-keyboard', `${Math.round(keyboard)}px`)
      el.dataset.keyboard = keyboard > 80 ? 'open' : 'closed'
    }

    // visualViewport fires resize/scroll in bursts as the keyboard animates in;
    // coalescing into one rAF keeps that to a single style write per frame.
    const schedule = () => {
      if (frame == null) frame = requestAnimationFrame(apply)
    }

    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
    }
  }, [])

  // The panel is modal and covers the phone screen, so the list behind it has
  // no business scrolling while it is open. Locking it also removes the other
  // half of the reported bug: with the document unable to scroll, the browser
  // cannot pan the page out from under a fixed panel when the keyboard opens.
  useEffect(() => {
    const { body } = document
    const previousOverflow = body.style.overflow
    const previousOverscroll = body.style.overscrollBehavior
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    return () => {
      body.style.overflow = previousOverflow
      body.style.overscrollBehavior = previousOverscroll
    }
  }, [])

  // Keep the newest turn in view as the thread grows.
  useEffect(() => {
    if (turns.length || asking) turnsEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns, asking])

  const handleAsk = async (e) => {
    e?.preventDefault?.()
    const text = question.trim()
    if (!text || asking) return

    // Only the plain role/content pairs go back as history — `draft` is a
    // client-side convenience and the model already has it in `content`.
    const history = turns.map((t) => ({ role: t.role, content: t.content }))

    setTurns((prev) => [...prev, { role: 'user', content: text }])
    setQuestion('')
    setAskError(null)
    setAsking(true)

    askAbort.current?.abort()
    const controller = new AbortController()
    askAbort.current = controller

    try {
      const res = await api.askAi(conversation.id, text, { history, signal: controller.signal })
      if (controller.signal.aborted) return
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: res.answer || '', draft: res.draft || null },
      ])
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return
      setAskError(err?.message || 'Couldn’t get an answer. Try again.')
    } finally {
      if (!controller.signal.aborted) setAsking(false)
    }
  }

  // Copy a draft to the clipboard. Falls back to a hidden textarea where the
  // async clipboard API is unavailable (older iOS Safari, non-secure origins).
  const handleCopy = async (text, index) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopiedAt(index)
      setTimeout(() => setCopiedAt((c) => (c === index ? null : c)), 1600)
    } catch {
      setAskError('Couldn’t copy to the clipboard.')
    }
  }

  // Send a draft straight into the thread. The parent owns the actual send so
  // the message lands through exactly the same path as a typed one.
  const handleSendDraft = async (text, index) => {
    if (sendingAt != null || !onSend) return
    setSendingAt(index)
    setAskError(null)
    try {
      await onSend(conversation.id, text)
      setSentAt(index)
    } catch (err) {
      setAskError(err?.message || 'Couldn’t send the message.')
    } finally {
      setSendingAt(null)
    }
  }

  // Ask the parent to open the reason sheet. NOT optimistic any more: clearing
  // a flag now requires a reason and can still be refused server-side (wrong
  // role for a management flag, or a "no response" closure inside the 24h
  // window), so dropping the banner here would take it away on every rejection
  // and put it back a moment later.
  //
  // The banner goes when the flag actually goes — this popover stays open over
  // the sheet, and the list refresh that follows a successful closure carries
  // the new state back. The cache line the optimistic version kept in step is
  // gone with it: there is no longer a local guess to keep in step.
  const handleDismiss = () => {
    if (!summary) return
    onDismiss?.(conversation.id, summary.attention_level)
  }

  // The panel is modal and locked open: the close button is the ONLY way out.
  //
  // Nothing dismisses it implicitly any more - not a tap outside, not a scroll,
  // not a resize, not Escape. On a phone the whole thing is a tall panel whose
  // chat input raises the keyboard, and a raised keyboard fires resize while
  // the focus tap itself landed outside the old anchor: both used to close the
  // popover the instant someone tried to type. Rather than special-case those,
  // dismissal is deliberate everywhere, desktop included.

  // Lazy fetch — only when opened, and only if not already cached. A cache HIT
  // is rendered synchronously by the useState initialisers above, so a
  // preloaded row paints instantly and never reaches this effect.
  //
  // A response flagged `generating` means the model is running server-side, so
  // we show any stale text right away and re-poll until the fresh summary
  // lands. A cache MISS is deliberately not stored by the batch preload, so it
  // falls through to here and triggers that generation.
  useEffect(() => {
    if (cache.get(conversation.id)?.summary) return
    const controller = new AbortController()
    let timer = null
    let attempts = 0
    let stopped = false

    const finish = (entry) => {
      cache.set(conversation.id, entry)
      setSummary(entry.summary)
      setStale(Boolean(entry.stale))
      setStatus(entry.summary ? 'ready' : 'empty')
    }

    const poll = () => {
      attempts += 1
      api
        .summary(conversation.id, controller.signal)
        .then((res) => {
          if (stopped || controller.signal.aborted) return

          // STORED TEXT ALWAYS WINS. The endpoint returns the saved row on
          // every response — including when it has ALSO kicked off a background
          // refresh (`generating`), which for a live conversation is almost
          // every click: decideRefresh() asks for a regenerate as soon as there
          // are new messages and the row is >2h old. Checking `generating`
          // first would hide a perfectly good summary behind a spinner for the
          // whole poll window, which is exactly the "API is fast but the UI is
          // slow" symptom. So: render what we were given, immediately.
          if (res?.summary) {
            finish({ summary: res.summary, stale: Boolean(res.refresh_failed) })
            // A background refresh is running, so the text on screen may be
            // superseded. Quietly poll for the newer wording — the summary
            // stays visible and readable throughout; nothing regresses to a
            // loading state.
            const more = Boolean(res.generating) && attempts < MAX_POLLS
            setRefreshing(more)
            if (more) timer = setTimeout(poll, POLL_MS)
            return
          }

          // No stored text. The server does NOT block on the model, so there is
          // nothing to wait for here: it reports empty and the background
          // generation (kicked off by the webhook on new messages, and nudged
          // by this request) will fill it in for a later open.
          //
          // Showing "No summary yet" immediately is the whole point of this
          // path — a spinner would just be a countdown to the same answer.
          finish({ summary: null })
        })
        .catch((err) => {
          if (stopped || controller.signal.aborted || err?.name === 'AbortError') return
          setStatus('error')
        })
    }

    poll()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }, [conversation.id, cache])

  const level = summary?.attention_required ? summary.attention_level || 'general' : null

  return (
    <>
      {/* A shield, not a dismisser. The panel is modal: it stays open until the
          close button is pressed, so a tap anywhere else - including the chat
          input, which sits over the list on a phone - must not close it. The
          backdrop still swallows the click so it never reaches the row behind. */}
      <div className="summary-pop-backdrop" />
      <div className="summary-pop" style={pos} role="dialog" aria-label="AI summary" ref={panelRef}>
        <div className="summary-pop-head">
          <span className="summary-pop-title">
            <Sparkles size={13} />
            AI summary
            {/* Whose chat this is. The panel can be opened from any row and then
                sits over the list, so without the name there is nothing on screen
                tying the summary back to a person. Same helper as the list rows,
                so an unnamed contact falls back to their formatted number. */}
            <span className="summary-pop-who">{displayName(conversation)}</span>
          </span>
          <button type="button" className="summary-pop-close" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {(status === 'loading' || status === 'generating') && !summary ? (
          <div className="summary-pop-note">
            <span className="spinner" />
            Summarizing…
          </div>
        ) : status === 'error' ? (
          <div className="summary-pop-note">Couldn’t load the summary.</div>
        ) : status === 'empty' || !summary ? (
          <div className="summary-pop-note">No summary yet.</div>
        ) : (
          <div className="summary-pop-body">
            {level ? (
              <div className={`summary-pop-attn summary-pop-attn--${level}`}>
                <AlertTriangle size={12} className="summary-pop-attn-icon" />
                <span>
                  <strong>{ATTENTION[level]}</strong>
                  {summary.attention_reason ? ` — ${summary.attention_reason}` : ''}
                </span>
                <button
                  type="button"
                  className="summary-pop-attn-dismiss"
                  aria-label="Dismiss attention flag"
                  title="Dismiss — mark as handled"
                  onClick={handleDismiss}
                >
                  <X size={13} />
                </button>
              </div>
            ) : null}
            <p className="summary-pop-text">{summary.text}</p>
            {refreshing ? (
              <div className="summary-pop-stale">
                <span className="spinner" />
                {/* Updating… */}
              </div>
            ) : stale ? (
              <div className="summary-pop-stale">Couldn’t refresh — showing the last summary.</div>
            ) : null}
          </div>
        )}

        {/* --- Chat with AI -------------------------------------------------
            Always available, even when there is no summary yet: the answer is
            drawn from the conversation itself, not from the summary, so an
            un-summarised chat can still be asked about. */}
        <div className="summary-ask">
          <div className="summary-ask-head">Chat with AI</div>

          {turns.length ? (
            <div className="summary-ask-turns">
              {turns.map((turn, i) =>
                turn.role === 'user' ? (
                  <div key={i} className="summary-ask-turn summary-ask-turn--user">
                    {turn.content}
                  </div>
                ) : (
                  <div key={i} className="summary-ask-turn summary-ask-turn--ai">
                    {turn.content ? <p className="summary-ask-answer">{turn.content}</p> : null}
                    {turn.draft ? (
                      <div className="summary-ask-draft">
                        <p className="summary-ask-draft-text">{turn.draft}</p>
                        <div className="summary-ask-draft-actions">
                          <button
                            type="button"
                            className="summary-ask-action"
                            onClick={() => handleCopy(turn.draft, i)}
                            title="Copy this message"
                          >
                            {copiedAt === i ? <Check size={12} /> : <Copy size={12} />}
                            {copiedAt === i ? 'Copied' : 'Copy'}
                          </button>
                          {onSend ? (
                            <button
                              type="button"
                              className="summary-ask-action summary-ask-action--send"
                              onClick={() => handleSendDraft(turn.draft, i)}
                              disabled={sendingAt != null || sentAt === i}
                              title="Send this message to the chat"
                            >
                              {sentAt === i ? (
                                <Check size={12} />
                              ) : sendingAt === i ? (
                                <span className="spinner" />
                              ) : (
                                <CornerDownLeft size={12} />
                              )}
                              {sentAt === i ? 'Sent' : sendingAt === i ? 'Sending…' : 'Send'}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              )}
              {asking ? (
                <div className="summary-ask-turn summary-ask-turn--ai summary-ask-pending">
                  <span className="spinner" />
                  Thinking…
                </div>
              ) : null}
              <div ref={turnsEndRef} />
            </div>
          ) : (
            <p className="summary-ask-hint">
              Ask anything about this chat, or ask for a message to send.
            </p>
          )}

          {askError ? <div className="summary-ask-error">{askError}</div> : null}

          <form className="summary-ask-form" onSubmit={handleAsk}>
            <input
              type="text"
              className="summary-ask-input"
              placeholder="Ask about this chat…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={asking}
              aria-label="Ask the AI about this conversation"
            />
            <button
              type="submit"
              className="summary-ask-send"
              disabled={asking || !question.trim()}
              aria-label="Ask"
            >
              <Send size={14} />
            </button>
          </form>
        </div>
      </div>
    </>
  )
}
