import { requireAuth } from '../../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { accessibleAccountIds, accessibleAccounts } from '../../_lib/accounts.js'
import {
  producePortalAnswer,
  AiError,
  PORTAL_CONVERSATION_CAP,
  PORTAL_HISTORY_TURNS,
} from '../../_lib/ai.js'

const MAX_QUESTION_CHARS = 1000

// Metadata the digest is built from. Deliberately NOT the message bodies: the
// portal assistant reads stored summaries, not transcripts (see the Portal Ask
// block in _lib/ai.js for why).
const CONVERSATION_COLUMNS = `
  id, account_id, customer_number, customer_name,
  last_message_at, last_direction, unread_count,
  assigned_to, is_group, member_count
`

// big_summary IS read here, unlike /api/summaries/batch. That endpoint feeds a
// list-row popover which only ever shows the short text; this one feeds a model
// that needs the structured memory (key facts / status / action needed) to write
// a useful report. It never leaves the Worker — only the model's answer does.
const SUMMARY_COLUMNS = `
  conversation_id, short_summary, big_summary, department,
  attention_required, attention_level, attention_reason, generated_at
`

/** PostgREST `in` filters travel in the query string, so chunk the id list. */
const SUMMARY_CHUNK = 60

/** Sanitise the client-supplied panel history into model turns. */
function readHistory(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (t) =>
        t &&
        (t.role === 'user' || t.role === 'assistant') &&
        typeof t.content === 'string' &&
        t.content.trim()
    )
    .slice(-PORTAL_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, MAX_QUESTION_CHARS) }))
}

/**
 * POST /api/portal/ask
 * Body: { question, account_id?, history? }
 *
 * The inbox-wide assistant. Answers a free-form question — or produces a daily
 * report — across EVERY conversation the caller can reach, group chats and
 * one-to-one chats alike.
 *
 * ACCOUNT IS THE BOUNDARY, exactly as everywhere else. The conversation scan is
 * filtered to accessibleAccountIds() before anything is read, so an agent can
 * never be answered from an account they are not on. There is no conversation
 * id in the request to check, which is precisely why the filter has to be the
 * first thing the query does rather than an afterthought.
 *
 * Nothing here writes: no summary row is touched, no thread is stored. Like
 * /api/conversation/ask this DOES await the model, because it runs only on an
 * explicit user action with a visible pending state.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) return badRequest('question is required')
  if (question.length > MAX_QUESTION_CHARS) {
    return badRequest(`question must be ${MAX_QUESTION_CHARS} characters or fewer`)
  }

  try {
    const db = getDb(env)

    // THE account boundary. Mirrors /api/conversations: an agent reaches only
    // the accounts they are assigned to, an admin every active one.
    const allowed = await accessibleAccountIds(env, auth.user)
    if (!allowed.length) {
      return json({
        ok: true,
        answer: 'You are not assigned to any account yet, so there are no chats to read.',
        report: null,
        conversations_read: 0,
      })
    }

    // An explicit account narrows the scan. An id outside `allowed` falls back
    // to every reachable account rather than erroring — the client may just be
    // holding a stale selection, and wedging the panel over that would be worse
    // than answering across everything the user can legitimately see.
    let scope = allowed
    const requested = body.account_id
    if (requested != null && requested !== '' && requested !== 'all') {
      const id = Number(requested)
      if (Number.isInteger(id) && allowed.includes(id)) scope = [id]
    }

    // Most recently active first: the cap and the digest's character ceiling
    // both truncate from the tail, so what survives is what matters most.
    const conversations =
      unwrap(
        await db
          .from('wp_chat_conversations')
          .select(CONVERSATION_COLUMNS)
          .in('account_id', scope)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(PORTAL_CONVERSATION_CAP)
      ) || []

    if (!conversations.length) {
      return json({
        ok: true,
        answer: 'There are no conversations in this inbox yet.',
        report: null,
        conversations_read: 0,
      })
    }

    // Summaries for exactly those conversations, in bounded chunks.
    const ids = conversations.map((c) => Number(c.id))
    const summaryById = new Map()
    for (let i = 0; i < ids.length; i += SUMMARY_CHUNK) {
      const slice = ids.slice(i, i + SUMMARY_CHUNK)
      const rows =
        unwrap(
          await db.from('wp_chat_summaries').select(SUMMARY_COLUMNS).in('conversation_id', slice)
        ) || []
      for (const row of rows) summaryById.set(Number(row.conversation_id), row)
    }

    // Name the accounts in the digest, but only when there is more than one in
    // scope — on a single-account deployment the label is pure noise.
    let scopeNote = ''
    if (scope.length > 1) {
      const accounts = await accessibleAccounts(env, auth.user)
      const byId = new Map(accounts.map((a) => [Number(a.id), a.name]))
      for (const c of conversations) c.account_name = byId.get(Number(c.account_id)) || null
      scopeNote = `This digest spans ${scope.length} accounts.`
    } else if (scope.length === 1 && allowed.length > 1) {
      const accounts = await accessibleAccounts(env, auth.user)
      const name = accounts.find((a) => Number(a.id) === scope[0])?.name
      if (name) scopeNote = `This digest covers the "${name}" account only.`
    }

    const result = await producePortalAnswer({
      env,
      question,
      conversations,
      summaryById,
      history: readHistory(body.history),
      scopeNote,
    })

    // Turn the model's chat ids into links the panel can open. Only ids that
    // were in THIS scan survive, so a hallucinated or out-of-scope id can never
    // become a link — the account boundary above still holds.
    const byId = new Map(conversations.map((c) => [Number(c.id), c]))
    const toChat = (id) => {
      const c = byId.get(id)
      if (!c) return null
      return {
        id: Number(c.id),
        account_id: c.account_id,
        account_name: c.account_name || null,
        name: c.customer_name || c.customer_number || (c.is_group ? 'Group' : 'Unknown contact'),
        is_group: !!c.is_group,
        assigned_to: c.assigned_to || null,
      }
    }
    const chats = (result.chatIds || []).map(toChat).filter(Boolean)

    // A structured report carries each case's chat as a full link object, the
    // same way. A case whose chat id was not in this scan keeps its text but
    // loses its link rather than pointing somewhere it should not.
    let report = result.report
    if (report && typeof report === 'object') {
      report = {
        sections: report.sections.map((s) => ({
          title: s.title,
          items: s.items.map((it) => ({
            ...it,
            chat: it.chat != null ? toChat(it.chat) : null,
            related: it.related.map(toChat).filter((c) => c && c.id !== it.chat),
          })),
        })),
      }
    }

    return json({
      ok: true,
      answer: result.answer,
      report,
      chats,
      conversations_read: result.conversations_read,
      omitted: result.omitted,
      model: result.model,
    })
  } catch (err) {
    // A model failure is an expected outcome, not a bug: report it as a clean
    // message the panel shows inline instead of a 500.
    if (err instanceof AiError) {
      return json(
        { ok: false, error: 'The AI could not answer that just now. Please try again.' },
        503
      )
    }
    return serverError(err?.message || 'Failed to answer')
  }
}
