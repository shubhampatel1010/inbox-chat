-- ====================================================================
-- EOD digest snapshots — one row per day recording which conversations were
-- flagged / pending in that evening's digest. The next day's EOD worker reads
-- the previous row to compute what got RESOLVED (present yesterday, gone today),
-- what is NEW (present today, absent yesterday) and what is STILL PENDING.
--
-- Written by the standalone EOD worker (workers/eod) AFTER the email is sent,
-- as an upsert keyed on snapshot_date. Run this in the Supabase SQL editor.
--
-- NOTE: migrations 010–011 are not present in this repo; this file keeps the
-- EOD feature's number (012) as specified. Renumber if you prefer no gap.
-- ====================================================================

create table if not exists wp_chat_eod_snapshots (
  id                       bigserial primary key,

  -- The digest's calendar day (Asia/Singapore). Unique so an upsert overwrites
  -- a same-day re-run rather than inserting a duplicate.
  snapshot_date            date not null unique,

  -- Conversation ids that appeared as flagged / pending in that day's digest.
  flagged_conversation_ids jsonb not null default '[]'::jsonb,
  pending_conversation_ids jsonb not null default '[]'::jsonb,

  created_at               timestamptz not null default now()
);
