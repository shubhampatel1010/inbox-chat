import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'
import { runSyncStep } from '../../_lib/sync.js'
import { haltAutoRecovery } from '../../_lib/channel-gap.js'
import { envForAccount, accessibleAccountIds } from '../../_lib/accounts.js'

// How long a step may hold the job before another step is allowed to take over.
// Long enough to cover a slow media-heavy step, short enough that a crashed
// step frees the job quickly for a resume.
const LEASE_MS = 120 * 1000

// Cap the errors array so a pathological run can't grow the row unbounded.
const MAX_ERRORS = 50

const TERMINAL = new Set(['done', 'failed', 'canceled'])

/**
 * POST /api/sync/step  (admin)  body: { job_id }
 *
 * Runs ONE bounded unit of work and returns the updated job. The client calls
 * this in a loop until job.status is terminal. A soft lease stops two loops
 * (e.g. two tabs) from double-driving the same job.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { job_id, promote } = await readJson(request)
  const jobId = Number(job_id)
  if (!Number.isInteger(jobId) || jobId <= 0) return badRequest('job_id is required')

  try {
    const db = getDb(env)

    const job = unwrap(
      await db.from('wp_chat_sync_jobs').select('*').eq('id', jobId).maybeSingle()
    )
    if (!job) return notFound('Sync job not found')

    // The job's account gates the whole step. An admin can reach every active
    // account, so this normally passes — it matters when an account has been
    // deactivated, whose jobs must then stop running.
    const allowed = await accessibleAccountIds(env, auth.user)
    if (job.account_id != null && !allowed.includes(Number(job.account_id))) {
      return notFound('Sync job not found')
    }

    if (TERMINAL.has(job.status)) return json({ ok: true, job, done: true })

    const isAuto = job.scope?.type === 'auto'

    // A DEFERRED job (a gap too long to auto-run) only runs when an admin
    // explicitly promotes it from the Sync page. Automatic drivers never pass
    // promote, so they leave it alone.
    if (job.status === 'deferred' && !promote) {
      return json({ ok: true, job, deferred: true })
    }

    const now = Date.now()

    // Never run an auto-recovery while a MANUAL sync is actively running (a
    // manual job holding a fresh lease). Auto waits — it does not compete. A
    // pending/abandoned manual job (no fresh lease) does not block it, so this
    // cannot deadlock.
    if (isAuto) {
      // Scoped to this job's account: account A's manual sync must not block
      // account B's auto-recovery, since they drive independent channels and
      // cannot contend for anything.
      let othersQuery = db
        .from('wp_chat_sync_jobs')
        .select('id, scope, lease_until')
        .in('status', ['pending', 'running'])
        .neq('id', jobId)
      if (job.account_id != null) othersQuery = othersQuery.eq('account_id', job.account_id)

      const others = unwrap(await othersQuery) || []
      const manualRunning = others.some(
        (o) => o?.scope?.type !== 'auto' && o.lease_until && new Date(o.lease_until).getTime() > now
      )
      if (manualRunning) return json({ ok: true, job, busy: true })
    }

    // Lease: if a fresh lease is held, another step is mid-flight — tell the
    // client to back off rather than running the same unit twice.
    if (job.lease_until && new Date(job.lease_until).getTime() > now) {
      return json({ ok: true, job, busy: true })
    }

    // Claim the lease.
    unwrap(
      await db
        .from('wp_chat_sync_jobs')
        .update({
          status: 'running',
          lease_until: new Date(now + LEASE_MS).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    )

    // Run the step against the job's OWN account credentials — this is what
    // makes a sync walk the right channel's history.
    const accountEnv = await envForAccount(env, job.account_id)

    let result
    try {
      result = await runSyncStep(accountEnv, db, job)
    } catch (err) {
      // A thrown step fails the whole job — the cursor is preserved so an admin
      // could inspect and retry, but we do not auto-loop on a hard error.
      const patch = {
        status: 'failed',
        lease_until: null,
        last_error: String(err?.message || err).slice(0, 500),
        updated_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }
      const failed = unwrap(
        await db.from('wp_chat_sync_jobs').update(patch).eq('id', jobId).select('*').single()
      )
      return json({ ok: true, job: failed, done: true })
    }

    // Account-level failure (e.g. Whapi 402): halt the job AND pause automatic
    // recovery so it does not retry the quota failure on every poll. An admin
    // must intervene (starting a manual sync clears the halt).
    if (result.accountError) {
      // Scoped env, so only THIS account's auto-recovery is paused.
      await haltAutoRecovery(accountEnv, result.error)
      const patch = {
        status: 'failed',
        lease_until: null,
        last_error: `Account error — auto-recovery paused until an admin intervenes: ${String(result.error).slice(0, 300)}`,
        cursor: result.cursor || job.cursor,
        updated_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }
      const halted = unwrap(
        await db.from('wp_chat_sync_jobs').update(patch).eq('id', jobId).select('*').single()
      )
      return json({ ok: true, job: halted, done: true, accountError: true })
    }

    // Merge counters and record any soft (per-chat) error without stopping.
    const errors = Array.isArray(job.errors) ? [...job.errors] : []
    if (result.error) {
      errors.push({ chat: result.errorChat || null, error: String(result.error).slice(0, 200) })
    }

    const patch = {
      cursor: result.cursor || job.cursor,
      messages_added: (Number(job.messages_added) || 0) + (result.addAdded || 0),
      media_failed: (Number(job.media_failed) || 0) + (result.addMediaFailed || 0),
      conversations_done: (Number(job.conversations_done) || 0) + (result.addConversationsDone || 0),
      errors: errors.slice(-MAX_ERRORS),
      last_error: result.error ? String(result.error).slice(0, 500) : job.last_error,
      // Release the lease so the next step can proceed immediately.
      lease_until: null,
      status: result.done ? 'done' : 'running',
      updated_at: new Date().toISOString(),
      ...(result.done ? { finished_at: new Date().toISOString() } : {}),
    }

    const updated = unwrap(
      await db.from('wp_chat_sync_jobs').update(patch).eq('id', jobId).select('*').single()
    )

    return json({ ok: true, job: updated, done: Boolean(result.done), backoff: Boolean(result.backoff) })
  } catch (err) {
    return serverError(err.message || 'Sync step failed')
  }
}
