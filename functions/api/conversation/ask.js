import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { produceAnswer, AiError, ASK_MESSAGE_CAP, ASK_HISTORY_TURNS } from '../../_lib/ai.js'

const MAX_QUESTION_CHARS = 1000

const ASK_MSG_COLUMNS = 'id, direction, body, sender_name, media_type, media_caption, created_at'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

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
    .slice(-ASK_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, MAX_QUESTION_CHARS) }))
}

/**
 * POST /api/conversation/ask
 * Body: { conversation_id, question, history? }
 *
 * Answers a free-form question against the WHOLE of one conversation, and can
 * draft a message for the agent to send.
 *
 * Unlike /api/conversation/summary this DOES await the model. That endpoint is
 * a background-refreshed cache read that fires several times just from opening
 * the inbox, so blocking there was the 14s open. This one runs only when an
 * agent types a question and presses send, with a visible pending state — there
 * is nothing to show until the answer exists, and nothing is cached or stored.
 *
 * Nothing here writes to wp_chat_summaries: the 30-day rolling summary and this
 * full-history Q&A are independent, so an ask can never disturb the memory.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const conversationId = positiveInt(body.conversation_id)
  if (!conversationId) return badRequest('conversation_id is required')

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) return badRequest('question is required')
  if (question.length > MAX_QUESTION_CHARS) {
    return badRequest(`question must be ${MAX_QUESTION_CHARS} characters or fewer`)
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    // The WHOLE conversation, newest-first then reversed — the point of this
    // feature is that it is NOT limited to the summary's 30-day window. Capped
    // at ASK_MESSAGE_CAP so one ask on a huge thread stays bounded; the builder
    // then clips the transcript by characters as a second ceiling.
    const desc =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select(ASK_MSG_COLUMNS)
          .eq('conversation_id', conversationId)
          .order('id', { ascending: false })
          .limit(ASK_MESSAGE_CAP)
      ) || []

    if (!desc.length) return badRequest('This conversation has no messages to read yet.')

    const result = await produceAnswer({
      env,
      question,
      messages: desc.reverse(),
      isGroup: !!access.conversation.is_group,
      history: readHistory(body.history),
    })

    return json({
      ok: true,
      answer: result.answer,
      draft: result.draft,
      truncated: result.truncated,
      model: result.model,
    })
  } catch (err) {
    // A model failure is an expected outcome here, not a bug: report it as a
    // clean message the panel can show inline instead of a 500.
    if (err instanceof AiError) {
      return json({ ok: false, error: 'The AI could not answer that just now. Please try again.' }, 503)
    }
    return serverError(err?.message || 'Failed to answer')
  }
}
