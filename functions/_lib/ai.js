import { drainBody } from './http.js'

// ====================================================================
// The one place the model lives. Swap the provider/model here and every
// summary call follows. OpenRouter is OpenAI-compatible, so this is a plain
// fetch — no SDK in the Worker bundle.
//
// Two-tier architecture: ONE call produces a BIG summary (the compacted memory,
// source of truth) + a SHORT summary (what the panel shows) + the department
// classification + the attention flag.
// ====================================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Default model string per the brief. Overridable via env so the exact
// OpenRouter slug (which occasionally carries a suffix like `-exp`) can be
// corrected without a code change.
export const AI_MODEL = 'deepseek/deepseek-v3.2'

export const REFRESH_MS = 2 * 60 * 60 * 1000 // 2 hours

// Input caps — the whole cost constraint.
//   FIRST seed: the last SEED_WINDOW_DAYS of messages, capped to FIRST_MESSAGE_CAP.
//   INCREMENTAL: only the NEW messages since the cursor, capped to INCREMENTAL_MESSAGE_CAP.
// The full history is never re-read; compaction folds new activity into the big
// summary and compresses older detail.
export const SEED_WINDOW_DAYS = 30
export const FIRST_MESSAGE_CAP = 60
export const INCREMENTAL_MESSAGE_CAP = 40

// The big summary is bounded by instruction to this target; the model compresses
// older/resolved detail to stay under it, so incremental calls do not grow
// without limit. Expected steady-state big summary ≈ this size.
export const BIG_SUMMARY_TARGET_CHARS = 1500

const PER_MESSAGE_CHARS = 800
const MAX_TRANSCRIPT_CHARS = 12000 // ~3k tokens, a hard ceiling on the transcript
// Big (~375t) + short (~90t) + classification/attention fields — 700 is ample.
const MAX_OUTPUT_TOKENS = 700

const DEPARTMENTS = ['sales', 'operations', 'unclear']
const LEVELS = ['management', 'team', 'general']

/** A model/parse failure the endpoint turns into a graceful "couldn't refresh". */
export class AiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AiError'
  }
}

// --------------------------------------------------------------------
// Pure helpers (no network) — unit-tested without hitting DeepSeek.
// --------------------------------------------------------------------

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > PER_MESSAGE_CHARS ? t.slice(0, PER_MESSAGE_CHARS) + '…' : t
}

/** A media-only message still carries meaning; represent it, with any caption. */
function mediaPlaceholder(m) {
  const kind = m.media_type || 'media'
  const cap = m.media_caption ? `: ${clip(m.media_caption)}` : ''
  return `[${kind}${cap}]`
}

/**
 * One transcript line per message, oldest-first. The label tells the model who
 * spoke: in a group, inbound messages use the sender's name; one-to-one inbound
 * is "Customer"; every outbound is "Agent".
 */
export function formatTranscript(messages, isGroup) {
  return (messages || [])
    .map((m) => {
      const who =
        m.direction === 'outbound'
          ? 'Agent'
          : isGroup
            ? m.sender_name || 'Member'
            : 'Customer'
      const text = m.body && m.body.trim() ? clip(m.body) : mediaPlaceholder(m)
      return `${who}: ${text}`
    })
    .join('\n')
}

const SYSTEM_PROMPT = [
  'You maintain a running memory of a customer-support WhatsApp conversation for the team.',
  'Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY these keys:',
  `  "big_summary": a detailed, factual running record of the WHOLE conversation, formatted as a structured list of bullet points (each line starting with "• ") grouped under these headings, each heading on its own line ending with a colon:`,
  '      Key facts: names, numbers, dates, amounts, decisions',
  '      Current status: what is pending and the stage of any process (e.g. a verification)',
  '      Recent activity: what happened in the latest messages',
  '      Action needed: what needs follow-up',
  `    Put a newline between the heading and its bullets and between every bullet; omit a heading only when it genuinely has nothing. This is the memory. Keep it UNDER ~${BIG_SUMMARY_TARGET_CHARS} characters: compress older or resolved detail to make room for new activity.`,
  `  SCOPE: cover ONLY the last ${SEED_WINDOW_DAYS} days of the conversation. Drop anything whose activity falls entirely outside that window, even if it is still unresolved — it is out of scope. Within the window, never drop a still-pending or unresolved item.`,
  '  "short_summary": 2-3 concise bullet points (each line starting with "• ") covering the most important current state — NOT a paragraph. Derived from big_summary.',
  '  "department": one of "sales" (pricing, negotiation, quotes, sales enquiries), "operations" (documents, paperwork, process/operational matters), or "unclear" (cannot confidently determine).',
  '  "attention_required": boolean — true if a human should look at this soon.',
  '  "attention_level": one of "management", "team", "general", or null when attention_required is false.',
  '  "attention_reason": a short string (why), or null when attention_required is false.',
  'Attention: flag an angry/upset customer, a stalled/at-risk deal, an unanswered question, or an explicit escalation. "management" = most serious (churn/complaint/legal), "team" = the handling team should act, "general" = mild. If nothing needs attention: attention_required=false and the other two null.',
  'For a group chat, note it is a group and you may reference senders.',
  'Format the big_summary as a structured list with bullet points ("• "), grouped under the headings above. Format the short_summary as 2-3 bullet points ("• "), not a paragraph. Both stay plain-text JSON strings: use "• " for bullets and "\\n" for line breaks inside the string — no markdown fences.',
].join('\n')

/** The ISO date (YYYY-MM-DD) on which the rolling summary window opens. */
export function windowCutoffDate(now = Date.now()) {
  return new Date(now - SEED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 
 * Build the OpenAI-format messages array.
 *   mode 'first'       — seed the big summary from the supplied recent history.
 *   mode 'incremental' — compact: fold ONLY the supplied new messages into the
 *                        supplied existing big summary. The full history is never
 *                        included.
 */
export function buildSummaryRequest({ mode, existingBigSummary, messages, isGroup }) {
  let transcript = formatTranscript(messages, isGroup)
  let truncated = false
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the most recent — slice from the end.
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)
    truncated = true
  }

  const groupNote = isGroup ? 'This is a group chat.\n' : ''
  const truncNote = truncated ? '\n(Note: earlier messages were omitted for length.)' : ''

  // The rolling 30-day boundary, stated to the model as a date so it can age
  // content out of the carried-over memory rather than accumulating forever.
  const cutoff = windowCutoffDate()
  const cutoffNote =
    `The reporting window is the last ${SEED_WINDOW_DAYS} days: everything on or after ${cutoff}.\n`

  const user =
    mode === 'incremental'
      ? `${groupNote}${cutoffNote}Here is the existing big_summary (the memory so far):\n"""\n${existingBigSummary || ''}\n"""\n\n` +
        `Update it by folding in ONLY these NEW messages (oldest to newest) and compacting older/resolved detail to stay under ~${BIG_SUMMARY_TARGET_CHARS} characters. Do NOT re-summarize from scratch.\n\n` +
        `ROLLING WINDOW: the existing big_summary may hold items that have now aged out. REMOVE any item whose activity is entirely older than ${cutoff}, even if it is unresolved. Keep every still-pending item that falls inside the window. Then derive short_summary, department and attention from the updated big_summary.\n\n` +
        `New messages:\n${transcript}${truncNote}`
      : `${groupNote}${cutoffNote}Build the big_summary from these recent messages (the last ${SEED_WINDOW_DAYS} days, oldest to newest), then derive short_summary, department and attention from it.\n\n` +
        `Messages:\n${transcript}${truncNote}`

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    truncated,
  }
}

/**
 * Defensive parse of the model's reply. Strips markdown fences, extracts the
 * outermost {...}, JSON.parses, then validates and coerces every field. Throws
 * AiError only when there is NO usable summary at all — so a partially-sloppy
 * response still yields a record and the endpoint never blanks a good summary.
 */
export function parseSummaryResponse(text) {
  if (!text || typeof text !== 'string') throw new AiError('empty model response')

  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new AiError('no JSON object in model response')

  let obj
  try {
    obj = JSON.parse(s.slice(start, end + 1))
  } catch {
    throw new AiError('malformed JSON in model response')
  }
  if (!obj || typeof obj !== 'object') throw new AiError('model response was not an object')

  const big = typeof obj.big_summary === 'string' ? obj.big_summary.trim() : ''
  const short = typeof obj.short_summary === 'string' ? obj.short_summary.trim() : ''
  if (!big && !short) throw new AiError('model response had no summary')
  // Tolerate one-of-two: derive the missing side rather than failing.
  const bigOut = big || short
  const shortOut = short || (big.length > 300 ? big.slice(0, 300).trim() + '…' : big)

  const department = DEPARTMENTS.includes(obj.department) ? obj.department : 'unclear'

  const attention = obj.attention_required === true
  let level = null
  let reason = null
  if (attention) {
    level = LEVELS.includes(obj.attention_level) ? obj.attention_level : 'general'
    reason =
      typeof obj.attention_reason === 'string' && obj.attention_reason.trim()
        ? obj.attention_reason.trim().slice(0, 300)
        : null
  }

  return {
    big_summary: bigOut,
    short_summary: shortOut,
    department,
    attention_required: attention,
    attention_level: level,
    attention_reason: reason,
  }
}

/**
 * Decide, without any model call, what to do on open. The big summary is the
 * memory; the short is what is shown.
 *   - nothing stored, messages exist            -> generate/first   (seed)
 *   - nothing stored, no messages               -> empty
 *   - stored summary, NO new messages           -> cached           (DORMANT: never call the model, any age)
 *   - stored summary, new messages, < 2h old    -> cached
 *   - stored, new messages, >= 2h, has big       -> generate/incremental  (compact)
 *   - stored, new messages, >= 2h, no big (e.g.
 *     a migrated short-only row)                 -> generate/first        (seed the big)
 *
 * The dormant guard (no new messages -> cached) is absolute and is what makes a
 * closed/quiet conversation cost zero forever.
 */
export function decideRefresh({ summaryRow, latestMessageId, hasMessages, now, refreshMs = REFRESH_MS }) {
  const big = summaryRow && summaryRow.big_summary && summaryRow.big_summary.trim()
  const short = summaryRow && summaryRow.short_summary && summaryRow.short_summary.trim()

  // Nothing usable stored: behave like a first generation, ignoring the 2h gate.
  if (!big && !short) {
    return hasMessages ? { action: 'generate', mode: 'first' } : { action: 'empty' }
  }

  const cursor = summaryRow.last_summarized_message_id
  const hasNew =
    latestMessageId != null && (cursor == null || Number(latestMessageId) > Number(cursor))
  if (!hasNew) return { action: 'cached' } // dormant — the critical cost guard

  const generatedAt = summaryRow.generated_at ? new Date(summaryRow.generated_at).getTime() : 0
  const stale = now - generatedAt >= refreshMs
  if (!stale) return { action: 'cached' }

  // New activity + stale: compact if we have a big summary, otherwise (re)seed it.
  return { action: 'generate', mode: big ? 'incremental' : 'first' }
}

// --------------------------------------------------------------------
// Network
// --------------------------------------------------------------------

/** Low-level model call. Returns the raw assistant text. Throws AiError. */
export async function callOpenRouter(env, requestMessages, options = {}) {
  const key = env?.OPENROUTER_API_KEY
  if (!key) throw new AiError('OPENROUTER_API_KEY is not configured')
  const model = env?.OPENROUTER_MODEL || AI_MODEL
  // Defaults are the summary path's long-standing values, so that caller is
  // byte-for-byte unchanged; the ask path passes its own wider budget.
  const maxTokens = options.maxTokens || MAX_OUTPUT_TOKENS
  const temperature = options.temperature ?? 0.2

  let res
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: requestMessages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    })
  } catch (err) {
    throw new AiError(`model request failed: ${String(err?.message || err)}`)
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new AiError(`model HTTP ${res.status}: ${detail}`)
  }

  let payload
  try {
    payload = await res.json()
  } catch {
    await drainBody(res)
    throw new AiError('model returned non-JSON envelope')
  }

  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new AiError('model returned an empty choice')
  return content
}

/**
 * Produce a parsed two-tier summary. `generate` is injectable so the endpoint
 * (and tests) can stub the network. Returns the parsed fields plus the new
 * cursor (id of the newest message folded in) and the model.
 */
export async function produceSummary({ env, mode, existingBigSummary, messages, isGroup, generate }) {
  const run = generate || ((rm) => callOpenRouter(env, rm))
  const { messages: requestMessages } = buildSummaryRequest({ mode, existingBigSummary, messages, isGroup })
  const raw = await run(requestMessages)
  const parsed = parseSummaryResponse(raw)
  const lastId = messages && messages.length ? messages[messages.length - 1].id : null
  return { ...parsed, last_summarized_message_id: lastId, model: env?.OPENROUTER_MODEL || AI_MODEL }
}

// ====================================================================
// Ask-AI — the interactive "Chat with AI" side of the panel.
//
// Deliberately SEPARATE from the summary pipeline above: that one is a cached,
// background, cost-guarded memory keyed to a 30-day window. This one is a
// user-initiated question answered against the WHOLE conversation, and nothing
// it returns is ever written to wp_chat_summaries. The two never interfere.
// ====================================================================

/** How many messages of history an ask may draw on. Far wider than a summary. */
export const ASK_MESSAGE_CAP = 400

/** Transcript ceiling for an ask — larger than the summary's, still bounded. */
const ASK_MAX_TRANSCRIPT_CHARS = 40000

/** Room for a drafted reply plus a short rationale. */
const ASK_MAX_OUTPUT_TOKENS = 900

/** Turns of prior ask/answer context carried back, so follow-ups make sense. */
export const ASK_HISTORY_TURNS = 6

const ASK_SYSTEM_PROMPT = [
  'You are an assistant embedded in a customer-support WhatsApp team inbox.',
  'You are given the transcript of ONE conversation and a question from the agent handling it.',
  '',
  'You do two kinds of work:',
  '  1. ANSWER questions about the conversation — find details, dates, amounts, names, commitments, whatever was asked. Search the whole transcript.',
  '  2. DRAFT a message for the agent to send to this contact, when asked for one (e.g. "write a follow-up", "what should I say about the invoice", "draft a reply").',
  '',
  'Return ONLY a JSON object — no prose, no markdown fences — with these keys:',
  '  "answer": your reply to the agent, in plain text. Keep it tight and factual. Use "• " bullets for lists and "\n" for line breaks. This is what the agent reads, NOT what gets sent to the contact.',
  '  "draft": when the agent asked you to write/draft/suggest a message to SEND to the contact, the message text itself, ready to send as-is — no greeting placeholders like [Name] unless the name is genuinely unknown, no commentary, no quotes around it. When the agent only asked a question, this MUST be null.',
  '',
  'Rules:',
  '  - Ground every claim in the transcript. If it is not there, say so plainly rather than inventing it.',
  '  - A draft must match the language and tone already used with this contact, and read like the agent wrote it — never mention that it was AI-generated.',
  '  - Keep a draft to what a real support agent would actually send: short, direct, no corporate padding.',
  '  - When you produce a draft, keep "answer" to one short line (e.g. "Here is a follow-up you can send:"), since the draft is displayed separately.',
].join('\n')

/**
 * Build the ask request. `history` is prior [{role:'user'|'assistant', content}]
 * turns from this panel session so follow-ups ("make it shorter") resolve; it is
 * capped by the caller and never persisted server-side.
 */
export function buildAskRequest({ question, messages, isGroup, history = [] }) {
  let transcript = formatTranscript(messages, isGroup)
  let truncated = false
  if (transcript.length > ASK_MAX_TRANSCRIPT_CHARS) {
    // Keep the most recent — the tail is what a question usually concerns.
    transcript = transcript.slice(transcript.length - ASK_MAX_TRANSCRIPT_CHARS)
    truncated = true
  }

  const groupNote = isGroup
    ? 'This is a GROUP chat; inbound lines are labelled with the sender name.\n'
    : ''
  const truncNote = truncated
    ? '\n(Note: the oldest messages were omitted for length; this is the most recent history.)'
    : ''

  const turns = (history || [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-ASK_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: clip(t.content) }))

  return {
    messages: [
      { role: 'system', content: ASK_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `${groupNote}Conversation transcript (oldest to newest):\n"""\n${transcript}\n"""${truncNote}`,
      },
      // The transcript is established once; the turns that follow are the
      // actual back-and-forth, so "make it shorter" refers to the last draft.
      ...turns,
      { role: 'user', content: String(question || '').trim() },
    ],
    truncated,
  }
}

/** Defensive parse of an ask reply. Falls back to raw text over failing. */
export function parseAskResponse(text) {
  if (!text || typeof text !== 'string') throw new AiError('empty model response')

  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')

  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1))
      if (obj && typeof obj === 'object') {
        const answer = typeof obj.answer === 'string' ? obj.answer.trim() : ''
        const draft = typeof obj.draft === 'string' && obj.draft.trim() ? obj.draft.trim() : null
        if (answer || draft) return { answer: answer || 'Here is a message you can send:', draft }
      }
    } catch {
      /* fall through to the plain-text salvage below */
    }
  }

  // The model answered in prose instead of JSON. That is still a usable answer,
  // so show it rather than turning a good response into an error.
  if (s) return { answer: s, draft: null }
  throw new AiError('model returned no usable answer')
}

/**
 * Run one ask. Unlike the summary path this DOES block the request: it is a
 * direct user action with a visible pending state, not a background refresh.
 */
export async function produceAnswer({ env, question, messages, isGroup, history, generate }) {
  const run = generate || ((rm) => callOpenRouter(env, rm, { maxTokens: ASK_MAX_OUTPUT_TOKENS, temperature: 0.4 }))
  const { messages: requestMessages, truncated } = buildAskRequest({ question, messages, isGroup, history })
  const raw = await run(requestMessages)
  return { ...parseAskResponse(raw), truncated, model: env?.OPENROUTER_MODEL || AI_MODEL }
}

// ====================================================================
// Portal Ask — the inbox-wide assistant.
//
// The third AI surface, and deliberately separate from the two above.
//
//   produceSummary  — one conversation, cached, background, 30-day memory.
//   produceAnswer   — one conversation, live, the WHOLE thread.
//   producePortalAnswer (here) — EVERY conversation the caller can reach.
//
// THE COST PROBLEM AND ITS ANSWER. A portal-wide question ("what happened
// today?") spans hundreds of chats. Feeding raw transcripts for all of them is
// impossible inside a Worker's limits, and would cost a fortune per question.
//
// So this path reads the ALREADY-GENERATED per-conversation summaries instead.
// They are written by the summary pipeline on new activity and cost nothing to
// read, they already distil each chat down to its facts and pending items, and
// they already cover groups and one-to-one chats alike. One model call over a
// digest of N summaries answers portal questions and daily reports at a fixed,
// predictable cost no matter how busy the inbox is.
//
// Nothing here writes to wp_chat_summaries. A portal ask can never disturb a
// conversation's stored memory.
// ====================================================================

/** How many conversations may appear in one portal digest. */
export const PORTAL_CONVERSATION_CAP = 120

/** Ceiling on the assembled digest. Bounded like every other transcript. */
const PORTAL_MAX_DIGEST_CHARS = 42000

/** Per-conversation slice of the digest, so one huge summary cannot crowd out the rest. */
const PORTAL_PER_ENTRY_CHARS = 1200

/** Room for a full daily report with several sections of structured cases. */
const PORTAL_MAX_OUTPUT_TOKENS = 3000

/** Turns of prior portal Q&A carried back, so follow-ups resolve. */
export const PORTAL_HISTORY_TURNS = 6

const LEVEL_WORD = {
  management: 'MANAGEMENT ATTENTION',
  team: 'TEAM ATTENTION',
  general: 'ATTENTION',
}

/**
 * One digest entry per conversation: who it is, what kind of chat, when it was
 * last active, who owns it, whether it is flagged, and its stored summary.
 *
 * The summary is preferred big-then-short: the big summary is the structured
 * memory (key facts / status / recent activity / action needed) and is what
 * makes a useful report. A conversation with no summary row at all still gets
 * an entry — its metadata alone answers "who has not been replied to".
 */
export function formatPortalEntry(c, s, now = Date.now()) {
  const who = c.is_group
    ? `${c.customer_name || 'Group'} (GROUP${c.member_count ? `, ${c.member_count} members` : ''})`
    : c.customer_name || c.customer_number || 'Unknown contact'

  // The [chat:N] tag is how the model tells us WHICH chats it talked about, so
  // the panel can link straight to them. It is stripped from the visible text.
  const bits = [`### ${who} [chat:${c.id}]`]
  if (c.account_name) bits.push(`Account: ${c.account_name}`)
  bits.push(c.assigned_to ? `Assigned to: ${c.assigned_to}` : 'Assigned to: nobody')

  if (c.last_message_at) {
    const ageMs = now - new Date(c.last_message_at).getTime()
    const hours = Math.floor(ageMs / 3600000)
    const age =
      hours < 1 ? 'under an hour ago' : hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)} days ago`
    const dir = c.last_direction === 'inbound' ? 'from the customer' : 'from the agent'
    bits.push(`Last message: ${age} (${dir})`)
  } else {
    bits.push('Last message: none')
  }

  if (c.unread_count) bits.push(`Unread: ${c.unread_count}`)

  if (s?.attention_required) {
    const word = LEVEL_WORD[s.attention_level] || LEVEL_WORD.general
    bits.push(`FLAGGED — ${word}${s.attention_reason ? `: ${s.attention_reason}` : ''}`)
  }

  if (s?.department) bits.push(`Department: ${s.department}`)

  const body = (s?.big_summary || s?.short_summary || s?.summary_text || '').trim()
  bits.push(body ? `Summary:\n${body}` : 'Summary: none generated yet.')

  const entry = bits.join('\n')
  return entry.length > PORTAL_PER_ENTRY_CHARS
    ? entry.slice(0, PORTAL_PER_ENTRY_CHARS) + '…'
    : entry
}

/**
 * Assemble the digest of every supplied conversation, newest activity first so
 * that if the character ceiling truncates, what survives is what matters most.
 */
export function buildPortalDigest(conversations, summaryById, now = Date.now()) {
  const lookup = (id) =>
    summaryById instanceof Map ? summaryById.get(Number(id)) : summaryById?.[id]

  const parts = []
  let used = 0
  let omitted = 0

  for (const c of conversations || []) {
    const entry = formatPortalEntry(c, lookup(c.id), now)
    // +2 for the blank line between entries.
    if (used + entry.length + 2 > PORTAL_MAX_DIGEST_CHARS) {
      omitted += 1
      continue
    }
    parts.push(entry)
    used += entry.length + 2
  }

  return { digest: parts.join('\n\n'), included: parts.length, omitted }
}

const PORTAL_SYSTEM_PROMPT = [
  'You are the assistant for a WhatsApp team inbox used by a support and sales team.',
  'You are given a DIGEST of every conversation the user can see — both one-to-one customer chats and group chats — and a question from that user.',
  'Each digest entry carries the contact or group name, the account, who it is assigned to, how long ago it was last active, whether it is flagged for attention, and the running AI summary of that chat.',
  '',
  'You answer questions across the WHOLE inbox and you write reports.',
  '',
  'Return ONLY a JSON object — no prose, no markdown fences — with these keys:',
  '  "answer": your reply, in plain text. Use "• " for bullets and "\\n" for line breaks. Use a line ending in ":" as a section heading when the reply has sections.',
  '  "report": when the user asked for a REPORT, DIGEST or SUMMARY of activity (a daily report, "what happened today", "what needs attention", an end-of-day rundown, a per-department or per-person breakdown), put the report here as a JSON OBJECT in the shape below, and keep "answer" to one short lead-in line with the headline counts. Otherwise this MUST be null.',
  '  "chats": an array of the chat numbers (the N in each heading\'s [chat:N] tag) of EVERY conversation you name in "answer" or "report", in the order you first mention them. Use [] when you name none. The user clicks these to open the chats, so never leave out a chat you talked about and never include one you did not.',
  '',
  'The report object:',
  '  {"sections": [{"title": "Needs attention", "items": [{',
  '    "chat": 12,                      the N of the chat this case lives in',
  '    "case": "Helper transfer for Diana — visa pending",   a short title for THE CASE ITSELF (the job, order, request or problem), not just the chat name',
  '    "people": ["Diana (employer)", "Siti (helper)"],       the key people in this case, each as "Name (role)", only names that appear in the digest; [] if none',
  '    "status": "Where the case stands now, in one or two sentences.",',
  '    "action": "The next step and who should take it, or \\"\\" when nothing is needed.",',
  '    "level": "management" | "team" | "general" | null,    the flag level, only for flagged chats',
  '    "related": [7]                   other chats discussing this SAME case, or []',
  '  }]}]}',
  '',
  'Report sections, in this order, OMITTING any that would be empty:',
  '  Needs attention: flagged cases, most serious first (management, then team, then general).',
  '  Waiting on us: the last message came from the customer and nobody has replied, oldest first.',
  '  Active today: other cases that actually moved.',
  '',
  'Report rules:',
  '  - ONE item is ONE case. If one chat holds two separate cases, write two items with the same "chat". If two chats are about the same case, write ONE item with the main chat in "chat" and the others in "related".',
  '  - Each case appears ONCE in the whole report, in the first section above that fits it. Never repeat a case in a second section.',
  '  - Keep "status" and "action" short and concrete: names, dates, amounts, what is outstanding.',
  '',
  'Rules:',
  '  - Ground EVERY claim in the digest. Never invent a conversation, a name, a number or an event that is not there.',
  '  - Always name the contact or group you are talking about EXACTLY as written in its heading (without the [chat:N] tag), so the user can find the chat. If you mention a person from inside a summary (an employer, a candidate, a client), also give the chat heading name they appear in — the inbox search only finds chats by their heading name or number.',
  '  - Never write the [chat:N] tags in "answer" or "report"; they belong only in "chats".',
  '  - When the digest has nothing matching the question, say so plainly rather than padding the answer.',
  '  - A conversation whose summary says "none generated yet" has not been summarised — do not treat that as "nothing happened"; you may still use its metadata.',
  '  - Be concise and factual. This is an operational tool, not a sales document. No preamble, no sign-off.',
  '  - Counts matter: when you say "3 chats need attention", make sure it is actually 3.',
].join('\n')

/**
 * Build the portal ask request.
 *
 * `history` is the panel's prior turns so follow-ups ("only the group chats",
 * "now just sales") resolve against the last answer. It is capped by the caller
 * and never persisted.
 */
export function buildPortalAskRequest({
  question,
  conversations,
  summaryById,
  history = [],
  now = Date.now(),
  scopeNote = '',
}) {
  const { digest, included, omitted } = buildPortalDigest(conversations, summaryById, now)

  const today = new Date(now).toISOString().slice(0, 10)
  const omitNote = omitted
    ? `\n(Note: ${omitted} less-recently-active conversation${omitted === 1 ? ' was' : 's were'} omitted for length.)`
    : ''
  const countNote = `There ${included === 1 ? 'is' : 'are'} ${included} conversation${included === 1 ? '' : 's'} in this digest.`

  const turns = (history || [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-PORTAL_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: clip(t.content) }))

  return {
    messages: [
      { role: 'system', content: PORTAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Today's date is ${today}.\n${scopeNote ? `${scopeNote}\n` : ''}${countNote}\n\n` +
          `INBOX DIGEST (most recently active first):\n"""\n${digest}\n"""${omitNote}`,
      },
      // The digest is established once; the turns that follow are the actual
      // back-and-forth, so "only the flagged ones" refers to the last answer.
      ...turns,
      { role: 'user', content: String(question || '').trim() },
    ],
    included,
    omitted,
  }
}

const CHAT_TAG = /\s*\[chat:\s*(\d+)\]/gi

/** Every [chat:N] id in a piece of text, in order of first appearance. */
function tagIds(text) {
  return [...String(text || '').matchAll(CHAT_TAG)].map((m) => Number(m[1]))
}

/** The same text with any [chat:N] tags the model leaked into it removed. */
function stripTags(text) {
  return String(text || '').replace(CHAT_TAG, '')
}

/** De-duplicated positive integer ids, order kept. */
function cleanIds(list) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const id = Number(String(raw).replace(/^\s*(?:chat:)?\s*/i, ''))
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

const REPORT_LEVELS = new Set(['management', 'team', 'general'])

/** A short single-line string field from the model, tags removed. */
function reportText(v, max = 600) {
  return typeof v === 'string' ? stripTags(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/**
 * Sanitise the model's report. A structured report becomes
 * { sections: [{ title, items: [{ chat, case, people, status, action, level, related }] }] }
 * with empty sections dropped; a model that still wrote prose gets its string
 * kept. Chat ids here are raw — the caller checks them against its own scan.
 */
function normalizeReport(raw) {
  if (typeof raw === 'string') return stripTags(raw).trim() || null
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return null

  const sections = []
  for (const sec of raw.sections) {
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.items)) continue
    const items = []
    for (const it of sec.items) {
      if (!it || typeof it !== 'object') continue
      const item = {
        chat: cleanIds([it.chat])[0] ?? null,
        case: reportText(it.case, 160),
        people: (Array.isArray(it.people) ? it.people : [])
          .map((p) => reportText(p, 80))
          .filter(Boolean)
          .slice(0, 8),
        status: reportText(it.status),
        action: reportText(it.action),
        level: REPORT_LEVELS.has(it.level) ? it.level : null,
        related: cleanIds(Array.isArray(it.related) ? it.related : []),
      }
      if (item.case || item.status) items.push(item)
    }
    if (items.length) sections.push({ title: reportText(sec.title, 60) || 'Report', items })
  }
  return sections.length ? { sections } : null
}

/** Every chat id a structured report points at, in reading order. */
function reportIds(report) {
  if (!report || typeof report !== 'object') return []
  return report.sections.flatMap((s) => s.items.flatMap((it) => [it.chat, ...it.related]))
}

/**
 * Defensive parse of a portal reply. Falls back to raw text over failing.
 * `chatIds` are the conversations the reply talks about — the model's own list
 * first, plus any tags it wrote into the text anyway. The caller still checks
 * them against what was actually in the digest.
 */
export function parsePortalResponse(text) {
  if (!text || typeof text !== 'string') throw new AiError('empty model response')

  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')

  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1))
      if (obj && typeof obj === 'object') {
        const rawAnswer = typeof obj.answer === 'string' ? obj.answer : ''
        const rawReport = typeof obj.report === 'string' ? obj.report : ''
        const answer = stripTags(rawAnswer).trim()
        const report = normalizeReport(obj.report)
        // Report order first: it is the reading order the user sees.
        const chatIds = cleanIds([
          ...reportIds(report),
          ...(Array.isArray(obj.chats) ? obj.chats : []),
          ...tagIds(rawAnswer),
          ...tagIds(rawReport),
        ])
        if (answer || report) return { answer: answer || 'Here is the report:', report, chatIds }
      }
    } catch {
      /* fall through to the plain-text salvage below */
    }
  }

  // The model answered in prose instead of JSON. That is still a usable answer,
  // so show it rather than turning a good response into an error.
  const prose = stripTags(s).trim()
  if (prose) return { answer: prose, report: null, chatIds: cleanIds(tagIds(s)) }
  throw new AiError('model returned no usable answer')
}

/**
 * Run one portal ask. Blocks on the model, like produceAnswer: it is a direct
 * user action with a visible pending state, and there is nothing to show until
 * the answer exists.
 */
export async function producePortalAnswer({
  env,
  question,
  conversations,
  summaryById,
  history,
  now,
  scopeNote,
  generate,
}) {
  const run =
    generate ||
    ((rm) => callOpenRouter(env, rm, { maxTokens: PORTAL_MAX_OUTPUT_TOKENS, temperature: 0.3 }))
  const { messages: requestMessages, included, omitted } = buildPortalAskRequest({
    question,
    conversations,
    summaryById,
    history,
    now,
    scopeNote,
  })
  const raw = await run(requestMessages)
  return {
    ...parsePortalResponse(raw),
    conversations_read: included,
    omitted,
    model: env?.OPENROUTER_MODEL || AI_MODEL,
  }
}
