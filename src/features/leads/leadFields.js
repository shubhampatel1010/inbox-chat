// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// Display formatting for lead columns. Kept apart from the component so the
// mapping tables stay readable and are testable on their own.

/**
 * Most of these columns are free text or loosely-constrained strings written by
 * the chatbot, not enums — 'passport_renewal', 'as soon as possible', 'not
 * provided'. Underscores are separators rather than content, so they become
 * spaces; CSS supplies the casing.
 */
export const humanize = (value) => String(value ?? '').replace(/[_-]/g, ' ').trim()

/**
 * preferred_nationality is stored as a 2-letter code ('ID', 'PH'). The codes
 * that actually occur in this domain are spelled out; anything else falls back
 * to the raw value rather than rendering a blank, so an unmapped country is
 * still informative.
 */
const NATIONALITY = {
  ID: 'Indonesia',
  PH: 'Philippines',
  MM: 'Myanmar',
  IN: 'India',
  LK: 'Sri Lanka',
  BD: 'Bangladesh',
  NP: 'Nepal',
  KH: 'Cambodia',
  TH: 'Thailand',
  VN: 'Vietnam',
  SG: 'Singapore',
  MY: 'Malaysia',
}

export const nationality = (code) => {
  const key = String(code ?? '').trim().toUpperCase()
  return NATIONALITY[key] || humanize(code)
}

/**
 * The chatbot writes placeholder strings when a caller declines to answer.
 * 'not provided' is not a budget, and showing it as one would be a small lie —
 * these read as absent instead, which the caller then drops from the UI.
 */
const PLACEHOLDERS = new Set([
  'not provided',
  'not specified',
  'not mentioned',
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
])

/** True when a value carries no information worth a chip. */
export const isBlank = (value) => {
  if (value === null || value === undefined) return true
  const text = String(value).trim()
  if (!text) return true
  return PLACEHOLDERS.has(text.toLowerCase())
}

/**
 * The chips shown under a lead, in priority order: what they want, then who
 * they want, then how urgently, then commercial and routing context.
 *
 * Empty and placeholder values are dropped rather than rendered as a dash —
 * most leads populate only four or five of these, and a column of dashes would
 * bury the fields that do carry an answer.
 *
 * `tone` selects the chip's colour role; see leads-feature.css.
 */
export function leadChips(lead) {
  const candidates = [
    { key: 'interest', label: 'Interest', value: lead.interest_type, tone: 'primary', format: humanize },
    { key: 'requirement', label: 'Requirement', value: lead.requirement, tone: 'primary', format: humanize },
    { key: 'nationality', label: 'Preferred', value: lead.preferred_nationality, tone: 'neutral', format: nationality },
    { key: 'urgency', label: 'Urgency', value: lead.urgency, tone: 'urgent', format: humanize },
    { key: 'budget', label: 'Budget', value: lead.budget, tone: 'neutral', format: humanize },
    { key: 'temperature', label: 'Temperature', value: lead.temperature, tone: 'temp', format: humanize },
    { key: 'source', label: 'Source', value: lead.source, tone: 'neutral', format: humanize },
  ]

  const chips = candidates
    .filter((chip) => !isBlank(chip.value))
    .map((chip) => ({ ...chip, text: chip.format(chip.value) }))

  // interest_type and requirement often agree ('replacement' / 'replacement'),
  // which would print the same word twice under two labels and read as a bug.
  // Identical text collapses to the first chip; genuinely different values
  // ('passport_renewal' vs 'childcare') both survive, which is the case the two
  // columns exist for.
  const seen = new Set()
  return chips.filter((chip) => {
    const key = chip.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A lead timestamp as the agent reads it: '23 Sep, 11:41 AM' in their own
 * timezone, with the year added only when it is not the current one. Returns
 * null for a missing or unparseable value so the caller can drop the row.
 */
export function formatLeadTime(value) {
  if (isBlank(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return date.toLocaleString(undefined, opts)
}

/** Full, unambiguous form for the hover title. */
export const fullLeadTime = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/**
 * The OS's contact outcomes — what a salesperson logs after reaching out. Not
 * statuses: the server logs each as an activity and moves a 'new' lead on to
 * 'contacted' / 'follow_up_required'. Mirrors CONTACT_OUTCOMES in
 * functions/api/leads/outcome.js — keep the two in step.
 */
export const CONTACT_OUTCOMES = [
  'Contacted',
  'Call not picked',
  'No answer',
  'Wrong number',
  'Requested callback',
]

/** The OS's own wording for leads.status (os-minghwee leadLabels.ts). */
const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  follow_up_required: 'Follow-up required',
  qualified: 'Qualified',
  converted: 'Converted',
  lost: 'Lost',
}

export const statusLabel = (status) => STATUS_LABELS[status] || humanize(status)

/** Minutes → '2h 0m', or '48m' under an hour (os-minghwee fmtHM). */
export function fmtHM(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`
}

// SLA rule as the OS states it: first contact within 2h of receipt, and an
// uncontacted lead is rotated to another salesperson 3h after assignment.
const SLA_HOURS = 2
const REASSIGN_HOURS = 3

// ---------------------------------------------------------------------------
// Working hours (OS migration 0093) — mirror of os-minghwee leadLabels.ts /
// apps/api/app/core/working_hours.py. Both clocks count only time inside the
// tenant's daily window, in Asia/Singapore (fixed UTC+8, no DST — the same
// constant the OS uses). No window => wall clock, the pre-0093 behaviour.
// ---------------------------------------------------------------------------

const SGT_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

function hhmmToMin(value) {
  const m = value ? /^(\d{2}):(\d{2})/.exec(String(value)) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** { start, end } in minutes after local midnight, or null = 24-hour clock. */
export function workingHoursFrom(start, end) {
  const s = hhmmToMin(start)
  const e = hhmmToMin(end)
  return s === null || e === null || s === e ? null : { start: s, end: e }
}

/** [opens, closes) in epoch ms for the window that opens on SGT day `day`. */
function windowOn(day, wh) {
  const base = day * DAY_MS - SGT_OFFSET_MS
  const opens = base + wh.start * 60_000
  const closes = (wh.start < wh.end ? base : base + DAY_MS) + wh.end * 60_000
  return [opens, closes]
}

const sgtDay = (ms) => Math.floor((ms + SGT_OFFSET_MS) / DAY_MS)

/** Working milliseconds from `a` to `b` (wall clock with no window). */
function workingMsBetween(a, b, wh) {
  if (!wh) return b - a
  if (b < a) return -workingMsBetween(b, a, wh)
  let total = 0
  const last = sgtDay(b)
  for (let day = sgtDay(a) - 1; day <= last; day += 1) {
    const [opens, closes] = windowOn(day, wh)
    const lo = Math.max(opens, a)
    const hi = Math.min(closes, b)
    if (hi > lo) total += hi - lo
  }
  return total
}

function isOpenAt(ms, wh) {
  if (!wh) return true
  const day = sgtDay(ms)
  return [day - 1, day].some((d) => {
    const [opens, closes] = windowOn(d, wh)
    return opens <= ms && ms < closes
  })
}

/**
 * The OS's Contact SLA pill (os-minghwee leadLabels.ts leadSlaPill), ported
 * for display only — the server alone decides overdue and reassignment; the
 * client clock only keeps the countdown text live between refetches. Returns
 * { tone, icon, label }; `tone` picks the colour in leads-feature.css.
 */
export function leadSlaPill(lead, nowMs) {
  const status = lead.status || 'new'
  if (status === 'converted') return { tone: 'done', icon: 'verified', label: 'Complete · converted' }
  if (status === 'lost') return { tone: 'closed', icon: 'closed', label: 'Closed' }
  if (status === 'follow_up_required') return { tone: 'callback', icon: 'callback', label: 'Callback set' }
  if (status !== 'new') return { tone: 'done', icon: 'verified', label: 'Complete · contact made' }

  const wh = workingHoursFrom(lead.work_hours_start, lead.work_hours_end)
  const receivedMs = new Date(lead.received_at).getTime()
  const elapsedMin = Number.isNaN(receivedMs) ? 0 : workingMsBetween(receivedMs, nowMs, wh) / 60_000
  const left = SLA_HOURS * 60 - elapsedMin
  // Outside working hours the countdown is frozen — say so, rather than leave
  // the agent wondering why the number is not moving.
  const paused = !isOpenAt(nowMs, wh)

  if (left > 0) {
    return paused
      ? { tone: 'paused', icon: 'paused', label: `Paused · ${fmtHM(left)} to contact` }
      : { tone: 'ontrack', icon: 'ontrack', label: `On track · ${fmtHM(left)} to contact` }
  }

  // Past the SLA: while the current owner still holds it, warn when it leaves them.
  if (!isBlank(lead.assigned_at)) {
    const assignedMs = new Date(lead.assigned_at).getTime()
    if (!Number.isNaN(assignedMs)) {
      const toReassign = REASSIGN_HOURS * 60 - workingMsBetween(assignedMs, nowMs, wh) / 60_000
      if (toReassign > 0) {
        return paused
          ? { tone: 'overdue', icon: 'paused', label: `Overdue · paused · reassigns in ${fmtHM(toReassign)}` }
          : { tone: 'overdue', icon: 'timer', label: `Overdue · reassigns in ${fmtHM(toReassign)}` }
      }
    }
  }

  return { tone: 'overdue', icon: 'warning', label: `Overdue · ${fmtHM(-left)} overdue` }
}

/** 'Working hours 09:00–18:00 SGT', or '' when the tenant has none set. */
export function workingHoursLabel(lead) {
  if (!workingHoursFrom(lead.work_hours_start, lead.work_hours_end)) return ''
  return `Working hours ${lead.work_hours_start}–${lead.work_hours_end} SGT`
}
