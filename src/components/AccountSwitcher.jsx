import { useEffect, useRef, useState } from 'react'
import { Building2, Check } from 'lucide-react'
import { useAccounts, ALL_ACCOUNTS } from '../context/AccountContext.jsx'
import { initials } from '../lib/format.js'

/**
 * Short mark for a rail button: the account's initials, or a building glyph for
 * the merged view. Two letters is all 42px holds.
 */
function AccountMark({ account }) {
  if (!account) return <Building2 size={18} aria-hidden="true" />
  return (
    <span className="rail-account-initials" aria-hidden="true">
      {initials(account.name)}
    </span>
  )
}

/**
 * The active-account selector, as a rail button that opens a popover.
 *
 * WHY THE RAIL: the selection is app-wide, not a filter on the conversation
 * list it used to sit above — it also scopes the channel banner, which channel
 * a new message sends from, and what "Ask AI" reads. The rail is where app-wide
 * things live.
 *
 * WHY A POPOVER AND NOT A ROW PER ACCOUNT: the rail is 60px, which fits an icon
 * and nothing else. Initials alone are ambiguous once two accounts share them,
 * so the names have to appear somewhere on demand.
 *
 * Renders nothing with a single account — same guard as always, so a
 * single-account install sees no new chrome.
 *
 * NOT RENDERED ON MOBILE: the rail is `display: none` under 720px, so this
 * would silently take account switching away from phones entirely. The mobile
 * path is <AccountSwitcherMenuItems />, in the user menu.
 */
export default function AccountSwitcher() {
  const { accounts, hasMultiple, selected, account, isAll, select } = useAccounts()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)

  // Same dismissal contract as the user menu in Shell: pointer outside, or
  // Escape. Escape also returns focus to the trigger, which the mouse path
  // does not need.
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

  if (!hasMultiple) return null

  const label = isAll ? 'All accounts' : account?.name ?? 'Account'

  const choose = (value) => {
    select(value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="rail-account" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`rail-link rail-account-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        // The rail has no room for a visible label, so the accessible name
        // carries both the control's purpose and its current value.
        aria-label={`Account: ${label}. Change account`}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <AccountMark account={isAll ? null : account} />
      </button>

      {open ? (
        <div className="rail-account-pop" role="menu" aria-label="Switch account">
          <div className="rail-account-pop-head">Account</div>

          <button
            type="button"
            role="menuitemradio"
            aria-checked={isAll}
            className={`menu-item${isAll ? ' is-selected' : ''}`}
            onClick={() => choose(ALL_ACCOUNTS)}
          >
            <Building2 size={15} />
            <span style={{ flex: 1 }}>All accounts</span>
            {isAll ? <Check size={15} className="rail-account-check" /> : null}
          </button>

          {accounts.map((a) => {
            const active = String(a.id) === String(selected)
            return (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`menu-item${active ? ' is-selected' : ''}`}
                onClick={() => choose(a.id)}
              >
                <span className="rail-account-swatch" aria-hidden="true">
                  {initials(a.name)}
                </span>
                <span className="rail-account-name">{a.name}</span>
                {active ? <Check size={15} className="rail-account-check" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The same switcher as items inside the user menu — the mobile path, because
 * the rail is hidden under 720px and phones would otherwise have no way to
 * change account at all.
 *
 * Follows the precedent already set for Team management, which lives in this
 * menu on mobile for exactly the same reason.
 *
 * Returns null with one account, and on desktop, where the rail button is the
 * canonical control and duplicating it here would give two live copies of one
 * setting in the same viewport.
 */
export function AccountSwitcherMenuItems({ onAction }) {
  const { accounts, hasMultiple, selected, isAll, select } = useAccounts()

  if (!hasMultiple) return null

  const choose = (value) => {
    select(value)
    onAction?.()
  }

  return (
    <div className="menu-accounts mobile-only">
      <div className="menu-section-label">Account</div>

      <button
        type="button"
        className={`menu-item${isAll ? ' is-selected' : ''}`}
        role="menuitemradio"
        aria-checked={isAll}
        onClick={() => choose(ALL_ACCOUNTS)}
      >
        <Building2 size={15} />
        <span style={{ flex: 1 }}>All accounts</span>
        {isAll ? <Check size={15} className="rail-account-check" /> : null}
      </button>

      {accounts.map((a) => {
        const active = String(a.id) === String(selected)
        return (
          <button
            key={a.id}
            type="button"
            className={`menu-item${active ? ' is-selected' : ''}`}
            role="menuitemradio"
            aria-checked={active}
            onClick={() => choose(a.id)}
          >
            <span className="rail-account-swatch" aria-hidden="true">
              {initials(a.name)}
            </span>
            <span className="rail-account-name">{a.name}</span>
            {active ? <Check size={15} className="rail-account-check" /> : null}
          </button>
        )
      })}
    </div>
  )
}
