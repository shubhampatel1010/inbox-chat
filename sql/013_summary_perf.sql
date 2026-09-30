-- ====================================================================
-- Summary read path — index for the "latest message id" probe.
--
-- The summary endpoint and refreshConversationSummary() both do:
--
--   select id from wp_chat_messages
--    where conversation_id = $1
--    order by id desc
--    limit 1;
--
-- and the incremental gather does the same shape with `and id > $cursor`.
--
-- The existing idx_wp_chat_messages_conv_time (001_message_search.sql) is
-- (conversation_id, created_at desc, id desc) — it LEADS with created_at, so an
-- `order by id desc` cannot walk it as a sorted path. Postgres has to collect
-- every row for the conversation and sort, which grows with conversation length.
-- This index makes that probe a single index-only fetch of one row.
--
-- Run this in the Supabase SQL editor.
-- ====================================================================

create index if not exists idx_wp_chat_messages_conv_id
  on wp_chat_messages (conversation_id, id desc);


-- --------------------------------------------------------------------
-- CONCURRENTLY variant — for running BY HAND on the large table.
--
-- The plain `create index` above takes an ACCESS EXCLUSIVE lock and blocks
-- writes to wp_chat_messages until it finishes; on a big table that stalls
-- inbound message ingest. CONCURRENTLY builds without blocking writes, at the
-- cost of two table passes and a longer total build.
--
-- CONCURRENTLY cannot run inside a transaction block, so run it on its own —
-- not bundled with other statements. If it fails partway it leaves an INVALID
-- index behind; drop it and retry.
--
--   create index concurrently if not exists idx_wp_chat_messages_conv_id
--     on wp_chat_messages (conversation_id, id desc);
--
-- Verify, and clean up after a failed build:
--
--   select indexrelid::regclass, indisvalid
--     from pg_index
--    where indexrelid = 'idx_wp_chat_messages_conv_id'::regclass;
--
--   -- if indisvalid = false:
--   drop index concurrently if exists idx_wp_chat_messages_conv_id;
-- --------------------------------------------------------------------
