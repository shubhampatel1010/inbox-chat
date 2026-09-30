-- ====================================================================
-- Repair summary rows that can never fill themselves in.
--
-- Two distinct populations, both of which render as a permanent
-- "Summarizing…" spinner in the UI, because decideRefresh() treats a row with
-- neither big_summary nor short_summary as a FIRST generation — which ignores
-- the 2h refresh gate, so every open retries forever.
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- ====================================================================


-- --------------------------------------------------------------------
-- 1. Stale leases.
--
-- refreshConversationSummary() claims a lease before calling the model and
-- clears it afterwards. A run killed mid-flight (isolate torn down before the
-- model returned) leaves the lease set, which blocks the NEXT run from
-- claiming it until lease_until expires — the row returns 'generating' and
-- shows a spinner in the meantime.
--
-- LEASE_MS is 120s, so anything older than a few minutes is certainly dead.
-- --------------------------------------------------------------------
update wp_chat_summaries
   set lease_until = null
 where lease_until is not null
   and lease_until < now() - interval '5 minutes';


-- --------------------------------------------------------------------
-- 2. Rows with a good big_summary but a blank short_summary.
--
-- These came from 008_summary_two_tier.sql, which backfilled
-- `short_summary = summary_text` and left a blank wherever summary_text was
-- null. The model DID run on these (model is set, big_summary has real text) —
-- only the displayed field is missing, so there is no need to regenerate.
--
-- This mirrors exactly what ai.js does when the model returns a big summary but
-- no short one: take the first 300 characters and ellipsise.
-- --------------------------------------------------------------------
update wp_chat_summaries
   set short_summary = case
         when length(btrim(big_summary)) > 300
           then btrim(substring(btrim(big_summary) from 1 for 300)) || '…'
         else btrim(big_summary)
       end,
       updated_at = now()
 where (short_summary is null or btrim(short_summary) = '')
   and big_summary is not null
   and btrim(big_summary) <> '';


-- --------------------------------------------------------------------
-- 3. Placeholder rows that never got any model output at all.
--
-- Written by the lease-claiming INSERT (blank short AND big, model null) when
-- the generation that was meant to follow never completed. They are pure
-- residue: deleting them puts the conversation back to "no summary row", which
-- is the clean state a fresh generation starts from.
--
-- Nothing is lost — there is no summary text in these rows to lose.
-- --------------------------------------------------------------------
delete from wp_chat_summaries
 where (short_summary is null or btrim(short_summary) = '')
   and (big_summary is null or btrim(big_summary) = '')
   and model is null;


-- --------------------------------------------------------------------
-- Verify: all three should return 0.
-- --------------------------------------------------------------------
-- select count(*) as stuck_blank      from wp_chat_summaries
--  where (short_summary is null or btrim(short_summary) = '');
-- select count(*) as stale_leases     from wp_chat_summaries
--  where lease_until is not null and lease_until < now() - interval '5 minutes';
