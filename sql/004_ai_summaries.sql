-- ====================================================================
-- AI conversation summaries (AI layer, Phase 1).
-- Run this in the Supabase SQL editor. It creates ONE new table; it does
-- not touch wp_chat_messages or wp_chat_conversations.
-- ====================================================================

-- One summary row per conversation. The row is created lazily the first time
-- a summary is requested and is thereafter updated in place, so the
-- conversation id is the natural primary key (and the upsert target).
--
-- Incremental processing lives on `last_summarized_message_id`: each generation
-- records the id of the newest message it saw, and the next generation sends
-- only messages with a larger id plus the existing summary_text — the whole
-- history is never re-read. `generated_at` + that cursor together drive the
-- 6-hour refresh rule (regenerate only when the summary is stale AND newer
-- messages exist).
create table if not exists wp_chat_summaries (
  conversation_id  bigint primary key
    references wp_chat_conversations(id) on delete cascade,

  -- The model's plain-language summary.
  summary_text     text not null default '',

  -- Attention flag + its severity and reason. Kept general on purpose: a later
  -- phase adds rule-based triggers that will write the same three columns, so
  -- nothing here assumes the model was the source.
  attention_required boolean not null default false,
  attention_level    text,   -- 'management' | 'team' | 'general' (null when not flagged)
  attention_reason   text,   -- short "why", null when not flagged

  -- Incremental cursor: the newest message id folded into summary_text.
  -- Not a FK — a pruned/rolled message must not cascade-delete the summary.
  last_summarized_message_id bigint,

  -- Which model produced the current text (swappable; recorded for audit).
  model            text,

  -- A soft lease so two concurrent opens cannot fire duplicate model calls.
  -- Mirrors wp_chat_sync_jobs.lease_until: claimed with now()+TTL, released to
  -- null on every exit path.
  lease_until      timestamptz,

  generated_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint wp_chat_summaries_attention_level_chk
    check (attention_level is null or attention_level in ('management','team','general')),
  -- A flagged summary must carry a level; an unflagged one must not.
  constraint wp_chat_summaries_attention_shape_chk
    check (
      (attention_required = true  and attention_level is not null) or
      (attention_required = false and attention_level is null)
    )
);

-- A later phase (daily digest / management view) lists conversations that need
-- attention; index the flag so that scan stays cheap.
create index if not exists idx_wp_chat_summaries_attention
  on wp_chat_summaries (attention_level)
  where attention_required = true;

-- ====================================================================
-- No other schema is required. Summaries only ever READ wp_chat_messages
-- (direction, body, sender_name, created_at, id) and WRITE this table —
-- they never touch message rows, unread counts, or conversation state.
-- ====================================================================
