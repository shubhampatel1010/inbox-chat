-- ====================================================================
-- Dedup on the STABLE message identity, not the full whapi_message_id.
-- Run in the Supabase SQL editor. Creates no tables. Read the diagnostics
-- (step 0) before running the destructive/DDL steps.
--
-- WHY
--   The same message arrives from different sources — the live webhook vs the
--   auto-sync recovery — with whapi_message_ids that share an identical prefix
--   but differ in the token AFTER THE LAST "-":
--       webhook:   PrCrjNSSH73XgIY-wCESb8Ya2w
--       auto-sync: PrCrjNSSH73XgIY-<different suffix>
--   The unique index on the FULL id (sql/005) does not catch this, so every
--   auto-sync recovery re-duplicates. The stable identity is everything BEFORE
--   THE LAST "-".
--
-- FORMAT ANALYSIS (whole table, 4,747 non-null ids)
--   Shapes: <core>-<suffix> (1 dash) and <core>-<mid>-<suffix> (2 dashes);
--   suffix is a short session/routing token. Grouping by the before-last-dash
--   substring yields 4,747 distinct identities for 4,747 rows — i.e. it is
--   PERFECTLY UNIQUE, zero collisions. No two genuinely different messages share
--   it, so enforcing uniqueness on it is safe. (Before-first-dash is also
--   collision-free, but before-last-dash matches the observed vary-only-the-
--   last-token pattern and strips the least, so it is the conservative choice.)
--
-- IDENTITY EXPRESSION (used identically in SQL and in the test):
--   regexp_replace(whapi_message_id, '-[^-]*$', '')
--   → strips the final "-<token>"; ids with no "-" are returned unchanged.
-- ====================================================================


-- --------------------------------------------------------------------
-- 0. DIAGNOSE (read-only). Confirm the identity is collision-free HERE too
--    before you change anything. non_null_ids should equal distinct_identities.
-- --------------------------------------------------------------------
select
  count(*)                                                        as non_null_ids,
  count(distinct regexp_replace(whapi_message_id, '-[^-]*$', '')) as distinct_identities
from wp_chat_messages
where whapi_message_id is not null;

-- Any identity carried by more than one row (expected: none, post-cleanup):
select regexp_replace(whapi_message_id, '-[^-]*$', '') as identity, count(*) as rows
from wp_chat_messages
where whapi_message_id is not null
group by 1
having count(*) > 1
order by rows desc
limit 50;


-- --------------------------------------------------------------------
-- 1. SAFETY DEDUP — a no-op if the query above returned nothing. Keeps the
--    earliest row (lowest id) per stable identity, deletes the rest. This
--    guarantees the unique index in step 3 can be built.
-- --------------------------------------------------------------------
with ranked as (
  select id,
         row_number() over (
           partition by regexp_replace(whapi_message_id, '-[^-]*$', '')
           order by id
         ) as rn
  from wp_chat_messages
  where whapi_message_id is not null
)
delete from wp_chat_messages m
using ranked r
where m.id = r.id
  and r.rn > 1;


-- --------------------------------------------------------------------
-- 2. STABLE-IDENTITY column, computed by the DATABASE.
--
--    Generated + STORED, so it is ALWAYS populated no matter which writer
--    inserts and can never drift out of sync with the code — there is no
--    deploy-ordering gap where a new row could slip in un-deduped. All three
--    writers (webhook, backfill, auto-sync) insert whapi_message_id exactly as
--    today; Postgres derives this column and the unique index (step 3) rejects
--    the second copy, which every writer already catches as 23505 and skips.
--    (The table is small; the add-column rewrite is instant here.)
-- --------------------------------------------------------------------
alter table wp_chat_messages
  add column if not exists whapi_dedup_id text
  generated always as (regexp_replace(whapi_message_id, '-[^-]*$', '')) stored;


-- --------------------------------------------------------------------
-- 3. Move the UNIQUE guarantee from the full id to the stable identity.
--    (Keeps the whapi_message_id column itself; only its unique index is
--    dropped. The new index still catches exact-duplicate full ids too, since
--    identical ids share an identical stable identity.)
--
--    On a large live table prefer the CONCURRENT form (cannot run in a txn
--    block — run it alone, after step 1 has committed):
--      create unique index concurrently if not exists uq_wp_chat_messages_whapi_dedup_id
--        on wp_chat_messages (whapi_dedup_id) where whapi_dedup_id is not null;
-- --------------------------------------------------------------------
drop index if exists uq_wp_chat_messages_whapi_message_id;

create unique index if not exists uq_wp_chat_messages_whapi_dedup_id
  on wp_chat_messages (whapi_dedup_id)
  where whapi_dedup_id is not null;


-- --------------------------------------------------------------------
-- 4. VERIFY — should return no rows.
-- --------------------------------------------------------------------
select whapi_dedup_id, count(*)
from wp_chat_messages
where whapi_dedup_id is not null
group by 1
having count(*) > 1;
