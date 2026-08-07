-- 007_lucent_requests.sql — members asking for Lucent to buy a specific item.
--
-- Distinct from both neighbours it sits between: the wishlist says "I want this
-- item if it drops", currency_awards says "this member was given N Lucent", and
-- this says "this member asked for N Lucent to buy this item, and here's where
-- that request got to". Officers log these (requests arrive via Discord), so
-- there's no member-facing write path.
--
-- item_name is always populated, even when item_key points at the catalog: it's
-- a snapshot, so a request's history still reads correctly after the item is
-- renamed or removed from loot_items. item_key stays null for free-text
-- requests, which Lucent needs — it buys from the auction house, not just from
-- the guild's own drop table.
--
-- item_key and currency_award_id are intentionally not foreign keys, matching
-- loot_awards, which likewise validates item_key in the application rather than
-- in the schema. Deleting a catalog item or revoking a grant should not fail or
-- cascade into this ledger.
--
-- Run this in the Supabase SQL editor.

create table lucent_requests (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  item_key text,
  item_name text not null,
  amount int not null check (amount > 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'paid')),
  requested_by text,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  -- Set when the request is marked paid; the currency_awards row it created.
  currency_award_id uuid
);

create index lucent_requests_status_idx on lucent_requests (status, requested_at desc);
create index lucent_requests_discord_id_idx on lucent_requests (discord_id);
