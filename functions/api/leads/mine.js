// ─────────────────────────────────────────────────────────────────────────────
// SELF-CONTAINED FEATURE: "New lead has arrived" banner.
//
// This whole feature is deliberately isolated so it can be deleted in one go.
// To remove it entirely, delete exactly these four things:
//   1. functions/api/leads/                 (this file + outcome.js)
//   2. src/features/leads/                  (the client feature folder)
//   3. the <NewLeadBanner /> line + its import in src/pages/Inbox.jsx
//   4. the leads-feature.css import in src/main.jsx
// Nothing else in the codebase references it, and no migration was applied.
// (Optionally also drop the LEADS_TENANT_ID env var it reads.)
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, serverError } from '../../_lib/respond.js'

/**
 * The columns the panel renders — the enquiry detail, not the pipeline
 * bookkeeping. Deliberately still a list rather than `*`: the conversion,
 * follow-up and routing columns (converted_case_id, follow_up_note,
 * lost_reason, tenant_id, branch_id …) have no place on the wire.
 *
 * Both `requirement` and `interest_type` are sent. They are NOT duplicates —
 * interest_type is the classified category ('passport_renewal') and is set on
 * every row, while requirement is a looser free-text note ('childcare') that is
 * frequently null. Showing only one would lose information on most leads.
 */
const LEAD_COLUMNS = [
  'id',
  'lead_number',
  'full_name',
  'phone',
  'email',
  'source',
  'interest_type',
  'requirement',
  'preferred_nationality',
  'urgency',
  'budget',
  'temperature',
  'summary',
  'status',
  'owner_profile_id',
  // When the enquiry itself came in — shown in the panel as "Received".
  'received_at',
  'created_at',
  'assigned_at',
  // The assigned salesperson, embedded over the owner_profile_id FK so the
  // panel can name them without a second round trip.
  'owner:profiles!owner_profile_id(display_name, email)',
].join(', ')

/** Newest first, and never flood the header with an unbounded list. */
const MAX_LEADS = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The one OS tenant whose leads this inbox shows — the LEADS_TENANT_ID env var.
 * The leads tables are shared by every tenant in the OS, so without it an admin
 * would see (and could act on) other tenants' leads.
 *
 * Fails closed: unset or malformed → null, and callers treat that as "no
 * leads", never as "every tenant".
 */
export function leadsTenantId(env) {
  const value = String(env?.LEADS_TENANT_ID || '').trim()
  return UUID_RE.test(value) ? value : null
}

/**
 * GET /api/leads/mine
 *
 * Identity bridge: the inbox authenticates against `wp_chat_users`, while
 * `leads.owner_profile_id` points into `profiles` — two separate tables with no
 * foreign key between them. EMAIL is the only thing they share, so the caller's
 * wp_chat_users.email is matched (case-insensitively) against profiles.email to
 * find the profile id that leads are actually owned by.
 *
 * The caller's most recent leads, whatever their status — the client shows
 * 'new' ones as unread and keeps worked ones in the list as read.
 *
 * Visibility (always within the LEADS_TENANT_ID tenant):
 *   admin → every lead
 *   agent → only leads whose owner_profile_id is their matched profile id
 *
 * An agent with no matching profile row sees nothing. That is the correct
 * answer, not an error: no profile means no lead can name them as owner.
 * Unowned leads (owner_profile_id IS NULL) likewise stay admin-only rather than
 * being shown to everyone, since "unowned" is not a claim about who handles it.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { user } = auth

  try {
    const tenantId = leadsTenantId(env)
    if (!tenantId) return json({ ok: true, leads: [], profile_id: null })

    const db = getDb(env)
    const isAdmin = user.role === 'admin'

    let profileId = null

    if (!isAdmin) {
      profileId = await findProfileIdByEmail(db, user.email, tenantId)
      // No profile → no lead can be owned by this user. Answer an empty list
      // rather than falling through to an unfiltered query, which would leak
      // every lead to an agent whose email simply has not been mirrored yet.
      if (!profileId) return json({ ok: true, leads: [], profile_id: null })
    }

    // Every status, not just 'new': a lead stays in the list after it is
    // worked, and the client decides read/unread from its status.
    let query = db
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('tenant_id', tenantId)
      // Archived leads are done with, whoever owns them.
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_LEADS)

    if (!isAdmin) query = query.eq('owner_profile_id', profileId)

    const rows = unwrap(await query) || []

    // The tenant's working hours ride along on every lead, the same shape the
    // OS API returns, so the SLA pill can pause outside the window.
    const hours = await findWorkingHours(db, tenantId)
    const leads = rows.map((lead) => ({ ...lead, ...hours }))

    return json({ ok: true, leads, profile_id: profileId })
  } catch (err) {
    return serverError(err.message || 'Failed to load leads')
  }
}

/**
 * The tenant's daily working window from tenant_settings (OS migration 0093),
 * as 'HH:MM' strings. Read-only. Both null = no window = 24-hour clock, which
 * is also the answer on any read failure: a missing window only makes the
 * pill count wall-clock time, so it must never fail the lead list.
 */
async function findWorkingHours(db, tenantId) {
  const none = { work_hours_start: null, work_hours_end: null }
  try {
    const { data, error } = await db
      .from('tenant_settings')
      .select('work_hours_start, work_hours_end')
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error || !data) return none
    const hhmm = (value) => (value ? String(value).slice(0, 5) : null)
    return { work_hours_start: hhmm(data.work_hours_start), work_hours_end: hhmm(data.work_hours_end) }
  } catch {
    return none
  }
}

/**
 * profiles.id for this email within the tenant, or null. Profiles are
 * per-tenant, so the same address in another tenant must not match.
 *
 * Mirrors the escaping/re-check discipline of findUserByEmail in _lib/db.js:
 * PostgREST cannot express `lower(col) = lower($1)`, and `ilike` would treat a
 * `%` or `_` inside an address as a wildcard — so the pattern is escaped, and
 * the JS equality check below is the authoritative comparison. Any row that
 * slipped through the pattern cannot produce a false match here.
 */
export async function findProfileIdByEmail(db, email, tenantId) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null

  const pattern = normalized.replace(/([\\%_])/g, '\\$1')

  const rows = unwrap(
    await db
      .from('profiles')
      .select('id, email')
      .eq('tenant_id', tenantId)
      .ilike('email', pattern)
      .limit(10)
  )

  const match = rows?.find((row) => String(row.email || '').toLowerCase() === normalized)
  return match?.id ?? null
}
