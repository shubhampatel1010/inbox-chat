-- ====================================================================
-- 021 — Allow free-text contact type / country of origin.
-- Run in the Supabase SQL editor.
--
-- The New message form now has an "Other" option in both dropdowns that
-- stores whatever the user types (e.g. 'Driver', 'Nepal'). Some databases
-- carry a check constraint on contact_type created outside this app
-- (wp_conv_contact_type_check) that only allows a fixed list, which rejects
-- those rows. Values are validated in /api/conversations/new instead.
--
-- Drops every CHECK constraint on wp_chat_conversations that references
-- contact_type or country_of_origin, whatever it is named.
-- Idempotent and non-destructive (no data is changed).
-- ====================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'wp_chat_conversations'
      and con.contype = 'c'
      and (
        pg_get_constraintdef(con.oid) ilike '%contact_type%'
        or pg_get_constraintdef(con.oid) ilike '%country_of_origin%'
      )
  loop
    execute format('alter table wp_chat_conversations drop constraint %I', c.conname);
    raise notice 'Dropped constraint %', c.conname;
  end loop;
end $$;
