// The closure-reason vocabulary as the sheet renders it.
//
// A MIRROR of functions/_lib/attention-reasons.js, which is authoritative. It
// cannot simply be imported: that module ships to the Cloudflare Worker and
// this one to the browser bundle, and the two build graphs do not cross.
//
// If they ever drift, the server wins — the sheet would offer a category the
// endpoint rejects, and the agent sees the server's error rather than a silent
// bad write. Keeping the ids identical is what matters; the labels and hints
// here are presentation and have no server counterpart to disagree with.

/** Mirrors MIN_NOTE_LENGTH server-side. Used to enable the submit button. */
export const MIN_NOTE_LENGTH = 15

export const NO_RESPONSE_MIN_HOURS = 24

export const REASON_CATEGORIES = [
  {
    id: 'resolved_confirmed',
    label: 'Resolved — customer confirmed',
    hint: 'The customer said in the chat that this is sorted.',
  },
  {
    id: 'resolved_offline',
    label: 'Resolved — handled off-channel',
    hint: 'Settled by phone or in person. Say what was agreed.',
  },
  {
    id: 'no_response',
    label: 'No response from customer',
    hint: `Followed up and heard nothing back for ${NO_RESPONSE_MIN_HOURS}h or more.`,
  },
  {
    id: 'duplicate',
    label: 'Duplicate — tracked elsewhere',
    hint: 'Reference the other chat, lead or ticket.',
  },
  {
    id: 'false_positive',
    label: 'Not a real issue — AI mis-flagged',
    hint: 'Say what the AI misread. These are reviewed to tune the prompt.',
  },
  {
    id: 'escalated',
    label: 'Escalated to a manager',
    hint: 'Name the manager who now owns it.',
  },
]

/**
 * Whether the sheet may be submitted. The server re-checks all of this — this
 * exists to disable the button rather than to be trusted.
 */
export const isReasonComplete = (categoryId, note) =>
  Boolean(categoryId) && String(note ?? '').trim().length >= MIN_NOTE_LENGTH
