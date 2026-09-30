#!/usr/bin/env node
//
// Standalone local history backfill — imports up to a year of WhatsApp history
// from Whapi into the database. Runs from a workstation with `node`, NOT as a
// Cloudflare Worker: it exists precisely to escape the Worker subrequest limit
// that made the in-app manual sync fail ("too many subrequests") on large
// ranges.
//
// It reuses the LIVE app's persistence, unchanged, so there is zero drift:
//   • persistHistorical()  — functions/_lib/sync.js — is the exact function the
//     in-app sync uses. It owns the dedup key (whapi_message_id), the direction
//     handling (from_me -> outbound with sender columns), the media pipeline,
//     the group handling, and the "insert as read / don't touch unread / only
//     move last_message_at forward" rules. This script does NOT reimplement any
//     of that — it pages Whapi and hands each raw message to persistHistorical.
//   • listChats / listMessages — functions/_lib/whapi.js — for pagination.
//   • describeAttachment       — functions/_lib/ingest.js — to count media.
//   • getDb                    — functions/_lib/db.js — the shared supabase-js client.
//
// ── TWO-PHASE DESIGN ────────────────────────────────────────────────────────
// PHASE 1 — enumerate EVERY chat first (paging /chats 100 at a time), keep only
//   real 1:1 (@s.whatsapp.net) and group (@g.us) JIDs, and freeze that full list
//   into the cursor. A resume with an existing list skips Phase 1 entirely.
// PHASE 2 — process ONE conversation at a time, and for each one fetch ALL of
//   its messages into memory FIRST, then persist them ALL, then move on. Fetch
//   and persist are never interleaved across conversations, so an interruption
//   mid-fetch simply re-fetches that one conversation from scratch on resume
//   (dedup on whapi_message_id keeps re-runs write-nothing-twice safe).
//
// NOTE ON DATABASE_URL: the shared persistence reaches Supabase over HTTPS
// (PostgREST) via supabase-js, which needs SUPABASE_URL + the service role key —
// a raw Postgres DATABASE_URL is neither used nor required.
//
// USAGE:
//   node scripts/backfill.mjs [FROM] [TO] [options]
//     FROM, TO      YYYY-MM-DD (default: 12 months ago .. today, UTC)
//     --delay=MS    ms between Whapi calls (default 250; also BACKFILL_DELAY_MS)
//     --page=N      messages per Whapi page (default 100)
//     --reset       ignore any saved cursor and start fresh
//     --cursor=PATH cursor file (default scripts/.backfill-cursor.json)
//
// Safe to run repeatedly and to interrupt (Ctrl-C): the cursor records the chat
// list, the completed conversations and the running totals; dedup makes re-runs
// write nothing twice; a finished window is a no-op on re-run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { persistHistorical } from '../functions/_lib/sync.js'
import { describeAttachment } from '../functions/_lib/ingest.js'
import { listChats, listMessages } from '../functions/_lib/whapi.js'
import { getDb } from '../functions/_lib/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Thrown on an account-level Whapi failure (402 / unauthorised) — must stop. */
export class AccountError extends Error {}

const MAX_429_RETRIES = 8
const MAX_MESSAGES_PER_CHAT = 100000 // safety valve against a pathological loop
const REQUEST_TIMEOUT_MS = 60000 // per Whapi request — a stuck /messages/list must not stall the run
const PROGRESS_EVERY = 300 // emit a "fetching…" line each time this many messages accrue
const CHATS_PAGE = 100 // Phase 1 always pages /chats 100 at a time

// The shared persistence emits diagnostic and expected-media-failure logs;
// silence just those known-noisy lines so per-chat progress stays readable.
const NOISE = /^(sync\.diag|ingest: media fetch failed|ingest: media upload failed|ingest: recovered media)/

/**
 * Wrap the current global fetch so that ONLY Whapi-gate calls are throttled,
 * timed out and 429-retried. Supabase (our DB) and direct media CDN downloads
 * pass straight through. The shared modules call the global fetch, so this
 * covers list AND media fetches without touching shared code. Returns a
 * restore fn.
 */
function installThrottle(whapiHost, delayMs, warn) {
  const realFetch = globalThis.fetch.bind(globalThis)
  let lastAt = 0

  // One attempt, bounded by REQUEST_TIMEOUT_MS. A timeout becomes a synthetic
  // 408 rather than a throw, so the shared whapi.js turns it into an ordinary
  // { ok: false, error: 'list_408' } and the caller's existing per-chat error
  // path handles it — no shared-code change, no special case downstream.
  const attemptFetch = async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    // Respect a caller-supplied signal too, rather than silently dropping it.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
    try {
      const res = await realFetch(input, { ...init, signal })
      return res
    } catch (err) {
      // Only OUR timer's abort becomes a 408; a caller abort or a genuine
      // transport error must still surface as itself.
      if (controller.signal.aborted) {
        warn(`   … request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — treating as a failure`)
        return new Response(null, { status: 408, statusText: 'Timeout' })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  globalThis.fetch = async (input, init) => {
    let host
    try {
      host = new URL(typeof input === 'string' ? input : input.url).host
    } catch {
      return realFetch(input, init)
    }
    if (host !== whapiHost) return realFetch(input, init)

    for (let attempt = 0; ; attempt++) {
      const wait = delayMs - (Date.now() - lastAt)
      if (wait > 0) await sleep(wait)
      lastAt = Date.now()

      // Fresh controller/timer per attempt, so the 60s budget is per-attempt
      // and a 429 backoff does not eat into the next attempt's time.
      const res = await attemptFetch(input, init)
      if (res.status !== 429) return res
      try {
        await res.body?.cancel()
      } catch {
        /* already consumed */
      }
      if (attempt >= MAX_429_RETRIES) return res
      const retryAfter = Number(res.headers.get('retry-after'))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 1000 * 2 ** attempt)
      warn(`   … rate limited (429) — backing off ${Math.round(backoff / 1000)}s`)
      await sleep(backoff)
    }
  }
  return () => {
    globalThis.fetch = realFetch
  }
}

function installLogFilter() {
  const log = console.log
  const err = console.error
  console.log = (...a) => (typeof a[0] === 'string' && NOISE.test(a[0]) ? undefined : log(...a))
  console.error = (...a) => (typeof a[0] === 'string' && NOISE.test(a[0]) ? undefined : err(...a))
  return () => {
    console.log = log
    console.error = err
  }
}

const EMPTY_TOTALS = { found: 0, added: 0, duplicate: 0, skipped: 0, mediaStored: 0, mediaExpired: 0 }

/** Only 1:1 chats and groups can be paged by /messages/list; everything else 400s. */
const isChatJid = (id) =>
  typeof id === 'string' && (id.endsWith('@s.whatsapp.net') || id.endsWith('@g.us'))

// ── formatting helpers ──────────────────────────────────────────────────────
const fmt = (n) => Number(n || 0).toLocaleString('en-US')

/** "4h 12m 33s" — drops leading units that are zero (h shown only when > 0). */
function fmtHMS(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts = []
  if (h) parts.push(`${h}h`)
  if (h || m) parts.push(`${m}m`)
  parts.push(`${sec}s`)
  return parts.join(' ')
}

/** "~8h 20m" or "~20m" — coarse ETA, no seconds. */
function fmtETA(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `~${h}h ${m}m` : `~${m}m`
}

/**
 * PHASE 1 — enumerate every chat, paging /chats until exhausted, keeping only
 * real 1:1 and group JIDs. Logs cumulative page progress. Returns the filtered
 * list plus the count of non-chat JIDs dropped. Throws AccountError on a 402.
 */
async function listAllChats(env, log) {
  const chats = []
  let skipped = 0
  let offset = 0
  let pageNum = 0

  for (;;) {
    const res = await listChats(env, { offset, count: CHATS_PAGE })
    if (!res.ok) {
      if (res.accountError) throw new AccountError(res.error)
      throw new Error(`Could not list chats: ${res.error}`)
    }
    if (!res.chats.length) break

    pageNum++
    for (const c of res.chats) {
      if (isChatJid(c.id)) chats.push({ id: c.id, name: c.name, isGroup: c.isGroup })
      else skipped++
    }

    const fetched = offset + res.chats.length
    log(`Fetching chats... page ${pageNum} (${fetched} chats)`)

    offset = fetched
    if (res.total && fetched >= res.total) break
    if (!res.total && res.chats.length < CHATS_PAGE) break
  }

  log(`Phase 1 complete: ${chats.length} valid chats (skipped ${skipped} non-chat JIDs)`)
  return { chats, skipped }
}

/**
 * PHASE 2 — Step A. Fetch ALL messages for one conversation within the window.
 *
 * TIMESTAMP pagination, NOT offset pagination: Whapi's /messages/list has to
 * scan every earlier message to satisfy a high offset, so it slows down and
 * eventually times out on big chats (~offset 1500+). Instead every page is
 * offset=0 with time_to narrowed to just before the oldest message seen so far,
 * so Whapi never scans past offset 0 — speed is independent of conversation size.
 *
 *   Page 1: time_from=windowStart, time_to=windowEnd
 *   Page 2: time_from=windowStart, time_to=oldestTsOfPage1 - 1
 *   Page 3: time_from=windowStart, time_to=oldestTsOfPage2 - 1
 *   … time_to only ever shrinks, so it terminates and never re-fetches a page.
 *
 * Messages arrive newest-first; the collected array is reversed on return so
 * persistHistorical writes oldest-first (its last_message_at only moves forward).
 *
 * 60s timeout per page (via installThrottle -> 408); one retry on a timeout, and
 * on a SECOND timeout the whole conversation is skipped.
 *
 * Returns { messages, done? , stopped?, timedOut?, capped?, error? } — `messages`
 * is oldest-first on every persisting return. Throws AccountError on a 402.
 */
export async function fetchAllMessages(env, chat, opts, label, isStopping, log) {
  const { fromTs, toTs, page } = opts
  const collected = []
  let nextProgressAt = PROGRESS_EVERY
  let timeTo = toTs // the moving ceiling; starts at the window end

  for (;;) {
    if (isStopping()) return { messages: collected, stopped: true }

    const query = { offset: 0, count: page, timeFrom: fromTs, timeTo }
    let list = await listMessages(env, chat.id, query)

    // Retry ONCE on a timeout; a second timeout skips the conversation.
    if (!list.ok && list.status === 408) {
      list = await listMessages(env, chat.id, query)
      if (!list.ok && list.status === 408) return { messages: collected, timedOut: true }
    }

    if (!list.ok) {
      if (list.accountError) throw new AccountError(list.error)
      // A non-timeout per-chat failure is not fatal — surface what we have.
      return { messages: collected.reverse(), error: list.error }
    }

    const msgs = list.messages
    if (!msgs.length) return { messages: collected.reverse(), done: true }

    // Collect in-window messages and track the OLDEST timestamp on this page,
    // which becomes the NEXT page's ceiling.
    let pageMin = Infinity
    for (const msg of msgs) {
      const ts = Number(msg?.timestamp)
      if (Number.isFinite(ts)) {
        if (ts < pageMin) pageMin = ts
        // Defensive window guard (time_from/time_to should already bound it).
        if (ts < fromTs || ts > toTs) continue
      }
      collected.push(msg)
    }

    if (collected.length >= nextProgressAt) {
      log(`${label} — fetching... ${collected.length} msgs`)
      while (collected.length >= nextProgressAt) nextProgressAt += PROGRESS_EVERY
    }
    if (collected.length > MAX_MESSAGES_PER_CHAT) return { messages: collected.reverse(), capped: true }

    // Stop once the page reached the window floor (nothing older remains), or if
    // no message carried a usable timestamp to advance on (guards an endless loop).
    if (!Number.isFinite(pageMin) || pageMin <= fromTs) return { messages: collected.reverse(), done: true }

    // Narrow strictly below the oldest message so the ceiling always decreases —
    // this is what keeps every request at offset 0.
    timeTo = pageMin - 1
    if (timeTo < fromTs) return { messages: collected.reverse(), done: true }
  }
}

/**
 * PHASE 2 — Step B. Persist ALL of one conversation's already-fetched messages
 * via the shared persistHistorical. This is the DB-write phase; it runs only
 * after every message for the conversation is in memory.
 */
async function persistAll(env, db, chat, messages) {
  const stat = { found: 0, added: 0, duplicate: 0, skipped: 0, mediaStored: 0, mediaExpired: 0 }
  for (const msg of messages) {
    stat.found++
    const hadMedia = Boolean(describeAttachment(msg))
    const r = await persistHistorical(env, db, msg, chat.name)
    if (r.added) stat.added++
    else if (r.duplicate) stat.duplicate++
    else if (r.skipped) stat.skipped++
    // Only count media on newly-added rows, so a re-run does not double-count.
    if (hadMedia && r.added) {
      if (r.mediaFailed) stat.mediaExpired++
      else stat.mediaStored++
    }
  }
  return stat
}

/**
 * Run the whole backfill (both phases). Testable: pass an explicit config and
 * (in tests) set a stubbed globalThis.fetch first — the throttle wraps whatever
 * is current.
 *
 * @returns { totals, total, doneCount, interrupted, timedOut }
 */
export async function runBackfill({
  env,
  from,
  to,
  fromTs,
  toTs,
  delayMs = 250,
  page = 100,
  cursorFile,
  reset = false,
  isStopping = () => false,
  log = console.log,
  warn = (m) => process.stderr.write(`${m}\n`),
}) {
  const whapiHost = new URL(env.WHAPI_API_URL || 'https://gate.whapi.cloud').host
  const restoreFetch = installThrottle(whapiHost, delayMs, warn)
  const restoreLog = installLogFilter()

  const db = getDb(env)
  const runStart = Date.now()

  const readCursor = () => {
    if (reset || !cursorFile || !fs.existsSync(cursorFile)) return null
    try {
      const c = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      if (c?.window?.from === from && c?.window?.to === to) return c
      warn(`   (ignoring cursor for a different window ${c?.window?.from}..${c?.window?.to})`)
      return null
    } catch {
      return null
    }
  }
  const writeCursor = (c) => cursorFile && fs.writeFileSync(cursorFile, JSON.stringify(c, null, 2))

  try {
    const prior = readCursor()
    const totals = { ...EMPTY_TOTALS, ...(prior?.totals || {}) }
    // Accept an older cursor's `processed` key too, for a graceful migration.
    const done = new Set(prior?.completed || prior?.processed || [])

    // ── PHASE 1 ── list every chat (or reuse the frozen list on resume) ──────
    let chatList = Array.isArray(prior?.chatList) ? prior.chatList : null
    let skippedJids = Number(prior?.skippedJids) || 0
    if (chatList && chatList.length) {
      log(`Phase 1 skipped — ${chatList.length} chats already listed${done.size ? `, ${done.size} done` : ''} (resuming).\n`)
    } else {
      const listed = await listAllChats(env, log)
      chatList = listed.chats
      skippedJids = listed.skipped
      log('')
    }

    const total = chatList.length
    const cursor = {
      window: { from, to },
      chatList,
      skippedJids,
      completed: [...done],
      current: prior?.current || null,
      totals,
    }
    const persist = () => writeCursor(cursor)
    persist() // freeze the chat list (and any resumed state) before Phase 2

    // ── PHASE 2 ── one conversation at a time: fetch all, then persist all ───
    let interrupted = false
    let timedOut = 0
    let processedThisRun = 0
    let index = 0

    for (const chat of chatList) {
      index++
      if (done.has(chat.id)) continue
      if (isStopping()) {
        interrupted = true
        break
      }

      const kind = chat.isGroup ? 'group' : 'chat'
      const name = chat.name || chat.id
      const label = `[${index}/${total}] ${name} (${kind})`

      // Mark the in-flight conversation so an interruption mid-fetch knows which
      // one to retry from scratch (it is never in `completed` until it finishes).
      cursor.current = chat.id
      persist()

      // Step A — fetch EVERYTHING for this conversation first.
      const fetched = await fetchAllMessages(env, chat, { fromTs, toTs, page }, label, isStopping, log)

      if (fetched.stopped) {
        // Ctrl-C during the fetch: nothing persisted; leave it uncompleted so a
        // re-run refetches it from scratch.
        interrupted = true
        persist()
        break
      }

      if (fetched.timedOut) {
        log(`${label} — SKIPPED (timed out twice) — will retry next run`)
        timedOut++
        cursor.current = null
        persist() // NOT added to completed → retried on the next run
        continue
      }

      // Step B — now persist EVERYTHING for this conversation.
      const stat = await persistAll(env, db, chat, fetched.messages)
      for (const k of Object.keys(stat)) totals[k] += stat[k]

      // Step C — one result line, mark done, move on.
      log(
        `${label} | msgs: ${fmt(stat.found)} | added: ${fmt(stat.added)} | dup: ${fmt(stat.duplicate)} | ` +
          `skip: ${fmt(stat.skipped)} | media: ✓${stat.mediaStored} ✗${stat.mediaExpired}` +
          (fetched.capped ? '  ⚠ hit message cap' : '') +
          (fetched.error ? `  ⚠ ${fetched.error}` : '')
      )

      done.add(chat.id)
      cursor.completed = [...done]
      cursor.current = null
      persist()
      processedThisRun++

      // Heartbeat every 10 completed conversations.
      const doneCount = done.size
      if (doneCount % 10 === 0) {
        const elapsedMs = Date.now() - runStart
        const pct = ((doneCount / total) * 100).toFixed(1)
        const eta =
          processedThisRun > 0
            ? fmtETA(((elapsedMs / processedThisRun) * (total - doneCount)) / 1000)
            : '~calculating'
        log(
          `--- Progress: ${doneCount}/${total} (${pct}%) | Total added: ${fmt(totals.added)} | ` +
            `Elapsed: ${fmtHMS(elapsedMs / 1000)} | ETA: ${eta} ---`
        )
      }

      if (isStopping()) {
        interrupted = true
        break
      }
    }

    // Clean finish (nothing left, not interrupted): drop the cursor.
    if (!interrupted && done.size >= total && cursorFile) {
      try {
        fs.unlinkSync(cursorFile)
      } catch {
        /* ignore */
      }
    }

    return { totals, total, doneCount: done.size, interrupted, timedOut }
  } finally {
    restoreLog()
    restoreFetch()
  }
}

// ------------------------------------------------------------------- direct run
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

const fmtDate = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

async function cli() {
  loadEnvFile(path.join(ROOT, '.env'))
  loadEnvFile(path.join(__dirname, '.env'))

  const flags = {}
  const positional = []
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2]
    else positional.push(a)
  }

  const die = (msg) => {
    process.stderr.write(`\n✖ ${msg}\n`)
    process.exit(1)
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const now = new Date()
  const fromD = new Date(now)
  fromD.setUTCFullYear(fromD.getUTCFullYear() - 1)
  const from = positional[0] || fmtDate(fromD)
  const to = positional[1] || fmtDate(now)
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) die(`Dates must be YYYY-MM-DD. Got FROM=${from} TO=${to}`)
  if (from > to) die(`FROM (${from}) must be on or before TO (${to}).`)

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    WHAPI_TOKEN: process.env.WHAPI_TOKEN,
    WHAPI_API_URL: process.env.WHAPI_API_URL || 'https://gate.whapi.cloud',
    BUSINESS_NUMBER: process.env.BUSINESS_NUMBER,
  }
  const missing = Object.entries({
    SUPABASE_URL: env.SUPABASE_URL,
    'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)': env.SUPABASE_SERVICE_ROLE_KEY,
    WHAPI_TOKEN: env.WHAPI_TOKEN,
    BUSINESS_NUMBER: env.BUSINESS_NUMBER,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) die(`Missing config: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`)

  const delayMs = Number(flags.delay ?? process.env.BACKFILL_DELAY_MS ?? 250) || 250
  const page = Math.max(1, Number(flags.page ?? 100) || 100)
  const cursorFile = flags.cursor ? path.resolve(String(flags.cursor)) : path.join(__dirname, '.backfill-cursor.json')
  const reset = Boolean(flags.reset)

  const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)
  const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000)

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(130)
    stopping = true
    process.stderr.write('\n… finishing the current conversation, then saving and exiting (Ctrl-C again to force)\n')
  })

  const startedAt = Date.now()
  console.log(`\nBackfill ${from} → ${to}  (delay ${delayMs}ms/call, page ${page})`)
  console.log(`Cursor: ${cursorFile}${reset ? ' (reset)' : ''}\n`)

  let result
  try {
    result = await runBackfill({
      env, from, to, fromTs, toTs, delayMs, page, cursorFile, reset,
      isStopping: () => stopping,
    })
  } catch (err) {
    if (err instanceof AccountError) {
      die(
        `Account-level Whapi error — STOPPING: ${err.message}\n` +
          `  Usually a 402 (quota/payment) or an unauthorised channel.\n` +
          `  Resolve it with Whapi, then re-run — the script resumes from its cursor.`
      )
    }
    process.stderr.write(`\n✖ Backfill failed: ${err?.stack || err}\n  Progress is saved — re-run to resume.\n`)
    process.exit(1)
  }

  const { totals, total, doneCount, interrupted, timedOut } = result
  const secs = Math.round((Date.now() - startedAt) / 1000)

  const rows = [
    ['Conversations', `${doneCount}/${total}`],
    ['Messages found', fmt(totals.found)],
    ['Messages added', fmt(totals.added)],
    ['Already present', fmt(totals.duplicate)],
    ['Skipped', fmt(totals.skipped)],
    ['Media stored', fmt(totals.mediaStored)],
    ['Media expired', fmt(totals.mediaExpired)],
    ['Total time', fmtHMS(secs)],
  ]
  const bar = '═'.repeat(46)
  const title = interrupted || doneCount < total ? 'Backfill Interrupted' : 'Backfill Complete'
  console.log(`\n${bar}`)
  console.log(`  ${title}`)
  for (const [k, v] of rows) console.log(`  ${(k + ':').padEnd(18)}${String(v).padStart(12)}`)
  console.log(bar)
  if (timedOut) console.log(`  (${timedOut} conversation(s) skipped on repeated timeout — re-run to retry them)`)
  console.log('')
}

// Only run when invoked directly (`node scripts/backfill.mjs`), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli()
}
