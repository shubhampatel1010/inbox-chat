// ====================================================================
// Daily EOD digest to Thomas — a STANDALONE Cloudflare Worker (cron).
//
// Reads Supabase over HTTP (PostgREST, service role — no Postgres driver, no
// SDK) and sends one email via Resend. It never generates summaries and never
// touches the Pages app. Its ONLY write is one row per day into
// wp_chat_eod_snapshots (recorded AFTER the email is sent) so the next day's
// digest can show what got resolved.
// ====================================================================

const RESEND_URL = 'https://api.resend.com/emails'
const DAY_MS = 24 * 60 * 60 * 1000

const LEVEL_RANK = { management: 0, team: 1, general: 2 }
const LEVEL_LABEL = { management: 'Management', team: 'Team', general: 'General' }
const LEVEL_COLOR = { management: '#c0392b', team: '#b6791f', general: '#2f6fb0' }

// --------------------------------------------------------------------
// Config
// --------------------------------------------------------------------
function readConfig(env) {
  const supabaseUrl = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const resendKey = env.RESEND_API_KEY
  const from = env.EOD_FROM
  const to = env.EOD_TO
  const missing = [
    ['SUPABASE_URL', supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['RESEND_API_KEY', resendKey],
    ['EOD_FROM', from],
    ['EOD_TO', to],
  ].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`EOD config missing: ${missing.join(', ')}`)

  // EOD_PENDING_DAYS: default 7, clamped to the valid 3–10 range.
  let days = Number(env.EOD_PENDING_DAYS)
  if (!Number.isFinite(days)) days = 7
  days = Math.min(10, Math.max(3, Math.round(days)))

  return { supabaseUrl: String(supabaseUrl).replace(/\/+$/, ''), serviceKey, resendKey, from, to, pendingDays: days }
}

// --------------------------------------------------------------------
// Supabase over HTTP (PostgREST)
// --------------------------------------------------------------------
async function pg(cfg, pathAndQuery) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`Supabase ${res.status}: ${body}`)
  }
  return res.json()
}

/**
 * POST rows to PostgREST. With { upsert: true } it merges on the table's
 * conflict target — pass `?on_conflict=<col>` in pathAndQuery. The ONLY write
 * this worker makes (the daily snapshot); reads still go through pg().
 */
async function pgWrite(cfg, pathAndQuery, rows, { upsert = false } = {}) {
  const prefer = ['return=minimal']
  if (upsert) prefer.push('resolution=merge-duplicates')
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: prefer.join(','),
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`Supabase write ${res.status}: ${body}`)
  }
  return true
}

async function fetchEodData(cfg, now) {
  const cutoffIso = new Date(now - cfg.pendingDays * DAY_MS).toISOString()

  // Membership: (a) flagged summaries; (b) inbound + stale conversations.
  const [flaggedRows, pendingRows] = await Promise.all([
    pg(cfg, `wp_chat_summaries?attention_required=eq.true&select=conversation_id`),
    pg(cfg, `wp_chat_conversations?last_direction=eq.inbound&last_message_at=lte.${encodeURIComponent(cutoffIso)}&select=id`),
  ])

  const flaggedIds = new Set(flaggedRows.map((r) => r.conversation_id))
  const pendingIds = new Set(pendingRows.map((r) => r.id))
  const ids = [...new Set([...flaggedIds, ...pendingIds])]
  if (!ids.length) return { conversations: [], summaries: [], flaggedIds, pendingIds }

  const inList = `in.(${ids.join(',')})`
  const [conversations, summaries] = await Promise.all([
    pg(cfg, `wp_chat_conversations?id=${inList}&select=id,customer_name,customer_number,is_group,member_count,last_message_at,last_direction,assigned_to`),
    pg(cfg, `wp_chat_summaries?conversation_id=${inList}&select=conversation_id,attention_required,attention_level,attention_reason,big_summary,short_summary,summary_text`),
  ])
  return { conversations, summaries, flaggedIds, pendingIds }
}

/**
 * Display names for a set of conversation ids (used for RESOLVED items, whose
 * conversations are — by definition — not in today's attention set and so were
 * not fetched above). Returns Map<id, name>.
 */
async function fetchNames(cfg, ids) {
  if (!ids.length) return new Map()
  const rows = await pg(
    cfg,
    `wp_chat_conversations?id=in.(${ids.join(',')})&select=id,customer_name,customer_number,is_group`
  )
  return new Map(rows.map((r) => [r.id, displayName(r)]))
}

// --------------------------------------------------------------------
// Assembly (pure — unit-testable without network)
// --------------------------------------------------------------------
export function daysSince(iso, now) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}

/**
 * The digest's calendar day and the day before it, in Asia/Singapore (UTC+8, no
 * DST) — the keys for today's snapshot write and yesterday's snapshot read.
 */
export function eodDates(now) {
  const pad = (n) => String(n).padStart(2, '0')
  const sgt = new Date(now + 8 * 60 * 60 * 1000) // shift the wall clock to SGT
  const y = sgt.getUTCFullYear()
  const m = sgt.getUTCMonth()
  const d = sgt.getUTCDate()
  const yd = new Date(Date.UTC(y, m, d) - DAY_MS)
  const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  return { today: `${y}-${pad(m + 1)}-${pad(d)}`, yesterday: fmt(yd) }
}

/**
 * The EOD reads EXISTING summaries — no model calls. big_summary is the point of
 * the EOD; fall back to short_summary, then the legacy summary_text, so a
 * conversation summarized before the big-summary rollout still appears.
 */
export function pickSummary(s) {
  const big = (s?.big_summary || '').trim()
  const short = (s?.short_summary || '').trim()
  const legacy = (s?.summary_text || '').trim()
  return big || short || legacy || '(No summary available yet.)'
}

function displayName(c) {
  if (c.is_group) return c.customer_name || 'Group'
  return c.customer_name || (c.customer_number ? `+${c.customer_number}` : 'Unknown contact')
}

export function buildDigest({ conversations, summaries, flaggedIds, pendingIds, now, pendingDays }) {
  const sumBy = new Map(summaries.map((s) => [s.conversation_id, s]))

  const items = conversations.map((c) => {
    const s = sumBy.get(c.id) || {}
    const flagged = flaggedIds.has(c.id) || s.attention_required === true
    const pending = pendingIds.has(c.id)
    return {
      id: c.id,
      name: displayName(c),
      isGroup: !!c.is_group,
      assignedTo: c.assigned_to || null,
      flagged,
      pending,
      waitingDays: pending ? daysSince(c.last_message_at, now) : null,
      level: flagged ? (LEVEL_LABEL[s.attention_level] ? s.attention_level : 'general') : null,
      reason: flagged ? (s.attention_reason || null) : null,
      summary: pickSummary(s),
      lastMessageAt: c.last_message_at,
    }
  })

  const olderFirst = (a, b) => new Date(a.lastMessageAt).getTime() - new Date(b.lastMessageAt).getTime()

  // Attention first: management -> team -> general, oldest activity first within a level.
  const flagged = items
    .filter((i) => i.flagged)
    .sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || olderFirst(a, b))

  // Then pending that isn't already shown as flagged, oldest waiting first.
  const pending = items.filter((i) => i.pending && !i.flagged).sort(olderFirst)

  return {
    flagged,
    pending,
    counts: { flagged: flagged.length, pending: items.filter((i) => i.pending).length },
    pendingDays,
  }
}

// --------------------------------------------------------------------
// Email HTML (Gmail-safe: inline styles, ~600px, no <style>/<script>)
// --------------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  )
}

// Subheadings the AI emits inside a big_summary, rendered bold on their own line.
const SUMMARY_HEADINGS = ['Key facts:', 'Current status:', 'Recent activity:', 'Action needed:']

/**
 * Render a stored summary string as email-safe HTML. big_summary now arrives as
 * bullet points ("• " lines) grouped under the headings above, with "\n" breaks:
 *   • "• " lines become real <li> inside a <ul>
 *   • heading lines become bold subheadings
 *   • any other line becomes its own block (so "\n" reads as a line break)
 * A plain-paragraph fallback (short_summary / legacy summary_text) still renders
 * fine — it just becomes one or more plain blocks.
 */
export function renderSummaryHtml(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let bullets = []
  const flush = () => {
    if (!bullets.length) return
    out.push(`<ul style="margin:4px 0 8px;padding-left:20px;">${bullets.join('')}</ul>`)
    bullets = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    if (/^•\s*/.test(line)) {
      bullets.push(`<li style="margin:2px 0;">${escapeHtml(line.replace(/^•\s*/, ''))}</li>`)
      continue
    }
    flush()
    if (SUMMARY_HEADINGS.some((h) => line.startsWith(h))) {
      out.push(`<div style="font-weight:700;color:#111;margin:8px 0 2px;">${escapeHtml(line)}</div>`)
    } else {
      out.push(`<div style="margin:2px 0;">${escapeHtml(line)}</div>`)
    }
  }
  flush()
  return out.join('')
}

/** "✅ Resolved Today" — items flagged/pending yesterday but gone from today's digest. */
function renderResolvedSection(resolved) {
  if (!resolved || !resolved.length) return ''
  const lis = resolved
    .map((r) => {
      const tail = r.wasFlagged ? 'was flagged for attention — now resolved.' : 'was pending — now responded.'
      return `<li style="margin:3px 0;"><strong>${escapeHtml(r.name)}</strong> — ${tail}</li>`
    })
    .join('')
  return `
  <div style="font-size:13px;font-weight:700;color:#0a7d33;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px;">✅ Resolved Today (${resolved.length})</div>
  <div style="border:1px solid #d3ead9;border-radius:8px;padding:12px 16px;margin:0 0 12px;background:#f3faf5;">
    <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.5;color:#2a2a2a;">${lis}</ul>
  </div>`
}

function card(item) {
  const meta = []
  if (item.pending && item.waitingDays != null) meta.push(`Waiting ${item.waitingDays} day${item.waitingDays === 1 ? '' : 's'}`)
  meta.push(item.assignedTo ? `Assigned: ${escapeHtml(item.assignedTo)}` : 'Unassigned')
  if (item.isGroup) meta.push('Group')

  const badge = item.level
    ? `<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${LEVEL_COLOR[item.level]};border-radius:10px;padding:2px 9px;margin-left:8px;vertical-align:middle;">${LEVEL_LABEL[item.level]}</span>`
    : ''
  const newBadge = item.isNew
    ? `<span style="display:inline-block;font-size:11px;font-weight:700;color:#0a7d33;background:#e6f5ea;border-radius:10px;padding:2px 9px;margin-left:8px;vertical-align:middle;">🆕 New</span>`
    : ''
  const reason = item.reason
    ? `<div style="font-size:13px;color:${LEVEL_COLOR[item.level]};margin:6px 0 0;"><strong>Attention:</strong> ${escapeHtml(item.reason)}</div>`
    : ''

  return `
  <div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">
    <div style="font-size:15px;font-weight:700;color:#111;">${escapeHtml(item.name)}${newBadge}${badge}</div>
    <div style="font-size:12px;color:#888;margin:3px 0 0;">${meta.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>
    ${reason}
    <div style="font-size:13px;line-height:1.5;color:#333;margin:8px 0 0;">${renderSummaryHtml(item.summary)}</div>
  </div>`
}

function section(title, count, items) {
  if (!items.length) return ''
  return `
  <div style="font-size:13px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px;">${escapeHtml(title)} (${count})</div>
  ${items.map(card).join('')}`
}

export function renderEmail(digest, cfg, now, extra = {}) {
  const resolved = extra.resolved || []
  const newIds = extra.newIds || new Set()

  const date = new Date(now).toLocaleDateString('en-SG', {
    timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  const nothing = !digest.flagged.length && !digest.pending.length

  // Annotate today's flagged items that were not present yesterday.
  const flaggedItems = digest.flagged.map((i) => ({ ...i, isNew: newIds.has(i.id) }))

  const countsLine = nothing
    ? 'Nothing needs attention today.'
    : `${digest.counts.flagged} flagged · ${digest.counts.pending} pending ${digest.pendingDays}+ days`
  const subject = nothing
    ? `EOD digest — ${date} — all clear${resolved.length ? `, ${resolved.length} resolved` : ''}`
    : `EOD digest — ${date} — ${digest.counts.flagged} flagged, ${digest.counts.pending} pending`

  const resolvedHtml = renderResolvedSection(resolved)
  const body = nothing
    ? `${resolvedHtml}<div style="font-size:14px;color:#333;padding:8px 0;">No conversations are flagged for attention, and nothing has been waiting ${digest.pendingDays}+ days. 👍</div>`
    : `${resolvedHtml}${section('Needs attention', flaggedItems.length, flaggedItems)}
       ${section(`Waiting ${digest.pendingDays}+ days`, digest.pending.length, digest.pending)}`

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="font-size:20px;font-weight:800;color:#111;">EOD digest</div>
    <div style="font-size:13px;color:#666;margin:2px 0 0;">${escapeHtml(date)}&nbsp;&nbsp;·&nbsp;&nbsp;${escapeHtml(countsLine)}</div>
    ${body}
    <div style="font-size:11px;color:#aaa;margin:26px 0 0;border-top:1px solid #e5e5e5;padding:12px 0 0;">
      Automated end-of-day summary · reads existing AI summaries, no new analysis.
    </div>
  </div></body></html>`

  const resolvedText = resolved.length
    ? `✅ Resolved Today (${resolved.length})\n` +
      resolved.map((r) => `• ${r.name} — ${r.wasFlagged ? 'was flagged, now resolved.' : 'was pending, now responded.'}`).join('\n') +
      '\n\n'
    : ''
  const text = nothing
    ? `EOD digest — ${date}\n${resolvedText}Nothing needs attention today.`
    : `EOD digest — ${date}\n${countsLine}\n\n${resolvedText}` +
      [...flaggedItems, ...digest.pending]
        .map((i) => `• ${i.isNew ? '[NEW] ' : ''}${i.name}${i.level ? ` [${LEVEL_LABEL[i.level]}]` : ''}${i.waitingDays != null ? ` (waiting ${i.waitingDays}d)` : ''} — ${i.assignedTo || 'Unassigned'}\n  ${i.summary}`)
        .join('\n\n')

  return { subject, html, text }
}

// --------------------------------------------------------------------
// Resend + retry
// --------------------------------------------------------------------
async function sendResend(cfg, { subject, html, text }) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject, html, text }),
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`Resend ${res.status}: ${body}`)
  }
  return res.json().catch(() => ({}))
}

async function withRetry(fn, label, tries = 2, delayMs = 2000) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.error(`EOD: ${label} attempt ${i}/${tries} failed: ${err?.message || err}`)
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

/** Best-effort alert so a broken EOD is visible in the inbox, not just the logs. */
async function sendAlert(cfg, message) {
  try {
    await sendResend(cfg, {
      subject: 'EOD digest FAILED to run',
      html: `<div style="font-family:sans-serif;font-size:14px;color:#c0392b;">The daily EOD digest could not be produced:</div><pre style="font-size:12px;color:#333;">${escapeHtml(message)}</pre>`,
      text: `EOD digest failed to run: ${message}`,
    })
  } catch (err) {
    console.error('EOD: alert email also failed:', err?.message || err)
  }
}

// --------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------
async function runEod(env) {
  const cfg = readConfig(env)
  const now = Date.now()
  const { today, yesterday } = eodDates(now)

  let data
  try {
    data = await withRetry(() => fetchEodData(cfg, now), 'supabase-read')
  } catch (err) {
    console.error('EOD: giving up on Supabase read:', err?.message || err)
    await sendAlert(cfg, `Supabase read failed: ${err?.message || err}`)
    throw err // marks the cron run as failed in Cloudflare observability
  }

  const digest = buildDigest({ ...data, now, pendingDays: cfg.pendingDays })

  // Today's attention sets — what gets stored, and diffed against yesterday.
  const flaggedArr = [...new Set(digest.flagged.map((i) => i.id))]
  const pendingArr = [
    ...new Set([
      ...digest.pending.map((i) => i.id),
      ...digest.flagged.filter((i) => i.pending).map((i) => i.id),
    ]),
  ]
  const todaySet = new Set([...flaggedArr, ...pendingArr])

  // Yesterday's snapshot — best effort. A missing table/row (e.g. first run, or
  // the migration not yet applied) just means no resolved section today.
  let prevSnap = null
  try {
    const rows = await pg(
      cfg,
      `wp_chat_eod_snapshots?snapshot_date=eq.${yesterday}&select=flagged_conversation_ids,pending_conversation_ids&limit=1`
    )
    prevSnap = Array.isArray(rows) && rows.length ? rows[0] : null
  } catch (err) {
    console.error('EOD: previous snapshot read failed (no resolved section today):', err?.message || err)
  }

  // Diff: resolved = in yesterday, gone today; new = flagged today, absent yesterday.
  let resolved = []
  let newIds = new Set()
  if (prevSnap) {
    const yFlagged = new Set(prevSnap.flagged_conversation_ids || [])
    const yPending = new Set(prevSnap.pending_conversation_ids || [])
    const resolvedIds = [...new Set([...yFlagged, ...yPending])].filter((id) => !todaySet.has(id))
    newIds = new Set(flaggedArr.filter((id) => !yFlagged.has(id)))

    if (resolvedIds.length) {
      let names = new Map()
      try {
        names = await fetchNames(cfg, resolvedIds)
      } catch (err) {
        console.error('EOD: resolved-name lookup failed (using ids):', err?.message || err)
      }
      resolved = resolvedIds.map((id) => ({ id, name: names.get(id) || `#${id}`, wasFlagged: yFlagged.has(id) }))
    }
  }

  const email = renderEmail(digest, cfg, now, { resolved, newIds })

  await withRetry(() => sendResend(cfg, email), 'resend-send') // throws on final failure -> cron marked failed
  console.log(
    `EOD sent to ${cfg.to}: ${digest.counts.flagged} flagged, ${digest.counts.pending} pending, ` +
      `${resolved.length} resolved (${cfg.pendingDays}+d)`
  )

  // Save today's snapshot AFTER a successful send. Non-fatal: the email is the
  // deliverable, and a failed write must not re-trigger a resend on retry.
  try {
    await withRetry(
      () =>
        pgWrite(
          cfg,
          'wp_chat_eod_snapshots?on_conflict=snapshot_date',
          [{ snapshot_date: today, flagged_conversation_ids: flaggedArr, pending_conversation_ids: pendingArr }],
          { upsert: true }
        ),
      'snapshot-write'
    )
  } catch (err) {
    console.error('EOD: today snapshot write failed (resolved tracking misses a day):', err?.message || err)
  }
}

export default {
  // Cron entry point. Awaited so a thrown failure marks the run errored (visible
  // in the Cloudflare dashboard / cron-failure alerts — the manual-check surface).
  async scheduled(event, env, ctx) {
    await runEod(env)
  },
  // Health check only — never triggers a send from a public request. Test the
  // real path locally with `wrangler dev --test-scheduled` + curl /__scheduled.
  async fetch() {
    return new Response('EOD digest worker — runs on cron (0 11 * * * UTC = 19:00 SGT).', {
      headers: { 'Content-Type': 'text/plain' },
    })
  },
}
