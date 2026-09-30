-- ====================================================================
-- Inbound message de-duplication + the UNIQUE guarantee the write path
-- has ALWAYS assumed but that was never actually asserted in version
-- control.
--
-- Run this in the Supabase SQL editor. It de-duplicates existing rows and
-- then adds the unique index on whapi_message_id. It creates no tables.
--
-- WHY THIS IS NEEDED
--   Every inbound write (the live webhook AND the auto-recovery sync) does a
--   plain INSERT and treats a 23505 unique-violation on whapi_message_id as
--   "already have it, skip". That idempotency depends ENTIRELY on a unique
--   index on wp_chat_messages.whapi_message_id. The core tables predate the
--   sql/ migrations and live only in Supabase, so if that index was never
--   created (or was created non-unique), nothing dedups.
--
--   It went unnoticed while the webhook was the ONLY writer (Whapi rarely
--   re-delivers). Commit e69d975 added auto-recovery sync, which by design
--   over-fetches the recent window and relies on this same dedup — so with no
--   unique index every recovered message lands a SECOND time. Result: every
--   inbound message appears exactly twice.
-- ====================================================================


-- --------------------------------------------------------------------
-- 0. DIAGNOSE FIRST (read-only). Run these and read the output before the
--    destructive step, so you know which case you are in.
-- --------------------------------------------------------------------

-- (a) Is there already a UNIQUE index on whapi_message_id? If this returns a
--     row whose indexdef contains "UNIQUE", the constraint exists and the
--     cause is elsewhere — STOP and re-check id derivation. If it returns
--     nothing (or a non-unique index), that is the bug.
select indexname, indexdef
from pg_indexes
where tablename = 'wp_chat_messages'
  and indexdef ilike '%whapi_message_id%';

-- (b) How many message ids are duplicated, and how many rows are involved?
select count(*) as duplicated_ids,
       coalesce(sum(cnt), 0) as rows_involved,
       coalesce(sum(cnt - 1), 0) as rows_to_delete
from (
  select whapi_message_id, count(*) as cnt
  from wp_chat_messages
  where whapi_message_id is not null
  group by whapi_message_id
  having count(*) > 1
) d;

-- (c) Rows with a NULL whapi_message_id. These CANNOT be de-duplicated by that
--     key and are excluded from the fix below. If this is large, some inbound
--     messages are being written without an id — investigate separately.
select count(*) as null_whapi_id_rows
from wp_chat_messages
where whapi_message_id is null;

-- (d) Eyeball a few duplicate groups to confirm they are true duplicates
--     (same id, same body/timestamp — not two genuinely different messages).
select whapi_message_id,
       count(*)                              as copies,
       array_agg(id order by id)             as row_ids,
       min(created_at)                       as created_at,
       min(left(coalesce(body, ''), 50))     as sample
from wp_chat_messages
where whapi_message_id is not null
group by whapi_message_id
having count(*) > 1
order by count(*) desc, created_at desc
limit 20;


-- --------------------------------------------------------------------
-- 1. REMOVE EXISTING DUPLICATES.
--
-- Keep the earliest row (lowest id = the copy the webhook wrote first) for
-- each whapi_message_id, delete the rest. NULL ids are left untouched.
--
-- Optional safety: snapshot the doomed rows first so a delete can be undone.
--   create table wp_chat_messages_dupe_backup as
--   select m.* from wp_chat_messages m
--   join (
--     select id, row_number() over (partition by whapi_message_id order by id) rn
--     from wp_chat_messages where whapi_message_id is not null
--   ) r on r.id = m.id and r.rn > 1;
-- --------------------------------------------------------------------
with ranked as (
  select id,
         row_number() over (partition by whapi_message_id order by id) as rn
  from wp_chat_messages
  where whapi_message_id is not null
)
delete from wp_chat_messages m
using ranked r
where m.id = r.id
  and r.rn > 1;


-- --------------------------------------------------------------------
-- 2. ADD THE UNIQUE INDEX — the actual fix.
--
-- Partial (WHERE whapi_message_id IS NOT NULL) so any legitimately id-less row
-- is still allowed, while every real id is enforced unique. From here on, the
-- second INSERT of any message raises 23505 and the write path skips it, making
-- both the webhook and the auto-sync idempotent as they always assumed.
--
-- On a large live table, prefer the CONCURRENT form (cannot run in a
-- transaction block — run it alone, after the delete above has committed):
--
--   create unique index concurrently if not exists uq_wp_chat_messages_whapi_message_id
--     on wp_chat_messages (whapi_message_id)
--     where whapi_message_id is not null;
-- --------------------------------------------------------------------
create unique index if not exists uq_wp_chat_messages_whapi_message_id
  on wp_chat_messages (whapi_message_id)
  where whapi_message_id is not null;


-- --------------------------------------------------------------------
-- 3. VERIFY. Both should now return zero rows.
-- --------------------------------------------------------------------
select whapi_message_id, count(*)
from wp_chat_messages
where whapi_message_id is not null
group by whapi_message_id
having count(*) > 1;
