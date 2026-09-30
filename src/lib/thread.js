// Ordering and merging for a windowed thread.
//
// Lives in its own module rather than inside Inbox.jsx so it can be tested
// directly — a mirrored copy in a test file would drift.

/**
 * Thread order is the tuple (created_at, id), matching the server.
 *
 * Ordering on id alone is wrong and will become visibly wrong: the planned
 * three-month backfill inserts OLD messages with NEW ids, so every one of them
 * would sort to the bottom of its thread.
 */
export function byPosition(a, b) {
  const ta = new Date(a.created_at).getTime()
  const tb = new Date(b.created_at).getTime()
  if (ta !== tb) return ta - tb
  return Number(a.id) - Number(b.id)
}

/**
 * Fold a freshly fetched page into the loaded window.
 *
 * A plain replace — which is what the poll used to do — would discard any
 * older pages the reader had scrolled up to. Keying by id means an existing
 * row picks up its latest status (queued -> sent, or a failure) while
 * everything outside the incoming page is preserved.
 *
 * Incoming rows win on conflict: they are always the fresher copy.
 */
export function mergeMessages(existing, incoming) {
  if (!existing?.length) return incoming || []
  if (!incoming?.length) return existing

  const byId = new Map(existing.map((m) => [String(m.id), m]))
  for (const message of incoming) byId.set(String(message.id), message)

  return [...byId.values()].sort(byPosition)
}

/**
 * Split text into alternating non-match / match runs for highlighting.
 *
 * Returns [{text, match}] covering the whole string, so the caller renders the
 * parts in order and nothing is lost. Always returns at least one part, which
 * means the render path needs no empty-array special case.
 *
 * Case-insensitive, and finds EVERY occurrence — unlike the server's snippet
 * builder, which deliberately reports only the first because it is choosing a
 * window to cut.
 */
export function splitMatches(text, query) {
  const source = String(text ?? '')
  const needle = String(query ?? '')
  // The empty-needle guard is not just an optimisation: indexOf('') returns
  // the search position, so the loop below would never advance.
  if (!needle || !source) return [{ text: source, match: false }]

  const haystack = source.toLowerCase()
  const lowered = needle.toLowerCase()

  const parts = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(lowered, from)
    if (at === -1) break
    if (at > from) parts.push({ text: source.slice(from, at), match: false })
    parts.push({ text: source.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }

  if (!parts.length) return [{ text: source, match: false }]
  if (from < source.length) parts.push({ text: source.slice(from), match: false })
  return parts
}
