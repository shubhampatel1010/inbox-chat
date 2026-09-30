-- ====================================================================
-- 019 — Mandatory closure reason + append-only attention audit trail.
--
-- WHY. Until now clearing an attention flag was a single unexplained tap:
-- dismiss-attention wrote attention_required=false plus dismissed_at /
-- dismissed_by (migration 016) and nothing else. That records WHEN and WHO but
-- never WHY, and — because those are plain columns on wp_chat_summaries — a
-- second dismissal OVERWRITES the first. There is a current state, never a
-- history.
--
-- That matters beyond bookkeeping. summarize.js suppresses re-flagging until a
-- message arrives after dismissed_at, so a chat closed to bury a problem also
-- silences the AI that would have re-raised it; if the customer gives up and
-- never writes again, the suppression never lifts and the row stays invisible.
--
-- WHAT THIS ADDS. An append-only event log. Rows are INSERTed and never updated
-- or deleted, so the history survives however many times a conversation is
-- dismissed and restored.
--
-- WHAT THIS DELIBERATELY LEAVES ALONE. dismissed_at / dismissed_by / 
-- dismissed_level / dismissed_reason stay exactly as they are on
-- wp_chat_summaries. They are the fast current-state lookup that the
-- suppression check in summarize.js and the Undo in restore-attention both read
-- per conversation. Two different jobs — current state vs. history — so two
-- different shapes. This migration does not touch them.
--
-- Idempotent and non-destructive: a create-if-not-exists plus its indexes.
-- ====================================================================


-- --------------------------------------------------------------------
-- The event log.
--
-- account_id is denormalised from the conversation on purpose. Every admin
-- query over this table is "what happened in MY accounts" and the account
-- boundary is the one real permission boundary in the system (see
-- requireConversationAccess). Joining out to wp_chat_conversations on every
-- audit read to recover it would make the common query a join and the index
-- below useless.
--
-- actor_role is SNAPSHOT rather than joined to wp_chat_users.role for the same
-- reason the level/reason are snapshot: roles change. An agent promoted to
-- admin next year must not retroactively appear to have had admin rights when
-- they closed a chat today. A join would silently rewrite history; a snapshot
-- cannot.
--
-- actor_user_id has NO foreign key to wp_chat_users. An audit row must outlive
-- the user it names — deleting a departed employee must never cascade away the
-- record of what they closed, and ON DELETE SET NULL would be just as bad
-- (it erases exactly the accountability this table exists for).
-- --------------------------------------------------------------------
create table if not exists wp_chat_attention_events (
  id              bigserial primary key,
  conversation_id bigint      not null,
  account_id      bigint,

  -- What happened. 'dismissed' and 'restored' are the manual actions this
  -- migration's endpoints write. The set is kept open-ended for the later
  -- phases (auto-raise, reopen-on-customer-return) rather than being
  -- constrained to two values we would then have to migrate.
  action          text        not null,

  -- WHY — the point of the whole table. Structured category + free text,
  -- not free text alone: free text alone cannot be reported on, and the
  -- per-agent / per-reason breakdown is what makes this useful to a manager
  -- at volume. Both are null for a 'restored' event, which needs no reason.
  reason_category text,
  reason_note     text,

  -- The flag as it stood at the moment of the action. Snapshot, because the
  -- live columns are nulled by the dismissal itself — without this the log
  -- would record that something was cleared but not what.
  attention_level_at_time  text,
  attention_reason_at_time text,

  actor_user_id   bigint,
  actor_role      text,

  created_at      timestamptz not null default now(),

  constraint wp_chat_attention_events_action_chk
    check (action in ('dismissed', 'restored', 'auto_raised', 'reopened')),

  -- A dismissal without a reason is the exact hole this migration closes, so
  -- the database refuses one outright. The endpoint validates too (with a far
  -- better error message), but that check lives in code that can be bypassed by
  -- a direct write, a script, or a future endpoint that forgets. This one
  -- cannot. 15 chars is a deliberately low bar — enough to stop '.' and 'ok',
  -- not enough to be a sentence.
  constraint wp_chat_attention_events_reason_chk
    check (
      action <> 'dismissed'
      or (
        reason_category is not null
        and reason_note is not null
        and length(btrim(reason_note)) >= 15
      )
    )
);


-- --------------------------------------------------------------------
-- Indexes.
--
-- Two access patterns, and only two:
--   1. "the history of THIS conversation" — the per-row audit popover.
--   2. "everything in these accounts, newest first" — the admin log view and
--      the per-agent stats, always account-scoped and always date-ordered.
-- Both are covered here. No index on actor_user_id: filtering the log by agent
-- runs on top of the account+date slice, which is already small.
-- --------------------------------------------------------------------
create index if not exists idx_wp_chat_attention_events_conversation
  on wp_chat_attention_events (conversation_id, created_at desc);

create index if not exists idx_wp_chat_attention_events_account
  on wp_chat_attention_events (account_id, created_at desc);
