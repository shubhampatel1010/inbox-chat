-- ====================================================================
-- Auto-assignment (Phase 2): creation-source flag + persistent, atomic
-- round-robin rotation. Run in the Supabase SQL editor. Does not touch
-- messages, summaries, or existing assignment.
-- ====================================================================

-- 1. CREATION SOURCE — how the conversation row was created. This is the signal
--    that distinguishes the two assignment paths:
--      'webhook' -> a LIVE inbound message (fresh lead)  -> assigned to sales at creation
--      'sync'    -> the backfill / auto-sync recovery     -> assigned by AI department later
--    Set exactly once at INSERT by the creating code path and never changed, so
--    it is a reliable, immutable signal. Existing rows are null (pre-feature) and
--    are intentionally NOT eligible for department auto-assignment.
alter table wp_chat_conversations
  add column if not exists created_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wp_chat_conversations_created_source_chk') then
    alter table wp_chat_conversations
      add constraint wp_chat_conversations_created_source_chk
      check (created_source is null or created_source in ('webhook', 'sync'));
  end if;
end $$;


-- 2. ROTATION STATE — one monotonic cursor per department, persisted so it
--    survives restarts and never resets to agent A. The agent is chosen as
--    active_agents[cursor % count], so the rotation adapts to the current roster.
create table if not exists wp_chat_assign_rotation (
  department  text primary key,
  cursor      bigint not null default 0,
  updated_at  timestamptz not null default now()
);


-- 3. ATOMIC INCREMENT — returns the next cursor for a department. The
--    INSERT ... ON CONFLICT DO UPDATE locks the department row, so two
--    conversations created at the same instant receive DISTINCT cursors and
--    therefore DISTINCT agents — they can never both grab agent A. Self-seeding:
--    the first call inserts cursor 0 and returns 0; each later call returns the
--    incremented value (1, 2, 3, …).
create or replace function wp_chat_next_rotation(p_department text)
returns bigint
language sql
as $$
  insert into wp_chat_assign_rotation (department, cursor)
  values (p_department, 0)
  on conflict (department)
  do update set cursor = wp_chat_assign_rotation.cursor + 1,
                updated_at = now()
  returning cursor;
$$;

-- The app calls this with the Supabase service role.
grant execute on function wp_chat_next_rotation(text) to service_role;
