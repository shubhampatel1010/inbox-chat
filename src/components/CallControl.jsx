import { useCallback, useEffect, useRef, useState } from 'react'
import { Phone, ChevronDown, RefreshCw, User } from 'lucide-react'
import { api } from '../lib/api.js'
import { isMobileDialer, ringqHref } from '../lib/dialer.js'
import { avatarIndex, digitsOnly, formatLocalNumber, initials, localNumber } from '../lib/format.js'

/**
 * Click-to-call for the thread header.
 *
 * The dialing is NOT done here. A browser extension watches the page for phone
 * numbers and places the call itself, so this control's only job is to put the
 * number on the page in the shape such extensions look for: a real
 * `tel:`-href anchor holding the bare E.164 digits. `data-phone` carries the
 * same digits as a second hook for extensions that match attributes rather
 * than hrefs, and the visible text is the formatted number for the human.
 *
 * Leaving it as an <a href="tel:"> also means the control still works with no
 * extension installed — the OS dialer picks it up — which a button wired to a
 * click handler would not.
 *
 * Numbers are dialed WITHOUT their country code: the platform behind the
 * extension rejects a number that carries one. localNumber() strips it only
 * for countries whose subscriber length is known, so an unrecognised number
 * keeps all its digits instead of being cut to an unreachable one.
 *
 * 1:1 chats get a single anchor. Groups get a menu, because the extension can
 * only dial one person at a time: there is no such thing as calling a group
 * through it, so the user picks the member to ring.
 *
 * Phones have no extension, and a bare tel: there rings from the SIM. So on
 * mobile a tap opens DialChooser instead, which offers RingQ or the phone
 * dialer — see lib/dialer.js.
 */
export default function CallControl({ conversation }) {
  const isGroup = Boolean(conversation.is_group)
  const number = digitsOnly(conversation.customer_number)

  // --- Group: member picker ----------------------------------------------
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  // Mobile only: the number waiting on a RingQ-or-phone choice.
  const [choosing, setChoosing] = useState(null)

  // On mobile, intercept the anchor's tap and ask which app to call from. The
  // href stays as the no-JS / desktop fallback.
  const onDialClick = (digits) => (e) => {
    if (!isMobileDialer) return
    e.preventDefault()
    setOpen(false)
    setChoosing(digits)
  }
  const chooser = choosing ? (
    <DialChooser digits={choosing} onClose={() => setChoosing(null)} />
  ) : null

  // Same dismissal contract as the account switcher: pointer outside, or
  // Escape. Escape also returns focus to the trigger; the mouse path does not
  // need to, because the pointer is already where the user is looking.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Members are fetched lazily on first open rather than with the thread: most
  // threads are never called from, and this is the same cached endpoint the
  // info panel uses, so an open after visiting that panel is already warm.
  const load = useCallback(
    async (refresh) => {
      setLoading(true)
      setError(null)
      try {
        const data = refresh
          ? await api.refreshGroupMembers(conversation.id)
          : await api.groupMembers(conversation.id)
        setMembers(data.members || [])
        if (data.warning) setError(data.warning)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    },
    [conversation.id]
  )

  // A different conversation means a different roster. Drop the old one rather
  // than showing the previous group's members under this group's name.
  useEffect(() => {
    setOpen(false)
    setMembers([])
    setError(null)
    setChoosing(null)
  }, [conversation.id])

  if (!isGroup) {
    if (!number) return null
    const local = localNumber(number)
    const pretty = formatLocalNumber(number)
    return (
      <>
        <a
          className="icon-btn call-btn"
          href={`tel:${local}`}
          data-phone={local}
          aria-label={`Call ${pretty}`}
          title={`Call ${pretty}`}
          onClick={onDialClick(local)}
        >
          <Phone size={18} />
        </a>
        {chooser}
      </>
    )
  }

  const openMenu = () => {
    const next = !open
    setOpen(next)
    if (next && !members.length && !loading) load(false)
  }

  // A group whose members carry no number cannot be dialed at all. Keep the
  // menu open to say so rather than silently rendering an empty list.
  const dialable = members.filter((m) => digitsOnly(m.member_number))

  return (
    <div className="call-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`icon-btn call-btn call-btn-group${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Call a group member"
        title="Call a group member"
        onClick={openMenu}
      >
        <Phone size={18} />
        <ChevronDown size={11} className="call-caret" />
      </button>

      {open ? (
        <div className="call-pop" role="menu" aria-label="Call a group member">
          <div className="call-pop-head">
            <span>Call a member</span>
            <button
              type="button"
              className="icon-btn call-refresh"
              aria-label="Refresh member list"
              title="Refresh member list"
              disabled={loading}
              onClick={() => load(true)}
            >
              <RefreshCw size={13} className={loading ? 'is-spinning' : undefined} />
            </button>
          </div>

          {/* Says plainly why this is a list and not a single call button —
              the group itself is not dialable, only the people in it. */}
          <p className="call-pop-note">Calls go to one person at a time.</p>

          {loading && !members.length ? (
            <div className="call-pop-state">Loading members…</div>
          ) : error && !dialable.length ? (
            <div className="call-pop-state call-pop-error">{error}</div>
          ) : !dialable.length ? (
            <div className="call-pop-state">No member numbers recorded yet.</div>
          ) : (
            <div className="call-pop-list">
              {dialable.map((m) => {
                const digits = localNumber(m.member_number)
                const pretty = formatLocalNumber(m.member_number)
                // WhatsApp does not always expose a member's name, and most
                // groups here have none at all. When there is no name the
                // number IS the identity, so it becomes the single primary
                // line — printing it as both the name and the subtitle showed
                // every row twice, and fed initials() a '+65...' string that
                // came out as a meaningless '+' in the avatar.
                const name = m.member_name?.trim() || null
                return (
                  <a
                    key={m.id}
                    role="menuitem"
                    className="menu-item call-item"
                    href={`tel:${digits}`}
                    data-phone={digits}
                    aria-label={`Call ${name || pretty}`}
                    onClick={isMobileDialer ? onDialClick(digits) : () => setOpen(false)}
                  >
                    <span
                      className="conv-avatar call-item-avatar"
                      data-color={avatarIndex(m.member_number)}
                    >
                      {name ? initials(name) : <User size={14} />}
                    </span>
                    <span className="call-item-id">
                      {name ? (
                        <>
                          <span className="call-item-name">{name}</span>
                          <span className="call-item-number">{pretty}</span>
                        </>
                      ) : (
                        <span className="call-item-name call-item-name-number">{pretty}</span>
                      )}
                    </span>
                    <Phone size={14} className="call-item-icon" />
                  </a>
                )
              })}
            </div>
          )}

          {/* A refresh that partly failed still leaves usable rows above, so
              the warning sits under them instead of replacing them. */}
          {error && dialable.length ? <div className="call-pop-warn">{error}</div> : null}
        </div>
      ) : null}
      {chooser}
    </div>
  )
}

/**
 * Mobile action sheet: call through RingQ, or through the phone's own dialer.
 *
 * RingQ cannot be handed a number from a web page: on iOS it has no public
 * URL scheme and is not offered as a default calling app, and on Android it
 * has no browsable intent filter, so Chrome sends the intent to the Play Store.
 * So the RingQ path copies the number in the same tap and the user switches to
 * RingQ and pastes. public/ringq-test.html probes for a link that does fill
 * the number in; if one is found, ringqHref() returns it and RingQ becomes a
 * plain link.
 */
function DialChooser({ digits, onClose }) {
  const [step, setStep] = useState('choose')
  const [copied, setCopied] = useState(null)
  const pretty = formatLocalNumber(digits)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => setCopied(await copyText(digits))
  const ringq = ringqHref(digits)

  // Copy in the same tap that picks RingQ, so the number is already on the
  // clipboard when the sheet says to switch apps.
  const pickRingq = () => {
    setStep('ringq')
    copy()
  }

  return (
    <div className="dial-sheet-backdrop" onClick={onClose}>
      <div
        className="dial-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Call ${pretty}`}
        onClick={(e) => e.stopPropagation()}
      >
        {step === 'choose' ? (
          <>
            <div className="dial-sheet-title">Call {pretty} from</div>
            {ringq ? (
              <a className="dial-sheet-btn is-primary" href={ringq} onClick={onClose}>
                RingQ
              </a>
            ) : (
              <button type="button" className="dial-sheet-btn is-primary" onClick={pickRingq}>
                RingQ
              </button>
            )}
            <a className="dial-sheet-btn" href={`tel:${digits}`} onClick={onClose}>
              Phone
            </a>
          </>
        ) : (
          <>
            <div className="dial-sheet-title">Call with RingQ</div>
            <div className="dial-sheet-number">{pretty}</div>
            <button type="button" className="dial-sheet-btn is-primary" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy number'}
            </button>
            <p className={`dial-sheet-hint${copied === false ? ' is-error' : ''}`}>
              {copied === false
                ? 'Could not copy — press and hold the number above to copy it.'
                : 'Number copied. Switch to RingQ, then long-press the keypad and paste.'}
            </p>
          </>
        )}
        <button type="button" className="dial-sheet-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Clipboard write with a fallback for browsers or contexts (plain http) where
 * navigator.clipboard is missing or refuses. Resolves true on success.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    el.setSelectionRange(0, text.length)
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    el.remove()
    return ok
  }
}
