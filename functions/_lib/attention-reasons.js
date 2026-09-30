// The closure-reason vocabulary, and the rules that decide whether a given
// dismissal is allowed to go through.
//
// This is the server's copy and it is AUTHORITATIVE. src/lib/attentionReasons.js
// mirrors the category list for rendering the sheet; if the two ever disagree,
// this one wins and the client simply shows a label it cannot submit. Nothing
// here may import from src/ — a Worker cannot reach it.

/** Minimum note length. Low on purpose: it stops '.', 'ok' and 'done'. */
export const MIN_NOTE_LENGTH = 15

/**
 * Hours a conversation must sit without a customer reply before it may be
 * closed as "no response". Thomas's follow-up window, enforced rather than
 * documented — otherwise "no response" becomes the reason everything gets
 * closed with, and the audit trail records a lie uniformly.
 */
export const NO_RESPONSE_MIN_HOURS = 24

/**
 * The categories. `requiresNote` is true everywhere today; the flag stays
 * because the shape ("some reasons need prose, some are self-describing") is
 * the thing likely to change, not the current answer to it.
 *
 * adminOnly is NOT set here. Who may close what is decided by the flag's
 * SEVERITY, not by the reason chosen — a per-reason gate would be trivially
 * sidestepped by picking a different reason for the same chat.
 */
export const REASON_CATEGORIES = [
  {
    id: 'resolved_confirmed',
    label: 'Resolved — customer confirmed',
    hint: 'The customer said in the chat that this is sorted.',
    requiresNote: true,
  },
  {
    id: 'resolved_offline',
    label: 'Resolved — handled off-channel',
    hint: 'Settled by phone or in person. Say what was agreed.',
    requiresNote: true,
  },
  {
    id: 'no_response',
    label: 'No response from customer',
    hint: `Followed up and heard nothing back for ${NO_RESPONSE_MIN_HOURS}h or more.`,
    requiresNote: true,
  },
  {
    id: 'duplicate',
    label: 'Duplicate — tracked elsewhere',
    hint: 'Reference the other chat, lead or ticket.',
    requiresNote: true,
  },
  {
    id: 'false_positive',
    label: 'Not a real issue — AI mis-flagged',
    hint: 'Say what the AI misread. These are reviewed to tune the prompt.',
    requiresNote: true,
  },
  {
    id: 'escalated',
    label: 'Escalated to a manager',
    hint: 'Name the manager who now owns it.',
    requiresNote: true,
  },
]

const BY_ID = new Map(REASON_CATEGORIES.map((c) => [c.id, c]))

export const findCategory = (id) => BY_ID.get(String(id ?? '').trim()) || null

/**
 * Validates the reason half of a dismissal.
 *
 * Returns { category, note } on success or { error } with a message meant to be
 * read by the agent — this is the copy they will see, so it says what to do,
 * not merely what is wrong.
 *
 * The note is returned TRIMMED: trailing whitespace must not count toward the
 * minimum length, or '   .   ' plus padding passes a check it plainly fails.
 */
export function validateReason(payload) {
  const category = findCategory(payload?.reason_category)
  if (!category) {
    return { error: 'Choose a reason for closing this flag.' }
  }

  const note = String(payload?.reason_note ?? '').trim()

  if (category.requiresNote && note.length < MIN_NOTE_LENGTH) {
    return {
      error: `Add a short note (at least ${MIN_NOTE_LENGTH} characters) explaining this closure.`,
    }
  }

  // An unbounded note would be a free write into an append-only table. Cut
  // rather than reject: an agent who pasted a whole thread should not lose the
  // dismissal over it, and the first 2000 characters carry the meaning.
  return { category, note: note.slice(0, 2000) }
}

/**
 * The "no response" time gate.
 *
 * `lastInboundAt` is the newest CUSTOMER message — not the newest message of
 * any kind. Measuring from the newest overall would let an agent send a reply
 * and reset the clock they are being held to, which inverts the check.
 *
 * A conversation with no inbound message at all cannot be closed for a silence
 * that was never broken, so the gate does not apply and this passes.
 */
export function checkNoResponseWindow(categoryId, lastInboundAt) {
  if (categoryId !== 'no_response') return { ok: true }
  if (!lastInboundAt) return { ok: true }

  const lastMs = new Date(lastInboundAt).getTime()
  if (!Number.isFinite(lastMs)) return { ok: true }

  const elapsedHours = (Date.now() - lastMs) / 3_600_000
  if (elapsedHours >= NO_RESPONSE_MIN_HOURS) return { ok: true }

  const remaining = Math.max(1, Math.ceil(NO_RESPONSE_MIN_HOURS - elapsedHours))
  return {
    ok: false,
    error:
      `The customer wrote less than ${NO_RESPONSE_MIN_HOURS}h ago, so this cannot be closed ` +
      `as "no response" yet — try again in about ${remaining}h, or pick a different reason.`,
  }
}
