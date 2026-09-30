-- ====================================================================
-- 018 — Multi-account / multi-number support.
--
-- Turns the single-tenant inbox into an N-account one. Every account owns its
-- own Whapi channel (token, API url, webhook secret, business number) and its
-- own conversations, sync jobs and channel state. Users are granted access to
-- accounts through a membership table.
--
-- Run this in the Supabase SQL editor. It is idempotent and NON-DESTRUCTIVE:
-- the existing deployment's data is adopted by a single seeded "default"
-- account (id 1), so nothing changes behaviourally until a second account is
-- created.
--
-- WHAT STAYS SYSTEM-WIDE (never per-account):
--   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
--   (plus JWT_SECRET and the VAPID_* keys, which are properties of THIS
--   deployment and this browser-push identity, not of a WhatsApp account).
-- ====================================================================


-- --------------------------------------------------------------------
-- 1. THE ACCOUNTS TABLE.
--
-- Secrets (whapi_token, webhook_secret) are stored ENCRYPTED — AES-GCM,
-- performed in the Worker with ENCRYPTION_KEY, see functions/_lib/crypto.js.
-- They are ciphertext to Postgres, so a DB leak does not surrender a live
-- WhatsApp channel, and they are never returned to the browser in plaintext.
-- --------------------------------------------------------------------
create table if not exists wp_chat_accounts (
  id             bigint generated always as identity primary key,

  -- What the admin and the agents see on a chat row, e.g. "Acme Singapore".
  name           text not null,

  -- The WhatsApp business number this account sends from, digits only.
  -- Nullable so an account can be created BEFORE its channel is connected.
  business_number text,

  -- Per-account Whapi channel credentials.
  --   whapi_token_enc : AES-GCM ciphertext (never plaintext).
  --   whapi_api_url   : not a secret; defaults to gate.whapi.cloud when null.
  whapi_token_enc  text,
  whapi_api_url    text,

  -- Per-account webhook. `webhook_secret_hash` is the SHA-256 hex of the
  -- secret and is what the inbound route looks the account up by — an indexed
  -- equality lookup, so routing does not scan-and-compare every account.
  -- `webhook_secret_enc` keeps the secret recoverable so the admin can re-read
  -- the URL to paste into Whapi; it is never used for routing.
  webhook_secret_hash text,
  webhook_secret_enc  text,

  -- Soft delete. An inactive account keeps its history but stops syncing,
  -- stops accepting webhooks and disappears from the pickers.
  is_active      boolean not null default true,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Routing lookup: the webhook resolves an account from the hash in one hit.
create unique index if not exists idx_wp_chat_accounts_secret_hash
  on wp_chat_accounts (webhook_secret_hash)
  where webhook_secret_hash is not null;

-- Two accounts must never claim the same WhatsApp number.
create unique index if not exists idx_wp_chat_accounts_business_number
  on wp_chat_accounts (business_number)
  where business_number is not null;


-- --------------------------------------------------------------------
-- 2. SEED THE DEFAULT ACCOUNT — this is what preserves the existing install.
--
-- Every row that exists today belongs to the one channel configured in env, so
-- it is adopted by account id 1. Credentials are left NULL on purpose: with no
-- per-account credentials stored, the code falls back to the environment
-- variables exactly as it does today (see functions/_lib/accounts.js). So an
-- untouched deployment keeps working with zero configuration, and the admin can
-- migrate it into the DB later at their leisure.
--
-- Guarded so re-running never inserts a second default.
-- --------------------------------------------------------------------
insert into wp_chat_accounts (name, is_active)
select 'Default', true
where not exists (select 1 from wp_chat_accounts);


-- --------------------------------------------------------------------
-- 3. ACCOUNT COLUMNS ON THE EXISTING TABLES.
--
-- Added nullable, backfilled to the default account, and only THEN made NOT
-- NULL where that is safe. A nullable-first add is what keeps this runnable on
-- a live table without a rewrite lock stalling the app.
-- --------------------------------------------------------------------
alter table wp_chat_conversations add column if not exists account_id bigint;
alter table wp_chat_sync_jobs     add column if not exists account_id bigint;
alter table wp_chat_channel_state add column if not exists account_id bigint;

-- Backfill: everything that predates multi-account belongs to the default.
update wp_chat_conversations set account_id = (select min(id) from wp_chat_accounts) where account_id is null;
update wp_chat_sync_jobs     set account_id = (select min(id) from wp_chat_accounts) where account_id is null;
update wp_chat_channel_state set account_id = (select min(id) from wp_chat_accounts) where account_id is null;

-- Conversations must always carry an account — every read path scopes by it.
-- (sync_jobs / channel_state stay nullable-tolerant; their code defaults.)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'wp_chat_conversations'
      and column_name = 'account_id'
      and is_nullable = 'NO'
  ) and not exists (
    select 1 from wp_chat_conversations where account_id is null
  ) then
    alter table wp_chat_conversations alter column account_id set not null;
  end if;
end $$;

-- Foreign keys. Conversations are RESTRICTed: deleting an account with chats
-- must fail loudly rather than silently destroying history.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wp_chat_conversations_account_fk') then
    alter table wp_chat_conversations
      add constraint wp_chat_conversations_account_fk
      foreign key (account_id) references wp_chat_accounts (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wp_chat_sync_jobs_account_fk') then
    alter table wp_chat_sync_jobs
      add constraint wp_chat_sync_jobs_account_fk
      foreign key (account_id) references wp_chat_accounts (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wp_chat_channel_state_account_fk') then
    alter table wp_chat_channel_state
      add constraint wp_chat_channel_state_account_fk
      foreign key (account_id) references wp_chat_accounts (id) on delete cascade;
  end if;
end $$;

-- The inbox lists an account's chats newest-first; this is that access path.
create index if not exists idx_wp_chat_conversations_account
  on wp_chat_conversations (account_id, last_message_at desc nulls last);

create index if not exists idx_wp_chat_sync_jobs_account
  on wp_chat_sync_jobs (account_id, created_at desc);


-- --------------------------------------------------------------------
-- 4. RE-SCOPE THE IDENTITY UNIQUES — the subtle, important part.
--
-- Today customer_number and group_jid are globally unique, which encodes the
-- single-account assumption: one customer = one conversation, full stop. With
-- two accounts that is WRONG — if the same customer messages Acme and Globex,
-- both channels' messages would be forced into ONE conversation row, mixing two
-- companies' chats together. The uniqueness must be per (account, identity).
--
-- The old global indexes are dropped and replaced with composite ones. Dedup is
-- unaffected: message-level dedup keys on wp_chat_messages.whapi_message_id
-- (see 005/006), not on these.
--
-- The DROPs are written defensively — these indexes were created by hand in
-- Supabase long before sql/ existed, so their names vary between installs. This
-- block finds them by their SHAPE (unique, single column, on this table) rather
-- than trusting a name, and leaves anything composite alone.
-- --------------------------------------------------------------------
do $$
declare
  idx record;
begin
  for idx in
    select i.relname as name
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
    where t.relname = 'wp_chat_conversations'
      and x.indisunique
      -- indnkeyatts, NOT indnatts: the latter counts INCLUDE'd columns too, so
      -- a covering index would be misread as multi-column and skipped.
      and x.indnkeyatts = 1
      and not x.indisprimary
      and a.attname in ('customer_number', 'group_jid')
  loop
    -- A unique CONSTRAINT owns its index, so the constraint must go first;
    -- fall back to dropping a bare index when there is no constraint.
    begin
      execute format('alter table wp_chat_conversations drop constraint %I', idx.name);
    exception when undefined_object then
      execute format('drop index if exists %I', idx.name);
    end;
  end loop;
end $$;

-- The replacements: identity is unique WITHIN an account, not across accounts.
-- Partial, because customer_number is null on groups and group_jid is null on
-- 1:1 chats — and in Postgres many nulls would otherwise each count as distinct
-- anyway; being explicit keeps the indexes small and the intent legible.
create unique index if not exists idx_wp_chat_conversations_account_customer
  on wp_chat_conversations (account_id, customer_number)
  where customer_number is not null;

create unique index if not exists idx_wp_chat_conversations_account_group
  on wp_chat_conversations (account_id, group_jid)
  where group_jid is not null;


-- --------------------------------------------------------------------
-- 5. CHANNEL STATE — one row PER ACCOUNT, not one row globally.
--
-- channel-gap.js keyed a single row on key='channel'. With N accounts, account
-- B's disconnect would overwrite account A's state and the reconnect would
-- create a recovery job against the wrong channel. The unique key becomes
-- (account_id, key); the code now writes key = 'channel' per account row.
-- --------------------------------------------------------------------
do $$
declare
  idx record;
begin
  for idx in
    select i.relname as name
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
    where t.relname = 'wp_chat_channel_state'
      and x.indisunique
      and x.indnkeyatts = 1
      and not x.indisprimary
      and a.attname = 'key'
  loop
    begin
      execute format('alter table wp_chat_channel_state drop constraint %I', idx.name);
    exception when undefined_object then
      execute format('drop index if exists %I', idx.name);
    end;
  end loop;
end $$;

create unique index if not exists idx_wp_chat_channel_state_account_key
  on wp_chat_channel_state (account_id, key);


-- --------------------------------------------------------------------
-- 6. USER → ACCOUNT MEMBERSHIP.
--
-- Which accounts a user may see. Admins are NOT listed here — an admin sees
-- every account by role (mirroring how role already works elsewhere), so
-- granting an admin implicit access avoids a membership row that could be
-- forgotten and lock the admin out of a new account.
--
-- An agent with NO rows here sees nothing. That would be a silent regression
-- for the existing install, so section 7 backfills every current user into the
-- default account.
-- --------------------------------------------------------------------
create table if not exists wp_chat_user_accounts (
  user_id     bigint not null references wp_chat_users (id) on delete cascade,
  account_id  bigint not null references wp_chat_accounts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, account_id)
);

-- "Which users are on this account?" for the admin's assignment UI.
create index if not exists idx_wp_chat_user_accounts_account
  on wp_chat_user_accounts (account_id);


-- --------------------------------------------------------------------
-- 7. BACKFILL MEMBERSHIP — preserves access for everyone who has it today.
--
-- Every existing user currently sees every conversation, and all of those now
-- belong to the default account. Granting each user membership of the default
-- account keeps that exactly true. Only the default (lowest-id) account is
-- granted, so a NEW account starts private until the admin assigns people.
-- --------------------------------------------------------------------
insert into wp_chat_user_accounts (user_id, account_id)
select u.id, (select min(id) from wp_chat_accounts)
from wp_chat_users u
on conflict (user_id, account_id) do nothing;


-- --------------------------------------------------------------------
-- 8. ROUND-ROBIN ROTATION, PER ACCOUNT.
--
-- wp_chat_assign_rotation (009) has `department` as its primary key, so the
-- sales rotation is shared across every account. Two accounts' new chats would
-- advance one cursor and interleave, which is not what "round-robin within this
-- account's sales team" means. The key becomes (account_id, department).
--
-- Rebuilt rather than altered: the table holds only a cursor position, so
-- recreating it costs nothing but a rotation restart, and ALTERing a primary
-- key in place is far more fragile.
-- --------------------------------------------------------------------
alter table wp_chat_assign_rotation add column if not exists account_id bigint;

update wp_chat_assign_rotation
set account_id = (select min(id) from wp_chat_accounts)
where account_id is null;

do $$
begin
  -- Only rebuild when the primary key is still the single-column (department)
  -- one. Re-running after the upgrade finds a 2-column key and does nothing.
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'wp_chat_assign_rotation'
      and c.contype = 'p'
      and array_length(c.conkey, 1) = 2
  ) then
    alter table wp_chat_assign_rotation drop constraint if exists wp_chat_assign_rotation_pkey;
    alter table wp_chat_assign_rotation
      add constraint wp_chat_assign_rotation_pkey primary key (account_id, department);
  end if;
end $$;

-- The atomic per-(account, department) cursor. Same contract as 009's function:
-- the INSERT ... ON CONFLICT DO UPDATE locks the row, so two conversations
-- created in the same instant get DISTINCT cursors and therefore DISTINCT
-- agents. 009's single-argument version is left in place so an older deploy
-- mid-rollout keeps working.
create or replace function wp_chat_next_rotation_account(p_account_id bigint, p_department text)
returns bigint
language sql
as $$
  insert into wp_chat_assign_rotation (account_id, department, cursor)
  values (p_account_id, p_department, 0)
  on conflict (account_id, department)
  do update set cursor = wp_chat_assign_rotation.cursor + 1,
                updated_at = now()
  returning cursor;
$$;

grant execute on function wp_chat_next_rotation_account(bigint, text) to service_role;


-- ====================================================================
-- WHAT IS DELIBERATELY *NOT* CHANGED
--
--   * wp_chat_messages — reached only through a conversation, which now carries
--     the account. Adding account_id there would denormalise with no read that
--     needs it, and would mean rewriting the largest table in the database.
--   * wp_chat_summaries — same: keyed by conversation_id.
--   * wp_chat_push_subscriptions — a browser subscription belongs to a USER and
--     to this deployment's VAPID identity, not to an account. A user assigned to
--     two accounts still has one subscription; notify.js scopes by conversation.
--   * wp_chat_users — role/department/is_active stay global. Which ACCOUNTS a
--     user can reach is the membership table above; their department is a
--     property of the person, not of an account.
--   * wp_chat_refresh_tokens — sessions are per user/device, not per account.
-- ====================================================================
