import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, Send, Copy, Check, FileText, Users, User, RotateCcw } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAccounts } from '../context/AccountContext.jsx'

/**
 * The inbox-wide AI assistant.
 *
 * Sibling to SummaryPopover, but one level up: that panel is anchored to a row
 * and reads ONE conversation, this one is opened from the header and reads
 * EVERY conversation the user can reach — group chats and personal chats alike.
 * It answers questions across the whole portal and writes daily reports.
 *
 * Nothing is stored server-side, so a question can never disturb a
 * conversation's summary. The turns ARE kept for the browser tab (see
 * loadThread): an answer lists chats to open, and opening one closes the panel
 * — the list has to still be there when the user comes back for the next one.
 */

// Per tab, per account scope: "All accounts" and one account are different
// questions over different chats, so their threads must not mix.
const STORE_KEY = 'portal-ai-thread'
const MAX_KEPT_TURNS = 20

function storeKey(accountId) {
  return `${STORE_KEY}:${accountId ?? 'all'}`
}

function loadThread(accountId) {
  try {
    const raw = sessionStorage.getItem(storeKey(accountId))
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed?.turns) ? parsed : { turns: [], readCount: null }
  } catch {
    return { turns: [], readCount: null }
  }
}

function saveThread(accountId, turns, readCount) {
  try {
    const key = storeKey(accountId)
    if (!turns.length) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify({ turns: turns.slice(-MAX_KEPT_TURNS), readCount }))
  } catch {
    /* storage full or blocked — the panel still works, it just forgets on close */
  }
}

const LEVEL_LABEL = { management: 'Management', team: 'Team', general: 'Attention' }

/**
 * A report is either the structured { sections: [{ title, items }] } the server
 * now returns, or a plain string (older threads kept in sessionStorage, or a
 * model that ignored the format). This is the text form of either — what Copy
 * puts on the clipboard and what goes back to the model as history.
 */
function reportToText(report) {
  if (!report) return ''
  if (typeof report === 'string') return report
  return report.sections
    .map((s) => {
      const items = s.items.map((it, n) => {
        const lines = [`${n + 1}. ${it.case || it.status}`]
        if (it.chat) lines.push(`   Chat: ${it.chat.name}${it.related?.length ? ` (also: ${it.related.map((c) => c.name).join(', ')})` : ''}`)
        if (it.people?.length) lines.push(`   People: ${it.people.join(', ')}`)
        if (it.case && it.status) lines.push(`   Status: ${it.status}`)
        if (it.action) lines.push(`   Next: ${it.action}`)
        return lines.join('\n')
      })
      return `${s.title}:\n${items.join('\n\n')}`
    })
    .join('\n\n')
}

function ChatLink({ chat, onOpenChat, small }) {
  return (
    <button
      type="button"
      className={`portal-ai-chat${small ? ' portal-ai-chat--small' : ''}`}
      onClick={() => onOpenChat?.(chat.id)}
      title={chat.account_name ? `Open ${chat.name} — ${chat.account_name}` : `Open ${chat.name}`}
    >
      {chat.is_group ? <Users size={12} /> : <User size={12} />}
      <span className="portal-ai-chat-name">{chat.name}</span>
    </button>
  )
}

/** One card per case, grouped under its section, each linked to its chat. */
function StructuredReport({ report, onOpenChat }) {
  return (
    <div className="portal-ai-sections">
      {report.sections.map((s, si) => (
        <section key={si} className="portal-ai-section">
          <h4 className="portal-ai-section-title">
            {s.title}
            <span className="portal-ai-section-count">{s.items.length}</span>
          </h4>
          {s.items.map((it, ii) => (
            <article key={ii} className="portal-ai-case">
              <div className="portal-ai-case-head">
                <span className="portal-ai-case-num">{ii + 1}</span>
                <span className="portal-ai-case-title">{it.case || it.status}</span>
                {it.level ? (
                  <span className={`portal-ai-level portal-ai-level--${it.level}`}>
                    {LEVEL_LABEL[it.level]}
                  </span>
                ) : null}
              </div>
              {it.people?.length ? (
                <div className="portal-ai-case-row">
                  <span className="portal-ai-case-key">People</span>
                  <span>{it.people.join(' · ')}</span>
                </div>
              ) : null}
              {it.case && it.status ? (
                <div className="portal-ai-case-row">
                  <span className="portal-ai-case-key">Status</span>
                  <span>{it.status}</span>
                </div>
              ) : null}
              {it.action ? (
                <div className="portal-ai-case-row portal-ai-case-row--action">
                  <span className="portal-ai-case-key">Next</span>
                  <span>{it.action}</span>
                </div>
              ) : null}
              {it.chat ? (
                <div className="portal-ai-case-chat">
                  <ChatLink chat={it.chat} onOpenChat={onOpenChat} small />
                  {it.related?.map((c) => (
                    <ChatLink key={c.id} chat={c} onOpenChat={onOpenChat} small />
                  ))}
                  <span className="portal-ai-case-owner">
                    {it.chat.assigned_to ? `Handled by ${it.chat.assigned_to}` : 'Unassigned'}
                  </span>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </div>
  )
}

// Starter prompts. These are the questions the panel exists to answer, so they
// are offered rather than left for the user to guess at.
const SUGGESTIONS = [
  { label: "Today's report", question: 'Give me a daily report of everything that happened today.' },
  { label: 'Needs attention', question: 'Which conversations need attention right now, and why?' },
  { label: 'Waiting on us', question: 'Which chats are waiting on a reply from us? Oldest first.' },
  { label: 'Group chats', question: 'Summarise what is happening in the group chats.' },
]

export default function PortalAssistant({ onClose, onOpenChat }) {
  const { accountId, account, hasMultiple } = useAccounts()

  // Each turn is { role, content, report?, chats? }. `report` is the long
  // structured rundown the model produces for a report request; it renders in
  // its own block with a copy button, so it can be pasted into email or a group
  // chat. `chats` are the conversations the answer names, shown as links.
  const [turns, setTurns] = useState(() => loadThread(accountId).turns)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)
  const [copiedAt, setCopiedAt] = useState(null)
  // How many conversations the last answer was drawn from — shown once, as a
  // footnote, so the answer's scope is never a mystery.
  const [readCount, setReadCount] = useState(() => loadThread(accountId).readCount)

  useEffect(() => {
    saveThread(accountId, turns, readCount)
  }, [accountId, turns, readCount])

  const askAbort = useRef(null)
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const panelRef = useRef(null)

  // Abort any in-flight ask when the panel closes, so a late reply cannot set
  // state on an unmounted component.
  useEffect(() => () => askAbort.current?.abort(), [])

  // Focus the composer on open — the panel exists to be typed into.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [])

  // Escape closes. Unlike SummaryPopover this panel is NOT anchored to a row
  // and has no keyboard-vs-outside-tap ambiguity to protect against, so the
  // ordinary dialog convention applies.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The panel is modal and covers the screen on a phone, so the page behind it
  // has no business scrolling while it is open.
  useEffect(() => {
    const { body } = document
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      body.style.overflow = previousOverflow
    }
  }, [])

  // --- Keyboard-aware geometry -------------------------------------------
  // Same problem, same fix as SummaryPopover: on iOS the layout viewport does
  // not shrink for the soft keyboard, so a fixed panel's composer ends up
  // underneath it. visualViewport reports the actually-visible rectangle;
  // publishing it as CSS variables lets the stylesheet pin the sheet to that.
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
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      el.style.setProperty('--vv-keyboard', `${Math.round(keyboard)}px`)
      el.dataset.keyboard = keyboard > 80 ? 'open' : 'closed'
    }

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

  // Keep the newest turn in view as the thread grows.
  useEffect(() => {
    if (turns.length || asking) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns, asking])

  const ask = async (text) => {
    const trimmed = String(text || '').trim()
    if (!trimmed || asking) return

    // Only the plain role/content pairs go back as history — `report` is a
    // client-side convenience and the model already has it in `content`.
    const history = turns.map((t) => ({
      role: t.role,
      content: t.report ? `${t.content}\n${reportToText(t.report)}` : t.content,
    }))

    setTurns((prev) => [...prev, { role: 'user', content: trimmed }])
    setQuestion('')
    setError(null)
    setAsking(true)

    askAbort.current?.abort()
    const controller = new AbortController()
    askAbort.current = controller

    try {
      const res = await api.portalAsk(trimmed, {
        history,
        accountId,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.answer || (res.report ? '' : 'No answer came back. Please try again.'),
          report: res.report || null,
          chats: Array.isArray(res.chats) ? res.chats : [],
        },
      ])
      setReadCount(typeof res.conversations_read === 'number' ? res.conversations_read : null)
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return
      setError(err?.message || 'Couldn’t get an answer. Try again.')
    } finally {
      if (!controller.signal.aborted) setAsking(false)
    }
  }

  const startOver = () => {
    askAbort.current?.abort()
    setAsking(false)
    setTurns([])
    setReadCount(null)
    setError(null)
    inputRef.current?.focus()
  }

  const handleSubmit = (e) => {
    e?.preventDefault?.()
    ask(question)
  }

  // Copy an answer or report. Falls back to a hidden textarea where the async
  // clipboard API is unavailable (older iOS Safari, non-secure origins).
  const handleCopy = async (text, key) => {
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
      setCopiedAt(key)
      setTimeout(() => setCopiedAt((c) => (c === key ? null : c)), 1600)
    } catch {
      setError('Couldn’t copy to the clipboard.')
    }
  }

  // Which chats this panel is reading, said plainly in the header. With one
  // account there is nothing to disambiguate, so the label is omitted.
  const scopeLabel = !hasMultiple
    ? 'All chats'
    : account?.name
      ? `${account.name} — all chats`
      : 'All accounts'

  return (
    <>
      <div className="portal-ai-backdrop" onClick={onClose} />
      <div
        className="portal-ai"
        role="dialog"
        aria-modal="true"
        aria-label="Ask AI about all chats"
        ref={panelRef}
      >
        <div className="portal-ai-head">
          <span className="portal-ai-title">
            <Sparkles size={15} />
            Ask AI
            <span className="portal-ai-scope">{scopeLabel}</span>
          </span>
          {turns.length ? (
            <button
              type="button"
              className="portal-ai-close"
              aria-label="Start a new question"
              title="Start over"
              onClick={startOver}
            >
              <RotateCcw size={14} />
            </button>
          ) : null}
          <button type="button" className="portal-ai-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="portal-ai-body">
          {turns.length === 0 && !asking ? (
            <div className="portal-ai-empty">
              <p className="portal-ai-empty-lead">
                Ask about every chat in the inbox — group chats and personal chats — or ask for a
                daily report.
              </p>
              <div className="portal-ai-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="portal-ai-suggestion"
                    onClick={() => ask(s.question)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="portal-ai-turn portal-ai-turn--user">
                {turn.content}
              </div>
            ) : (
              <div key={i} className="portal-ai-turn portal-ai-turn--ai">
                {turn.content ? <p className="portal-ai-answer">{turn.content}</p> : null}

                {turn.report ? (
                  <div className="portal-ai-report">
                    <div className="portal-ai-report-head">
                      <FileText size={12} />
                      <span style={{ flex: 1 }}>Report</span>
                      <button
                        type="button"
                        className="portal-ai-action"
                        onClick={() => handleCopy(reportToText(turn.report), i)}
                        title="Copy this report"
                      >
                        {copiedAt === i ? <Check size={12} /> : <Copy size={12} />}
                        {copiedAt === i ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    {typeof turn.report === 'string' ? (
                      <p className="portal-ai-report-text">{turn.report}</p>
                    ) : (
                      <StructuredReport report={turn.report} onOpenChat={onOpenChat} />
                    )}
                  </div>
                ) : turn.content ? (
                  <div className="portal-ai-turn-actions">
                    <button
                      type="button"
                      className="portal-ai-action"
                      onClick={() => handleCopy(turn.content, i)}
                      title="Copy this answer"
                    >
                      {copiedAt === i ? <Check size={12} /> : <Copy size={12} />}
                      {copiedAt === i ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : null}

                {/* A structured report links each case to its chat already. */}
                {turn.chats?.length && (!turn.report || typeof turn.report === 'string') ? (
                  <div className="portal-ai-chats">
                    <span className="portal-ai-chats-label">Open chat</span>
                    {turn.chats.map((c) => (
                      <ChatLink key={c.id} chat={c} onOpenChat={onOpenChat} />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          )}

          {asking ? (
            <div className="portal-ai-turn portal-ai-turn--ai portal-ai-pending">
              <span className="spinner" />
              Reading the inbox…
            </div>
          ) : null}

          {!asking && readCount != null && turns.length ? (
            <div className="portal-ai-foot">
              Read {readCount} conversation{readCount === 1 ? '' : 's'}.
            </div>
          ) : null}

          <div ref={endRef} />
        </div>

        {error ? <div className="portal-ai-error">{error}</div> : null}

        <form className="portal-ai-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="portal-ai-input"
            placeholder="Ask about all chats, or ask for a daily report…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={asking}
            aria-label="Ask the AI about all conversations"
          />
          <button
            type="submit"
            className="portal-ai-send"
            disabled={asking || !question.trim()}
            aria-label="Ask"
          >
            <Send size={15} />
          </button>
        </form>
      </div>
    </>
  )
}
