-- 016 — Manual attention dismissal.
--
-- Agents sometimes resolve an issue off-channel (a phone call, in person), so
-- the AI never sees a resolving message and the attention flag lingers. This
-- lets a signed-in user clear the flag by hand.
--
-- Two columns record the dismissal so a later regenerate can tell "the agent
-- already handled this" from "a genuinely new issue arrived":
--   dismissed_at — when the flag was manually cleared (NULL = never dismissed).
--   dismissed_by — the wp_chat_users.id who cleared it (for audit; nullable).
--
-- The dismiss itself is a plain UPDATE the endpoint runs:
--   attention_required=false, attention_level=null, attention_reason=null,
--   dismissed_at=now(), dismissed_by=<user>.
-- summarize.js then suppresses re-flagging until a message arrives AFTER
-- dismissed_at. No new index is needed: every read is already by conversation_id
-- (the primary lookup) and the existing partial index on attention_required
-- keeps the flagged-set queries (list + EOD) small.

ALTER TABLE wp_chat_summaries
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by bigint;
