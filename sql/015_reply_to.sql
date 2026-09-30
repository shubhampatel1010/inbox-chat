-- ====================================================================
-- Quoted replies — WhatsApp-style "reply to a specific message".
--
-- Two columns, because the message being quoted may or may not exist in
-- our database:
--
--   reply_to_message_id  our own row id, when we can resolve the quoted
--                        message. This is the one the read path joins on
--                        to render the quoted block.
--
--   reply_to_whapi_id    Whapi's id for the quoted message, stored
--                        unconditionally. It is what an outbound send has
--                        to hand Whapi (their API quotes by THEIR id, not
--                        ours), and for inbound it preserves the reference
--                        when the original predates our backfill — the
--                        thread then renders "Original message" rather
--                        than silently dropping the quote.
--
-- Both are nullable: the overwhelming majority of messages are not replies.
-- ====================================================================

alter table wp_chat_messages
  add column if not exists reply_to_message_id bigint
    references wp_chat_messages(id) on delete set null,
  add column if not exists reply_to_whapi_id text;


-- --------------------------------------------------------------------
-- on delete set null, not cascade.
--
-- Deleting a quoted message must not delete the replies to it — that
-- would remove conversation the agent wrote. Nulling the pointer leaves
-- the reply intact; reply_to_whapi_id survives, so the thread still shows
-- the quote block in its "original not available" form.
-- --------------------------------------------------------------------


-- --------------------------------------------------------------------
-- Read-path index.
--
-- GET /api/messages resolves quoted messages with a single
--   ... where id in (<reply_to_message_id list>)
-- over the page it just fetched, so the lookup rides the primary key.
--
-- This index serves the other direction: finding the replies that point
-- AT a row. The FK's on-delete action needs it (without it, every delete
-- from wp_chat_messages sequentially scans the table to find referencing
-- rows), and it is partial so it costs nothing for the non-reply majority.
-- --------------------------------------------------------------------
create index if not exists wp_chat_messages_reply_to_idx
  on wp_chat_messages (reply_to_message_id)
  where reply_to_message_id is not null;


-- --------------------------------------------------------------------
-- Inbound resolution index.
--
-- The webhook maps Whapi's context.quoted_id onto our row by
--   select id from wp_chat_messages where whapi_message_id = $1
-- on every inbound reply. Cheap to add here; skipped if an equivalent
-- index already exists from the dedup work in 005/006.
-- --------------------------------------------------------------------
create index if not exists wp_chat_messages_whapi_message_id_idx
  on wp_chat_messages (whapi_message_id)
  where whapi_message_id is not null;


-- --------------------------------------------------------------------
-- Verify.
-- --------------------------------------------------------------------
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'wp_chat_messages'
--    and column_name in ('reply_to_message_id', 'reply_to_whapi_id');
