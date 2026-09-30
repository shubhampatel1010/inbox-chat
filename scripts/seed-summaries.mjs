#!/usr/bin/env node
//
// One-time bulk seed of AI summaries for existing conversations.
//
// Only 5 of hundreds of active conversations have a big summary because they
// were only ever generated on a manual click. This catches everything up.
//
// It reuses the LIVE app's generator unchanged — refreshConversationSummary()
// in functions/_lib/summarize.js — the same function the endpoint and the
// inbound webhook call. It does NOT reimplement the prompt, the model, the
// compaction, the dormant guard, or the 6-hour gate.
//
// Scope: conversations with any activity in the last 30 days, PLUS any
// conversation whose summary row exists but has an empty big_summary (the
// "failed" rows). For each that has no big summary yet, it generates one; those
// that already have one are logged and skipped.
//
// USAGE:
//   node scripts/seed-summaries.mjs [options]
//     --delay=MS    ms between AI generations (default 2000; also SEED_DELAY_MS)
//     --reset       ignore any saved cursor and start fresh
//     --cursor=PATH cursor file (default scripts/.seed-summaries-cursor.json)
//
// Safe to interrupt (Ctrl-C) and re-run: a local cursor records which
// conversations are done, and the app's own lease/dormant rules make re-runs
// cheap (already-summarised conversations are a no-op).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDb, unwrap } from '../functions/_lib/db.js'
import { refreshConversationSummary } from '../functions/_lib/summarize.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SEED_WINDOW_DAYS = 30
const PAGE = 1000

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}

/** Page through a PostgREST query (the builder factory returns a fresh query). */
async function fetchAll(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const rows = unwrap(await build().range(from, from + PAGE - 1)) || []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function main() {
  loadEnvFile(path.join(ROOT, '.env'))
  loadEnvFile(path.join(__dirname, '.env'))

  const flags = {}
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2]
  }
  const die = (msg) => {
    process.stderr.write(`\n✖ ${msg}\n`)
    process.exit(1)
  }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL, // optional; falls back to AI_MODEL
  }
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENROUTER_API_KEY'].filter((k) => !env[k])
  if (missing.length) die(`Missing config: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`)

  const delayMs = Number(flags.delay ?? process.env.SEED_DELAY_MS ?? 2000) || 2000
  const reset = Boolean(flags.reset)
  const cursorFile = flags.cursor
    ? path.resolve(String(flags.cursor))
    : path.join(__dirname, '.seed-summaries-cursor.json')

  const db = getDb(env)

  // Resume state: the set of conversation ids already handled.
  const done = new Set()
  if (!reset && fs.existsSync(cursorFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      ;(c.done || []).forEach((id) => done.add(id))
    } catch {
      /* corrupt cursor — start fresh */
    }
  }
  const saveCursor = () => {
    try {
      fs.writeFileSync(cursorFile, JSON.stringify({ done: [...done] }, null, 2))
    } catch {
      /* non-fatal */
    }
  }

  let interrupted = false
  process.on('SIGINT', () => {
    interrupted = true
    process.stdout.write('\n… interrupted — saving cursor, re-run to resume …\n')
    saveCursor()
    process.exit(0)
  })

  // 1. Every summary row: who already has a big summary, and which rows exist
  //    but are empty (the failed rows to regenerate).
  const summaries = await fetchAll(() =>
    db.from('wp_chat_summaries').select('conversation_id, big_summary').order('conversation_id', { ascending: true })
  )
  const hasBig = new Set()
  const failedIds = new Set()
  for (const s of summaries) {
    if (s.big_summary && String(s.big_summary).trim()) hasBig.add(s.conversation_id)
    else failedIds.add(s.conversation_id)
  }

  // 2. Conversations active in the last 30 days.
  const cutoff = new Date(Date.now() - SEED_WINDOW_DAYS * 86400000).toISOString()
  const candidates = await fetchAll(() =>
    db
      .from('wp_chat_conversations')
      .select('id, customer_name, customer_number, is_group')
      .gte('last_message_at', cutoff)
      .order('last_message_at', { ascending: false })
  )

  // 3. Add any failed-row conversation that isn't already in the 30-day set, so
  //    the clearly-broken empty rows get regenerated too.
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const extra = [...failedIds].filter((id) => !byId.has(id))
  for (let i = 0; i < extra.length; i += 500) {
    const rows =
      unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, customer_name, customer_number, is_group')
          .in('id', extra.slice(i, i + 500))
      ) || []
    for (const c of rows) if (!byId.has(c.id)) { byId.set(c.id, c); candidates.push(c) }
  }

  const nameOf = (c) => c.customer_name || (c.customer_number ? `+${c.customer_number}` : `#${c.id}`)
  const N = candidates.length
  console.log(`Seed summaries — ${N} candidate conversation(s) (30-day window + failed rows)`)
  console.log(`Cursor: ${cursorFile}${reset ? ' (reset)' : ''}  ·  ${delayMs}ms between generations\n`)

  const tally = { generated: 0, exists: 0, empty: 0, failed: 0, resumed: 0 }
  let i = 0
  for (const c of candidates) {
    i++
    if (done.has(c.id)) { tally.resumed++; continue }
    const label = `[${i}/${N}] ${nameOf(c)}`

    // Already has a big summary → nothing to do (no AI call, no delay).
    if (hasBig.has(c.id)) {
      console.log(`${label}: already exists`)
      tally.exists++
      done.add(c.id)
      saveCursor()
      if (interrupted) break
      continue
    }

    try {
      const { action } = await refreshConversationSummary(env, c.id, Boolean(c.is_group), db)
      if (action === 'generated') {
        console.log(`${label}: generated`)
        tally.generated++
        done.add(c.id)
        saveCursor()
        await sleep(delayMs) // rate limit ONLY after a real AI call
      } else if (action === 'cached') {
        // Dormant / short-only with no new activity — the guard forbids a call.
        console.log(`${label}: already exists (dormant)`)
        tally.exists++
        done.add(c.id)
        saveCursor()
      } else if (action === 'generating') {
        console.log(`${label}: busy (another run holds the lease)`)
        done.add(c.id)
        saveCursor()
      } else if (action === 'refresh_failed') {
        console.log(`${label}: FAILED (model/parse) — will retry next run`)
        tally.failed++ // not marked done → retried on the next run
      } else {
        console.log(`${label}: no messages`)
        tally.empty++
        done.add(c.id)
        saveCursor()
      }
    } catch (err) {
      console.error(`${label}: ERROR ${err?.message || err} — will retry next run`)
      tally.failed++
    }

    if (interrupted) break
  }

  console.log(
    `\nDone. generated=${tally.generated} already=${tally.exists} empty=${tally.empty} ` +
      `failed=${tally.failed} resumed=${tally.resumed}`
  )
  if (!interrupted && tally.failed === 0 && fs.existsSync(cursorFile)) {
    try {
      fs.unlinkSync(cursorFile)
      console.log('Cleared cursor (clean finish).')
    } catch {
      /* non-fatal */
    }
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
