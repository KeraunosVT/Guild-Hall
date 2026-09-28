-- saas_010_fill_staff_moderation.sql — staff can pause a fill listing.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_009.
--
-- The fill pool is open to anyone with a Discord account, so it needs a way to
-- take a listing down — a troll, an impersonator, a player who keeps no-showing.
-- A staff pause is separate from the player's own Listed/Paused switch
-- (fill_profiles.active) on purpose: the player can flip their own switch as
-- often as they like, but only staff can lift a staff pause. A profile is in
-- the pool only when it is active AND not staff-paused (backend/wargameFills.js,
-- inPool).
--
-- Invites the player already holds are left alone: they can still answer them.
-- The pause stops new invites, not ones in flight.

begin;

alter table fill_profiles add column if not exists staff_paused boolean not null default false;
alter table fill_profiles add column if not exists staff_paused_reason text;
alter table fill_profiles add column if not exists staff_paused_by text;
alter table fill_profiles add column if not exists staff_paused_at timestamptz;

create index if not exists fill_profiles_staff_paused_idx on fill_profiles (staff_paused) where staff_paused;

commit;
