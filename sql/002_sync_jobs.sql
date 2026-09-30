-- ====================================================================
-- Backfill / missed-message sync jobs.
-- Run this in the Supabase SQL editor. It creates ONE new table; it does
-- not touch wp_chat_messages or wp_chat_conversations.
-- ====================================================================

-- A sync job is a resumable, client-driven cursor over Whapi history. The
-- admin UI creates one row, then repeatedly POSTs /api/sync/step; each step
-- does one bounded unit of work and advances `cursor`. Progress lives here so
-- the UI can poll it and a page reload can resume.
create table if not exists wp_chat_sync_jobs (
  id             bigint generated always as identity primary key,

  -- pending -> running -> done | failed | canceled
  status         text not null default 'pending',

  -- What to sync. One of:
  --   { "type": "conversation", "conversation_id": 42 }
  --   { "type": "range", "from": "2026-04-01", "to": "2026-07-01" }   (dates inclusive)
  scope          jsonb not null,

  -- Opaque resume state, shaped by functions/_lib/sync.js. Never read by SQL.
  cursor         jsonb not null default '{}'::jsonb,

  -- Live counters, updated every step.
  conversations_done  integer not null default 0,
  messages_added      integer not null default 0,
  media_failed        integer not null default 0,

  -- Per-chat failures worth surfacing in the result, e.g. an expired chat.
  -- [{ "chat": "…", "error": "…" }]
  errors         jsonb not null default '[]'::jsonb,

  -- A soft lease so two concurrent step calls cannot double-drive one job.
  lease_until    timestamptz,

  created_by     bigint,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);

-- The admin UI lists recent jobs newest-first.
create index if not exists idx_wp_chat_sync_jobs_created
  on wp_chat_sync_jobs (created_at desc);

-- ====================================================================
-- No other schema is required.
--
--   * Dedup is on wp_chat_messages.whapi_message_id, which is ALREADY unique —
--     a synced message that is already present hits that constraint and is
--     skipped, never written twice.
--   * Media reuses the existing media_* columns and the same fetch-and-store
--     pipeline as live inbound.
--   * Links are extracted at query time; nothing is stored for them.
-- ====================================================================
