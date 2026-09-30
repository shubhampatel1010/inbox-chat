-- ====================================================================
-- 020 — Contact type + country of origin on conversations.
-- Run in the Supabase SQL editor.
--
-- Captured by the New message form (name, type and country are all required
-- there). Both columns are nullable so conversations created by the inbound
-- webhook, and every existing row, stay valid.
--
-- contact_type: 'employer' | 'caregiver' | 'recruiter' | 'client_partner' | 'staff'
-- country_of_origin: ISO 3166-1 alpha-2 code, or 'OTHER'.
--
-- No check constraints. contact_type already existed on some databases,
-- populated from outside this app with values not in the list above, so a
-- check would reject those rows (and any future writes from that source).
-- The allowed values are enforced by /api/conversations/new against
-- functions/_lib/contactMeta.js instead.
--
-- Idempotent and non-destructive.
-- ====================================================================

alter table wp_chat_conversations
  add column if not exists contact_type text,
  add column if not exists country_of_origin text;

-- In case an earlier run of this file got as far as adding it.
alter table wp_chat_conversations
  drop constraint if exists wp_chat_conversations_contact_type_chk;
