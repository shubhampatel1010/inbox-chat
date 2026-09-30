-- ====================================================================
-- Channel state — the single row that lets the 60s status poll detect a
-- disconnect gap and auto-recover it. Run this in the Supabase SQL editor.
--
-- NOTE: earlier work referenced wp_chat_channel_state (functions/_lib/
-- channel-monitor.js) but no migration for it was ever committed. This is
-- that migration, plus the two columns auto-recovery needs. If the table
-- somehow already exists, the ADD COLUMN statements are idempotent.
-- ====================================================================

create table if not exists wp_chat_channel_state (
  id           bigint generated always as identity primary key,

  -- Single logical row; everything keys on 'channel'.
  key          text not null unique,

  -- Last observed health.
  connected    boolean,
  status       text,
  checked_at   timestamptz,

  -- When connected/disconnected last flipped.
  changed_at   timestamptz,

  -- Start of the CURRENT unrecovered gap. Set the moment a connected->
  -- disconnected transition is observed (to the last-known-good poll time),
  -- cleared once the reconnect has created a recovery job.
  gap_started_at timestamptz,

  -- Set on an account-level Whapi error (e.g. 402 quota) seen during an
  -- auto-recovery. While non-null, no new auto-sync is started — an auto-sync
  -- that retried a quota failure on every poll would be worse than none. An
  -- admin clears it by starting a manual sync (or the explicit Clear action).
  auto_halted_reason text,

  updated_at   timestamptz not null default now()
);

-- Columns are added defensively in case an older wp_chat_channel_state exists.
alter table wp_chat_channel_state add column if not exists gap_started_at    timestamptz;
alter table wp_chat_channel_state add column if not exists auto_halted_reason text;

-- ====================================================================
-- No change to wp_chat_sync_jobs. Auto-recoveries are ordinary sync jobs:
--   scope = { "type": "auto", "from_ts": <unix>, "to_ts": <unix>, "gap_seconds": N }
-- and status 'deferred' for a gap too long to auto-run. Both are plain values
-- in the existing jsonb/text columns — no schema change, no new status CHECK
-- (the status column has none).
-- ====================================================================
