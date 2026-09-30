-- 017 — Undo storage for a manual attention dismissal.
--
-- wp_chat_summaries carries a CHECK constraint (attention_shape_chk) that
-- requires attention_level = NULL whenever attention_required = false. So the
-- dismiss can NOT keep the level/reason in their live columns for Undo — that
-- would violate the constraint. Instead the original values are parked in these
-- side columns while the flag is off, and restore-attention moves them back.
--
--   dismiss:  read attention_level/reason → set them NULL + attention_required
--             false (constraint satisfied) + stash the originals here.
--   restore:  move dismissed_level/reason back into attention_level/reason,
--             re-raise attention_required, and clear these.
--
-- Both are NULL whenever the conversation is not in the dismissed state.

ALTER TABLE wp_chat_summaries
  ADD COLUMN IF NOT EXISTS dismissed_level text,
  ADD COLUMN IF NOT EXISTS dismissed_reason text;
