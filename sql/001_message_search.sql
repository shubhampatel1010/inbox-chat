-- ====================================================================
-- Message search across all conversations.
-- Run this in the Supabase SQL editor. Nothing here creates a table.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Trigram extension.
--
-- Chosen over Postgres full-text search deliberately. See the note at
-- the bottom of this file for the reasoning.
-- --------------------------------------------------------------------
create extension if not exists pg_trgm;


-- --------------------------------------------------------------------
-- 2. One generated column holding everything that is searchable.
--
-- Searching three columns with three OR'd ILIKEs means the planner has
-- to union three index scans. Concatenating first means ONE predicate
-- and ONE index. The column is STORED, so it is maintained by Postgres
-- on every insert/update — the application never writes to it and can
-- never let it drift.
--
-- All three inputs are immutable expressions, which a generated column
-- requires.
-- --------------------------------------------------------------------
alter table wp_chat_messages
  add column if not exists search_text text
  generated always as (
    coalesce(body, '') || ' ' ||
    coalesce(media_caption, '') || ' ' ||
    coalesce(sender_name, '')
  ) stored;


-- --------------------------------------------------------------------
-- 3. Trigram GIN index.
--
-- gin_trgm_ops supports LIKE / ILIKE with leading wildcards, which is
-- what substring search requires and what a tsvector index cannot do.
--
-- Build it CONCURRENTLY if the table is live and large — that form
-- cannot run inside a transaction block, so run it as its own
-- statement, on its own, with nothing selected around it:
--
--   create index concurrently if not exists idx_wp_chat_messages_search
--     on wp_chat_messages using gin (search_text gin_trgm_ops);
--
-- The non-concurrent form below is fine on the current data volume.
-- --------------------------------------------------------------------
create index if not exists idx_wp_chat_messages_search
  on wp_chat_messages using gin (search_text gin_trgm_ops);


-- --------------------------------------------------------------------
-- 4. Ordering index for BOTH search results and thread windowing.
--
-- Every message read now orders by (created_at, id) — search results
-- newest-first, and thread pages walking outward from an anchor. The id
-- tiebreak is not cosmetic: the planned three-month backfill will insert
-- OLD messages with HIGH ids, so id order and time order will disagree.
-- Ordering on the tuple is what keeps paging stable once that lands.
-- --------------------------------------------------------------------
create index if not exists idx_wp_chat_messages_conv_time
  on wp_chat_messages (conversation_id, created_at desc, id desc);


-- --------------------------------------------------------------------
-- 5. Scoping index.
--
-- Agents may only search conversations assigned to them, so the search
-- endpoint first resolves their conversation ids.
-- --------------------------------------------------------------------
create index if not exists idx_wp_chat_conversations_assigned
  on wp_chat_conversations (assigned_user_id);


-- ====================================================================
-- WHY TRIGRAM AND NOT FULL-TEXT SEARCH
-- ====================================================================
--
-- Two properties of this data rule tsvector out.
--
-- 1. Chinese and Burmese are not whitespace-delimited.
--    to_tsvector splits on whitespace and punctuation. A Chinese or
--    Burmese sentence contains neither, so the WHOLE SENTENCE becomes a
--    single lexeme. Searching for a word inside it then matches nothing
--    at all. This is not a tuning problem — no built-in text search
--    configuration segments these scripts. Doing it properly needs a
--    dictionary extension (pg_jieba, zhparser) that Supabase does not
--    offer, and it would still only cover Chinese.
--
-- 2. Users search substrings, not words.
--    tsvector matches whole lexemes. Prefixes work (to_tsquery 'foo:*'),
--    infixes do not — searching "voice" would never find "invoiced".
--
-- A single 'simple' configuration would fix neither of these. Trigram
-- indexing sidesteps both: it indexes overlapping 3-character sequences
-- with no notion of a word, so it is language-agnostic by construction
-- and matches anywhere in the string.
--
-- The cost is honest and worth stating:
--
--   * The index is large — roughly 3-5x the size of the indexed text.
--     At 100k messages averaging ~120 characters that is ~12MB of text
--     and a ~40-60MB index. Comfortable.
--
--   * Queries SHORTER THAN 3 CHARACTERS CANNOT USE THE INDEX. pg_trgm
--     pads word boundaries, so a 2-character Latin word still yields
--     trigrams — but a 2-character CJK query bounded by other CJK
--     characters yields none, and Postgres falls back to a sequential
--     scan. Two-character queries are common in Chinese. The endpoint
--     therefore enforces a 2-character minimum and the 100k-row
--     sequential-scan cost is documented in the report rather than
--     hidden. If this becomes a real complaint, the fix is a second
--     index using bigrams, not a switch to FTS.
--
--   * Ranking is by recency, not relevance. There is no ts_rank
--     equivalent that is meaningful across these scripts, and for an
--     inbox "the most recent message containing this" is what an agent
--     actually wants.
