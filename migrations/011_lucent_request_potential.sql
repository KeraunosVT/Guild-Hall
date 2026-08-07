-- 011_lucent_request_potential.sql — link a request to a market-priced potential.
--
-- A request already records an item three ways: item_key for catalog gear,
-- item_name as free text for anything else. Potentials are a third thing —
-- tl-tracker prices them by a stable integer id (potentialId), which is what
-- makes an exact price lookup possible instead of matching on a display name
-- that could be retitled or duplicated.
--
-- Nullable: most requests are for gear, not potentials. When it IS set,
-- item_name still holds the potential's label so the row reads correctly
-- everywhere without a join — the same snapshot reasoning as item_name for
-- catalog items.
--
-- Prices themselves live in market_potentials (migration 010), refreshed by the
-- standalone scraper. Deliberately not a foreign key: that table is a
-- replaceable third-party snapshot, and a request must survive it being empty,
-- stale, or wiped and rebuilt.
--
-- Run this in the Supabase SQL editor.

alter table lucent_requests add column potential_id int;

create index lucent_requests_potential_id_idx on lucent_requests (potential_id)
  where potential_id is not null;
