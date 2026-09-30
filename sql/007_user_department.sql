-- ====================================================================
-- Department on users — foundation for AI department-based auto-assignment.
-- Run in the Supabase SQL editor. Adds ONE nullable column + a check.
--
-- Values: 'sales' | 'operations' | null.
--   * Admins have NO department (null) — they don't belong to one.
--   * Agents SHOULD have a department, but the column is nullable so existing
--     agents are not broken; a department-less agent simply won't receive
--     auto-assignments later.
-- ====================================================================

-- 1. The nullable column.
alter table wp_chat_users
  add column if not exists department text;

-- 2. Allowed values, plus the invariant that admins never carry a department.
--    Idempotent: only added if it isn't already present.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wp_chat_users_department_chk'
  ) then
    alter table wp_chat_users
      add constraint wp_chat_users_department_chk
      check (
        (department is null or department in ('sales', 'operations'))
        and (role <> 'admin' or department is null)
      );
  end if;
end $$;
