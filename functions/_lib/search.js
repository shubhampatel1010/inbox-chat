// Query sanitising, keyset paging predicates, and snippet extraction.
// Shared by /api/search and /api/messages.

/** Below this a trigram index cannot be used at all — see sql/001_message_search.sql. */
export const MIN_QUERY_LENGTH = 2

export const SEARCH_PAGE_SIZE = 25
export const SEARCH_MAX_PAGE_SIZE = 50

/**
 * Ceiling for a conversation-scoped search.
 *
 * Higher than the global cap because in-thread search is a stepper, not a
 * list: "3 of 12" and the up/down chevrons only mean anything if the client
 * holds every match at once. 200 snippets is roughly 70KB in the worst case,
 * on a deliberate user action, for a single conversation.
 */
export const SEARCH_SCOPED_MAX_PAGE_SIZE = 200

/** Characters of context kept either side of the match in a snippet. */
const LEAD = 48
const TRAIL = 120
const ELLIPSIS = '…'

/**
 * Make a user's raw input safe to drop inside an ILIKE pattern.
 *
 * Three separate hazards, all of which silently change the meaning of the
 * search rather than erroring:
 *   - `%` and `_` are SQL LIKE wildcards.
 *   - `\` is LIKE's default escape character, so it must escape itself.
 *   - PostgREST rewrites `*` to `%` in like/ilike patterns before Postgres
 *     ever sees it, so escaping is too late — it has to go.
 */
export function likePattern(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/\*/g, ' ')
    // Collapse runs of whitespace so "foo   bar" matches "foo bar".
    .replace(/\s+/g, ' ')

  const escaped = cleaned.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `%${escaped}%`
}

/** The trimmed query, or '' when it is too short to run. */
export function normalizeQuery(raw) {
  const q = String(raw ?? '').trim().replace(/\s+/g, ' ')
  return q.length >= MIN_QUERY_LENGTH ? q : ''
}

/**
 * PostgREST `or=` predicate for "strictly before this point in the thread".
 *
 * Ordering is on the TUPLE (created_at, id), not on id alone. The backfill
 * will insert months-old messages with brand new ids, so id order and time
 * order will disagree and an id-only cursor would skip or repeat rows.
 *
 * Values are double-quoted because a timestamptz renders as
 * 2026-07-22T09:15:00.123456+00:00 — the `+` and `:` are harmless but the
 * quoting costs nothing and removes the question.
 */
export function beforeCursor({ created_at, id }, inclusive = false) {
  const op = inclusive ? 'lte' : 'lt'
  return `created_at.lt."${created_at}",and(created_at.eq."${created_at}",id.${op}.${id})`
}

/** Mirror of beforeCursor for "strictly after this point". */
export function afterCursor({ created_at, id }, inclusive = false) {
  const op = inclusive ? 'gte' : 'gt'
  return `created_at.gt."${created_at}",and(created_at.eq."${created_at}",id.${op}.${id})`
}

/**
 * Cut a readable window out of `text` around the first match of `query`.
 *
 * Returns {snippet, match_start, match_length} where match_start is an index
 * into the RETURNED snippet — the leading ellipsis is already accounted for,
 * so the frontend can slice on it directly without knowing anything about
 * how the window was chosen.
 *
 * Returns null when the query is not present, which is how the caller decides
 * whether the hit came from the body or from the sender name.
 */
export function buildSnippet(text, query) {
  const source = String(text ?? '')
  if (!source || !query) return null

  const at = source.toLowerCase().indexOf(query.toLowerCase())
  if (at === -1) return null

  const from = Math.max(0, at - LEAD)
  const to = Math.min(source.length, at + query.length + TRAIL)

  const head = from > 0 ? ELLIPSIS : ''
  const tail = to < source.length ? ELLIPSIS : ''

  // Newlines inside a one-line result row would either be collapsed or blow
  // the row height out, so flatten them here where the offset can be kept
  // correct — a replace of equal length cannot shift the match.
  const body = source.slice(from, to).replace(/\s/g, ' ')

  return {
    snippet: `${head}${body}${tail}`,
    match_start: head.length + (at - from),
    match_length: query.length,
  }
}
