import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Check, X } from 'lucide-react'
import {
  CONTACT_TYPES, COUNTRIES, contactTypeLabel, countryLabel, isOtherOption,
} from '../../functions/_lib/contactMeta.js'

/**
 * A "+ Label" chip that opens a portalled multi-select dropdown — the exact
 * pattern the Agent picker used, extracted so BOTH the Agent and Attention
 * pickers share one implementation (and each gets its own open/position state).
 *
 * The menu is portalled to <body> and fixed-positioned: it cannot be an
 * absolutely-positioned child because .filter-row is the mobile horizontal
 * scroller (overflow-x: auto / overflow-y: hidden), whose non-visible overflow
 * clips descendants on BOTH axes.
 */
function FilterPicker({ summary, hasSelection, onClear, clearLabel, children }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState(null)
  const pickerRef = useRef(null)
  const chipRef = useRef(null)
  const menuRef = useRef(null)

  const place = useCallback(() => {
    const chip = chipRef.current
    if (!chip) return
    const rect = chip.getBoundingClientRect()
    // Kept in sync with .filter-menu's min-width, plus a little slack for the
    // widest label, so the on-screen left-clamp below keeps the whole menu in view.
    const MENU_W = 210
    const MENU_MAX_H = 260
    const GAP = 6

    // Flip above the chip when there is not enough room below it.
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    const above = spaceBelow < Math.min(MENU_MAX_H, 160) && rect.top > spaceBelow

    setMenuPos({
      top: above ? undefined : rect.bottom + GAP,
      bottom: above ? window.innerHeight - rect.top + GAP : undefined,
      // Keep it on screen at narrow widths.
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8)),
      maxHeight: above ? rect.top - GAP - 8 : spaceBelow - 8,
    })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined

    const onDown = (e) => {
      // The menu lives outside pickerRef (portalled), so both are checked.
      const inPicker = pickerRef.current?.contains(e.target)
      const inMenu = menuRef.current?.contains(e.target)
      if (!inPicker && !inMenu) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Capture, so a scroll inside the list or the filter row also repositions.
    const onScrollOrResize = () => place()

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, place])

  return (
    <div className="filter-picker" ref={pickerRef}>
      <button
        type="button"
        ref={chipRef}
        className={`filter-chip${hasSelection ? ' is-on' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
      </button>

      {/* Reset sits outside the toggle so it never costs a second tap to
          reach, and never fires when the user meant to reopen the picker. */}
      {hasSelection && onClear ? (
        <button
          type="button"
          className="filter-clear-agents"
          aria-label={clearLabel}
          onClick={onClear}
        >
          <X size={12} />
        </button>
      ) : null}

      {open && menuPos
        ? createPortal(
            <div
              className="filter-menu"
              role="menu"
              ref={menuRef}
              style={{
                top: menuPos.top,
                bottom: menuPos.bottom,
                left: menuPos.left,
                maxHeight: menuPos.maxHeight,
              }}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

/**
 * Options for a contact-field picker: the known list, then any other value
 * actually present in the data (typed via "Other", or filled from outside this
 * app), each with a live count. Groups are skipped — the fields are 1:1 only.
 * The "Other" placeholder itself is only listed if some row still holds it.
 */
function fieldOptions(conversations, field, known, labelOf) {
  const counts = new Map()
  for (const c of conversations) {
    if (c.is_group || !c[field]) continue
    counts.set(c[field], (counts.get(c[field]) || 0) + 1)
  }
  const listed = known
    .map((k) => k.value)
    .filter((v) => !isOtherOption(v) || counts.has(v))
  const extra = [...counts.keys()]
    .filter((v) => !known.some((k) => k.value === v))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return [...listed, ...extra].map((value) => ({
    value,
    label: labelOf(value),
    count: counts.get(value) || 0,
  }))
}

/** Multi-select checklist body for a FilterPicker. */
function CheckList({ options, selected, onToggle }) {
  return options.map((o) => {
    const checked = selected.includes(o.value)
    return (
      <button
        type="button"
        key={o.value}
        className="filter-menu-item"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onToggle(o.value)}
      >
        <span className={`filter-check${checked ? ' is-on' : ''}`}>
          {checked ? <Check size={11} /> : null}
        </span>
        <span className="filter-menu-name">
          {o.label} ({o.count})
        </span>
      </button>
    )
  })
}

const toggleIn = (list, value) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

/** "+ Label" when empty, the one label when single, "N labels" otherwise. */
function pickerSummary(selected, labelOf, noun, plural) {
  if (!selected.length) {
    return (
      <>
        <Plus size={13} />
        {noun}
      </>
    )
  }
  return selected.length === 1 ? labelOf(selected[0]) : `${selected.length} ${plural}`
}

/**
 * Filter row: two multi-select status chips plus Agent, Attention, Type and
 * Country pickers (all the same "+ Label" dropdown pattern).
 *
 * Status chips are deliberately NOT radio buttons — both off and both on mean
 * the same thing (show everything), which keeps "clear the filter" reachable
 * from either direction.
 */
export default function ConversationFilters({ users, conversations = [], filters, onChange }) {
  const {
    assigned, unassigned, agentIds, attentionTeam, attentionManagement, contactTypes, countries,
  } = filters

  const typeOptions = fieldOptions(conversations, 'contact_type', CONTACT_TYPES, contactTypeLabel)
  const countryOptions = fieldOptions(conversations, 'country_of_origin', COUNTRIES, countryLabel)

  const activeAgents = users.filter((u) => u.is_active)
  const agentCount = agentIds.length

  // Live counts per attention level, recomputed each render (so they track every
  // poll refresh). Keyed on attention_level only, as specified.
  const teamCount = conversations.filter((c) => c.attention_level === 'team').length
  const managementCount = conversations.filter((c) => c.attention_level === 'management').length

  const toggleAgent = (id) => {
    const key = String(id)
    onChange({
      ...filters,
      agentIds: agentIds.includes(key)
        ? agentIds.filter((a) => a !== key)
        : [...agentIds, key],
    })
  }

  // Attention picker: two independent booleans (both on = team OR management).
  const attnCount = (attentionTeam ? 1 : 0) + (attentionManagement ? 1 : 0)

  return (
    <div className="filter-row" role="group" aria-label="Filter conversations">
      <button
        type="button"
        className={`filter-chip${assigned ? ' is-on' : ''}`}
        aria-pressed={assigned}
        onClick={() => onChange({ ...filters, assigned: !assigned })}
      >
        Assigned
      </button>

      <button
        type="button"
        className={`filter-chip${unassigned ? ' is-on' : ''}`}
        aria-pressed={unassigned}
        onClick={() => onChange({ ...filters, unassigned: !unassigned })}
      >
        Unassigned
      </button>

      <FilterPicker
        hasSelection={agentCount > 0}
        clearLabel="Clear agent filter"
        onClear={() => onChange({ ...filters, agentIds: [] })}
        summary={
          agentCount ? (
            `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`
          ) : (
            <>
              <Plus size={13} />
              Agent
            </>
          )
        }
      >
        {activeAgents.length === 0 ? (
          <div className="filter-menu-empty">No active team members</div>
        ) : (
          activeAgents.map((user) => {
            const checked = agentIds.includes(String(user.id))
            return (
              <button
                type="button"
                key={user.id}
                className="filter-menu-item"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => toggleAgent(user.id)}
              >
                <span className={`filter-check${checked ? ' is-on' : ''}`}>
                  {checked ? <Check size={11} /> : null}
                </span>
                <span className="filter-menu-name">{user.name}</span>
              </button>
            )
          })
        )}
      </FilterPicker>

      {/* Attention level — same picker pattern as Agent, to the right of it. */}
      <FilterPicker
        hasSelection={attnCount > 0}
        clearLabel="Clear attention filter"
        onClear={() => onChange({ ...filters, attentionTeam: false, attentionManagement: false })}
        summary={
          attnCount === 0 ? (
            <>
              <Plus size={13} />
              Attention
            </>
          ) : attnCount === 2 ? (
            '2 levels'
          ) : attentionTeam ? (
            'Team'
          ) : (
            'Management'
          )
        }
      >
        <button
          type="button"
          className="filter-menu-item"
          role="menuitemcheckbox"
          aria-checked={attentionTeam}
          onClick={() => onChange({ ...filters, attentionTeam: !attentionTeam })}
        >
          <span className={`filter-check${attentionTeam ? ' is-on' : ''}`}>
            {attentionTeam ? <Check size={11} /> : null}
          </span>
          <span className="filter-dot filter-dot-team" aria-hidden="true" />
          <span className="filter-menu-name">Team ({teamCount})</span>
        </button>

        <button
          type="button"
          className="filter-menu-item"
          role="menuitemcheckbox"
          aria-checked={attentionManagement}
          onClick={() => onChange({ ...filters, attentionManagement: !attentionManagement })}
        >
          <span className={`filter-check${attentionManagement ? ' is-on' : ''}`}>
            {attentionManagement ? <Check size={11} /> : null}
          </span>
          <span className="filter-dot filter-dot-management" aria-hidden="true" />
          <span className="filter-menu-name">Management ({managementCount})</span>
        </button>
      </FilterPicker>

      <FilterPicker
        hasSelection={contactTypes.length > 0}
        clearLabel="Clear contact type filter"
        onClear={() => onChange({ ...filters, contactTypes: [] })}
        summary={pickerSummary(contactTypes, contactTypeLabel, 'Type', 'types')}
      >
        <CheckList
          options={typeOptions}
          selected={contactTypes}
          onToggle={(v) => onChange({ ...filters, contactTypes: toggleIn(contactTypes, v) })}
        />
      </FilterPicker>

      <FilterPicker
        hasSelection={countries.length > 0}
        clearLabel="Clear country filter"
        onClear={() => onChange({ ...filters, countries: [] })}
        summary={pickerSummary(countries, countryLabel, 'Country', 'countries')}
      >
        <CheckList
          options={countryOptions}
          selected={countries}
          onToggle={(v) => onChange({ ...filters, countries: toggleIn(countries, v) })}
        />
      </FilterPicker>
    </div>
  )
}

export const EMPTY_FILTERS = {
  assigned: false,
  unassigned: false,
  agentIds: [],
  attentionTeam: false,
  attentionManagement: false,
  contactTypes: [],
  countries: [],
}

export const hasActiveFilters = (f) =>
  Boolean(
    f.assigned ||
      f.unassigned ||
      f.agentIds.length ||
      f.attentionTeam ||
      f.attentionManagement ||
      f.contactTypes.length ||
      f.countries.length
  )

/**
 * Status chips and the agent picker combine with AND.
 *
 * "Unassigned" active together with selected agents is contradictory by
 * definition — a conversation cannot both lack an assignee and be assigned to
 * a chosen agent. That falls out of the AND naturally and yields an empty
 * list, which is what the brief asks for: surface the contradiction rather
 * than silently dropping one of the filters.
 */
export function matchesFilters(conversation, filters) {
  const hasAssignee = conversation.assigned_user_id != null

  // Both off or both on means no status constraint.
  if (filters.assigned !== filters.unassigned) {
    if (filters.assigned && !hasAssignee) return false
    if (filters.unassigned && hasAssignee) return false
  }

  if (filters.agentIds.length) {
    if (!hasAssignee) return false
    if (!filters.agentIds.includes(String(conversation.assigned_user_id))) return false
  }

  // Attention level. When either chip is on, the row must match an ON level.
  // Mirrors the row bar's guard (`attention_required !== false`): a level only
  // counts while attention is still required, so a stale level does not leak in.
  if (filters.attentionTeam || filters.attentionManagement) {
    const level =
      conversation.attention_required !== false ? conversation.attention_level : null
    const matches =
      (filters.attentionTeam && level === 'team') ||
      (filters.attentionManagement && level === 'management')
    if (!matches) return false
  }

  // Contact type / country: OR within a picker, AND with everything else. A
  // conversation with the field unset never matches an active picker.
  if (filters.contactTypes.length && !filters.contactTypes.includes(conversation.contact_type)) {
    return false
  }
  if (filters.countries.length && !filters.countries.includes(conversation.country_of_origin)) {
    return false
  }

  return true
}
