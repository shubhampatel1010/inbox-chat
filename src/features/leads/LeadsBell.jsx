// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// Mounted once, in the Shell topbar. Renders nothing at all when the caller has
// no leads, so a user who never owns leads sees no change to the UI. The red
// badge counts UNREAD leads only; read ones stay in the list.

import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, Ban, Bell, CalendarClock, Check, CircleCheck, CirclePause, Mail, Phone, Timer, TriangleAlert } from 'lucide-react'
import { useMyLeads, isUnread } from './useMyLeads.js'
import { leadChips, isBlank, formatLeadTime, fullLeadTime, CONTACT_OUTCOMES, statusLabel, leadSlaPill, workingHoursLabel } from './leadFields.js'

export default function LeadsBell() {
  const { leads, readSet, unreadCount, loading, markRead, markAllRead, logOutcome } = useMyLeads()
  const [open, setOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const wrapRef = useRef(null)

  // Live SLA countdown while the panel is open — re-renders the pills every
  // 30s from the client clock; it never refetches (same as the OS inbox).
  useEffect(() => {
    if (!open) return undefined
    setNowMs(Date.now())
    const iv = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(iv)
  }, [open])

  // Close on outside click / Escape — same contract as the user menu next door.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // If the list empties (e.g. the last lead is archived in the OS), the bell
  // is about to unmount — close the panel rather than let it hang.
  useEffect(() => {
    if (open && leads.length === 0) setOpen(false)
  }, [open, leads.length])

  // The panel is anchored to the bell, but the bell is not the rightmost
  // control in the topbar, so on a phone a right-aligned panel runs off the
  // left edge of the screen. Measure how far the bell sits from the viewport's
  // right edge and publish it; the mobile CSS subtracts it to pull the panel
  // back onto the gutter. Recomputed on resize/orientation change because the
  // gap moves with the topbar's layout.
  useEffect(() => {
    if (!open) return undefined
    const measure = () => {
      const el = wrapRef.current
      if (!el) return
      const gap = window.innerWidth - el.getBoundingClientRect().right
      el.style.setProperty('--leads-pop-shift', `${Math.max(0, Math.round(gap))}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [open])

  // No leads at all → nothing is drawn. With leads but none unread, the bell
  // stays (the list is still worth opening) but carries no badge.
  if (loading || leads.length === 0) return null

  const bellLabel = unreadCount
    ? `${unreadCount} unread lead${unreadCount === 1 ? '' : 's'}`
    : 'Leads'

  return (
    <div className="leads-bell" ref={wrapRef}>
      <button
        type="button"
        className="leads-bell-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={bellLabel}
        title={bellLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {unreadCount ? (
          <span className="leads-bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="leads-pop" role="menu">
          <div className="leads-pop-head">
            <span className="leads-pop-title">Leads</span>
            {unreadCount ? (
              <span className="leads-pop-count" title={bellLabel}>
                {unreadCount}
              </span>
            ) : null}
            {unreadCount ? (
              <button
                type="button"
                className="leads-pop-clear"
                onClick={markAllRead}
                title="Mark every lead as read"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <ul className="leads-pop-list">
            {leads.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                unread={isUnread(lead, readSet)}
                nowMs={nowMs}
                onMarkRead={() => markRead(lead.id)}
                onOutcome={(outcome) => logOutcome(lead.id, outcome)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function LeadRow({ lead, unread, nowMs, onMarkRead, onOutcome }) {
  // Summaries run to several sentences. Clamped to two lines so one verbose
  // lead cannot push the rest of the list out of view, with the full text one
  // click away rather than hidden behind a tooltip nobody hovers.
  const [expanded, setExpanded] = useState(false)

  const facts = leadChips(lead)
  const hasSummary = !isBlank(lead.summary)
  const hasPhone = !isBlank(lead.phone)
  const hasEmail = !isBlank(lead.email)

  return (
    <li className={`leads-item${unread ? ' is-unread' : ''}`}>
      {/* Header: who, and where the lead stands — the two things read first. */}
      <div className="leads-item-top">
        {unread ? <span className="leads-item-dot" aria-label="Unread" /> : null}
        <span className="leads-item-name">{lead.full_name || 'Unnamed lead'}</span>
        {lead.lead_number ? <span className="leads-item-no">{lead.lead_number}</span> : null}
        {/* Marks read; never removes. Read leads stay in the list. */}
        {unread ? (
          <button
            type="button"
            className="leads-item-x"
            aria-label={`Mark ${lead.full_name || 'lead'} as read`}
            title="Mark as read"
            onClick={onMarkRead}
          >
            <Check size={14} />
          </button>
        ) : null}
      </div>

      <div className="leads-item-state">
        <LeadSla lead={lead} nowMs={nowMs} />
        <span className={`leads-status-pill leads-status-${lead.status || 'new'}`}>
          {statusLabel(lead.status || 'new')}
        </span>
      </div>

      {/* Phone first: it is on every lead and is the one field an agent acts
          on, so it stays a tap-to-call link. */}
      {hasPhone || hasEmail ? (
        <div className="leads-contact">
          {hasPhone ? (
            <a className="leads-contact-link" href={`tel:${lead.phone}`} title={`Call ${lead.phone}`}>
              <Phone size={13} />
              <span>{lead.phone}</span>
            </a>
          ) : null}
          {hasEmail ? (
            <a className="leads-contact-link" href={`mailto:${lead.email}`} title={lead.email}>
              <Mail size={13} />
              <span>{lead.email}</span>
            </a>
          ) : null}
        </div>
      ) : null}

      {/* The enquiry as a label-over-value grid. Absent fields are omitted, not
          dashed — most leads fill only four or five of these. */}
      {facts.length ? (
        <dl className="leads-facts">
          {facts.map((fact) => (
            <div key={fact.key} className={`leads-fact leads-fact-${fact.tone}`}>
              <dt>{fact.label}</dt>
              <dd title={fact.text}>{fact.text}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {hasSummary ? (
        <button
          type="button"
          className={`leads-item-summary${expanded ? ' is-open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Show less' : 'Show full summary'}
        >
          {lead.summary}
        </button>
      ) : null}

      <div className="leads-item-foot">
        <LeadMeta lead={lead} />
        <LeadOutcome onLog={onOutcome} />
      </div>
    </li>
  )
}

const SLA_ICONS = {
  ontrack: CircleCheck,
  timer: Timer,
  warning: TriangleAlert,
  verified: BadgeCheck,
  closed: Ban,
  callback: CalendarClock,
  paused: CirclePause,
}

/** Contact SLA pill, as the OS lead inbox shows it. Display only. */
function LeadSla({ lead, nowMs }) {
  const pill = leadSlaPill(lead, nowMs)
  const Icon = SLA_ICONS[pill.icon] || CircleCheck
  // The hover explains a paused or slow-moving clock: it only counts inside
  // the tenant's working hours.
  const title = ['Contact SLA', workingHoursLabel(lead)].filter(Boolean).join(' · ')
  return (
    <span className={`leads-sla-pill leads-sla-${pill.tone}`} title={title}>
      <Icon size={12} />
      {pill.label}
    </span>
  )
}

/**
 * Provenance and ownership: when the enquiry came in and which salesperson
 * holds it. Two quiet lines in the footer — facts to look up, not to scan.
 */
function LeadMeta({ lead }) {
  const owner = lead.owner || null
  const ownerName = owner?.display_name || owner?.email || null
  const received = formatLeadTime(lead.received_at)

  return (
    <div className="leads-meta">
      <div className="leads-meta-row" title={lead.assigned_at ? `Assigned ${fullLeadTime(lead.assigned_at)}` : undefined}>
        {lead.owner_profile_id ? (
          <span className="leads-meta-strong">{ownerName || 'Unknown profile'}</span>
        ) : (
          <span className="leads-meta-muted">Unassigned</span>
        )}
      </div>
      {received ? (
        <div className="leads-meta-row leads-meta-muted" title={fullLeadTime(lead.received_at)}>
          Received {received}
        </div>
      ) : null}
    </div>
  )
}

/**
 * "Log what happened…" — the same control as the OS lead drawer. Each pick is
 * logged as an activity; on a 'new' lead it also moves the status on, and the
 * resulting status shows in the card header. The select is locked while a save
 * is in flight so a second pick cannot race the first, and a failure shows
 * inline.
 */
function LeadOutcome({ onLog }) {
  const [outcome, setOutcome] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleChange = async (e) => {
    const next = e.target.value
    if (!next) return
    setSaving(true)
    setError('')
    try {
      await onLog(next)
      setOutcome(next)
    } catch (err) {
      setError(err?.message || 'Could not log outcome')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="leads-status">
      <select
        className={`leads-status-select${outcome ? ' is-set' : ''}`}
        value={outcome}
        onChange={handleChange}
        disabled={saving}
        aria-label="Log what happened"
      >
        <option value="" disabled>
          {saving ? 'Saving…' : 'Log what happened…'}
        </option>
        {CONTACT_OUTCOMES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      {error ? <span className="leads-status-error">{error}</span> : null}
    </div>
  )
}
