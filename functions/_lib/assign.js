import { unwrap } from './db.js'

// Round-robin auto-assignment. Two independent rotations (sales, operations),
// each a persistent per-department cursor advanced atomically in the DB
// (wp_chat_next_rotation), so concurrent creations never grab the same agent
// and the rotation survives restarts.

export const ASSIGNABLE_DEPARTMENTS = ['sales', 'operations']

// --------------------------------------------------------------------
// Pure helpers (no I/O) — unit-tested without a database.
// --------------------------------------------------------------------

/**
 * Pick the agent for a rotation cursor. Agents are the CURRENT active roster in
 * a department (deterministic order), so `cursor % length` cycles A-B-A-B and
 * adapts automatically when the roster changes. Empty roster -> null (the
 * conversation stays unassigned).
 */
export function pickByRotation(agents, cursor) {
  if (!agents || !agents.length) return null
  const n = Number(cursor)
  const len = agents.length
  // Safe for any integer cursor, even a hypothetical negative.
  return agents[((n % len) + len) % len]
}

// --------------------------------------------------------------------
// DB-backed assignment.
// --------------------------------------------------------------------

/**
 * Active agents in a department who are ALSO assigned to this account —
 * deterministic order for a stable cycle.
 *
 * The account filter is what stops a chat on account A being routed to an agent
 * who only works account B (and would then get a 404 opening it). When
 * `accountId` is null the account filter is skipped, preserving the original
 * single-account behaviour exactly.
 */
export async function activeAgentsIn(db, department, accountId = null) {
  const agents =
    unwrap(
      await db
        .from('wp_chat_users')
        .select('id, name')
        .eq('role', 'agent')
        .eq('is_active', true)
        .eq('department', department)
        .order('id', { ascending: true })
    ) || []

  if (accountId == null || !agents.length) return agents

  const members =
    unwrap(
      await db
        .from('wp_chat_user_accounts')
        .select('user_id')
        .eq('account_id', accountId)
        .in('user_id', agents.map((a) => a.id))
    ) || []

  const allowed = new Set(members.map((m) => String(m.user_id)))
  return agents.filter((a) => allowed.has(String(a.id)))
}

/**
 * Atomic per-(account, department) cursor. Distinct value per call -> distinct
 * agents, so two chats created in the same instant can never grab one agent.
 *
 * Per account, not just per department: two accounts sharing one sales cursor
 * would interleave their rotations, so neither account's team would actually go
 * round-robin. Falls back to 009's single-argument function when there is no
 * account, which also covers a deploy that has not run migration 018 yet.
 */
async function nextRotation(db, department, accountId = null) {
  if (accountId == null) {
    const { data, error } = await db.rpc('wp_chat_next_rotation', { p_department: department })
    if (error) throw new Error(error.message)
    return Number(data)
  }

  const { data, error } = await db.rpc('wp_chat_next_rotation_account', {
    p_account_id: accountId,
    p_department: department,
  })
  if (error) throw new Error(error.message)
  return Number(data)
}

/**
 * Round-robin assign one conversation to an active agent in `department`, but
 * ONLY if it is still unassigned. Returns { assigned, agent } | { assigned:false,
 * reason }. Never assigns to a deactivated/removed agent (the roster query
 * filters is_active), and never double-assigns (the conditional claim below).
 *
 * The rotation is advanced only when there is at least one active agent, so an
 * empty department neither errors nor burns a slot.
 */
export async function autoAssign(db, conversationId, department, accountId = null) {
  if (!ASSIGNABLE_DEPARTMENTS.includes(department)) return { assigned: false, reason: 'no_department' }

  const agents = await activeAgentsIn(db, department, accountId)
  if (!agents.length) return { assigned: false, reason: 'no_active_agents' }

  const cursor = await nextRotation(db, department, accountId)
  const agent = pickByRotation(agents, cursor)

  // Conditional claim: only assign if STILL unassigned. This is the idempotency
  // + concurrency guard — a manual assignment or a racing auto-assign that got
  // there first leaves this a no-op rather than clobbering it.
  const claimed =
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          assigned_user_id: agent.id,
          assigned_to: agent.name,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId)
        .is('assigned_user_id', null)
        .select('id')
    ) || []

  if (!claimed.length) return { assigned: false, reason: 'already_assigned', agent }
  return { assigned: true, agent }
}
