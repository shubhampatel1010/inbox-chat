// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.

import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError } from '../../_lib/respond.js'
import { findProfileIdByEmail, leadsTenantId } from './mine.js'

/**
 * The OS's contact outcomes (os-minghwee apps/web/src/features/fcc/leadLabels.ts
 * CONTACT_OUTCOMES). These are NOT statuses — leads.status only accepts the
 * OS's pipeline values (new, contacted, qualified, follow_up_required,
 * converted, lost). An outcome is logged as an activity and, for a lead still
 * at 'new', folds into a status move. Mirrors CONTACT_OUTCOMES in
 * src/features/leads/leadFields.js — keep the two in step.
 */
export const CONTACT_OUTCOMES = [
  'Contacted',
  'Call not picked',
  'No answer',
  'Wrong number',
  'Requested callback',
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/leads/outcome   { id, outcome }
 *
 * Does what the OS lead drawer's "Log what happened…" does
 * (LeadDetailsTab.tsx applyOutcome → leads_service.create_activity + set_status):
 *
 *   1. log a `Contact outcome — <outcome>` activity (icon 'call')
 *   2. if the lead is still 'new', move it to 'follow_up_required' for
 *      "Requested callback" and to 'contacted' for everything else — setting
 *      first_contacted_at, which stops the OS's first-contact SLA clock — and
 *      log the OS's own `Status changed to '<status>'` activity (icon 'event')
 *
 * The OS API cannot be called from here (it authenticates its own sessions),
 * so the same rows are written directly. audit_log entries are best-effort,
 * exactly as the OS's record_audit treats them.
 *
 * Access follows the bell: only leads in the LEADS_TENANT_ID tenant; within
 * it, admin → any lead, agent → only leads they own.
 * A lead the caller may not touch answers 404, not 403.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { user } = auth

  let payload
  try {
    payload = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const id = String(payload?.id || '')
  if (!UUID_RE.test(id)) return badRequest('id is required')

  const outcome = String(payload?.outcome || '')
  if (!CONTACT_OUTCOMES.includes(outcome)) return badRequest('Unknown outcome')

  try {
    const tenantId = leadsTenantId(env)
    if (!tenantId) return notFound('Lead not found')

    const db = getDb(env)
    const isAdmin = user.role === 'admin'

    // Admins are looked up too — not for access, but so the activity names
    // the profile that logged it, the way the OS does.
    const profileId = await findProfileIdByEmail(db, user.email, tenantId)
    if (!isAdmin && !profileId) return notFound('Lead not found')

    let leadQuery = db
      .from('leads')
      .select('id, tenant_id, status, first_contacted_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .is('archived_at', null)
    if (!isAdmin) leadQuery = leadQuery.eq('owner_profile_id', profileId)

    const lead = unwrap(await leadQuery.maybeSingle())
    if (!lead) return notFound('Lead not found')

    const now = new Date().toISOString()
    // The OS resolves the actor's name from actor_profile_id; the label is
    // only needed when the caller has no profile to point at.
    const actor = {
      actor_profile_id: profileId,
      actor_label: profileId ? null : user.name || user.email,
    }

    const activity = unwrap(
      await db
        .from('lead_activities')
        .insert({
          tenant_id: lead.tenant_id,
          lead_id: lead.id,
          icon: 'call',
          title: `Contact outcome — ${outcome}`,
          occurred_at: now,
          ...actor,
        })
        .select('id')
        .single()
    )
    await audit(db, {
      tenant_id: lead.tenant_id,
      actor_profile_id: profileId,
      action: 'lead_activity.create',
      entity_type: 'lead_activity',
      entity_id: activity.id,
      before: null,
      after: { lead_id: lead.id, title: `Contact outcome — ${outcome}`, icon: 'call' },
    })

    let status = lead.status

    if (lead.status === 'new') {
      const nextStatus = outcome === 'Requested callback' ? 'follow_up_required' : 'contacted'
      const fields = { status: nextStatus, updated_at: now }
      if (!lead.first_contacted_at) fields.first_contacted_at = now

      // Conditional on status still being 'new': if the OS moved the lead in
      // the meantime, its move stands and this one quietly does not happen.
      let updateQuery = db
        .from('leads')
        .update(fields)
        .eq('id', lead.id)
        .eq('tenant_id', tenantId)
        .eq('status', 'new')
      if (!isAdmin) updateQuery = updateQuery.eq('owner_profile_id', profileId)
      const updated = unwrap(await updateQuery.select('id, status, first_contacted_at'))

      if (updated?.length) {
        status = nextStatus
        unwrap(
          await db.from('lead_activities').insert({
            tenant_id: lead.tenant_id,
            lead_id: lead.id,
            icon: 'event',
            title: `Status changed to '${nextStatus}'`,
            occurred_at: now,
            ...actor,
          })
        )
        await audit(db, {
          tenant_id: lead.tenant_id,
          actor_profile_id: profileId,
          action: 'lead.status',
          entity_type: 'lead',
          entity_id: lead.id,
          before: { status: 'new', first_contacted_at: lead.first_contacted_at },
          after: { status: nextStatus, first_contacted_at: updated[0].first_contacted_at },
        })
      }
    }

    return json({ ok: true, lead: { id: lead.id, status } })
  } catch (err) {
    return serverError(err.message || 'Failed to log outcome')
  }
}

/** One audit_log row. Never throws — the OS treats this write as best-effort too. */
async function audit(db, row) {
  try {
    const { error } = await db.from('audit_log').insert(row)
    if (error) console.warn('audit_log write skipped:', error.message)
  } catch (err) {
    console.warn('audit_log write skipped:', err?.message)
  }
}
