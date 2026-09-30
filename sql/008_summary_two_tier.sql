-- ====================================================================
-- Two-tier summaries: big (compacted memory) + short (what the panel shows),
-- plus a department classification. Migrates the Phase-1 flat summary_text.
-- Run in the Supabase SQL editor. Creates no tables. Idempotent.
-- ====================================================================

-- 1. The two summary columns. Default '' so the lazy lease-placeholder insert
--    (which sets neither) still satisfies the row.
alter table wp_chat_summaries
  add column if not exists big_summary   text not null default '',
  add column if not exists short_summary text not null default '';

-- 2. Migrate existing rows: the old flat summary becomes the SHORT summary. The
--    big summary stays empty and re-seeds from the last 30 days on the
--    conversation's NEXT activity (a dormant conversation never regenerates, so
--    a closed one simply keeps showing its migrated short summary forever).
update wp_chat_summaries
  set short_summary = summary_text
  where short_summary = ''
    and summary_text is not null
    and summary_text <> '';

-- 3. Department classification (drives auto-assignment in the next phase).
alter table wp_chat_summaries
  add column if not exists department text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wp_chat_summaries_department_chk'
  ) then
    alter table wp_chat_summaries
      add constraint wp_chat_summaries_department_chk
      check (department is null or department in ('sales', 'operations', 'unclear'));
  end if;
end $$;

-- ====================================================================
-- summary_text is now SUPERSEDED by short_summary and no longer read or written
-- by the app. It is intentionally LEFT IN PLACE so this migration is safe to run
-- before the code deploy (the old code still writes it; the new code ignores
-- it). Once the new code is live it can be dropped in a follow-up:
--     alter table wp_chat_summaries drop column if exists summary_text;
--
-- Unchanged and still used exactly as before: attention_required,
-- attention_level, attention_reason (+ their check constraints),
-- last_summarized_message_id, model, lease_until, generated_at, updated_at.
-- ====================================================================
