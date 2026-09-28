-- saas_009_wargame_fills.sql — the wargame fill pool (merc.guild-hall.gg).
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_008 (the
-- foreign keys below point at threat_guilds.id, which saas_008 introduced).
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────
-- Players list themselves as available to fill for OTHER guilds' wargames, and
-- guild leaders post a request (opponent, time, slots per role) and invite
-- players from that pool. A slot is only filled once the player accepts.
--
-- ── WHY THESE TABLES ARE GLOBAL ─────────────────────────────────────────────
-- Everything else in this schema belongs to one tenant. These cannot: a fill is
-- by definition someone playing for a guild that is not their own, and most
-- players in the pool belong to no Guild Hall tenant at all. So, like the
-- threat board, all four tables are listed in GLOBAL_TABLES
-- (backend/tenantDb.js) and every access rule lives in backend/wargameFills.js:
--
--   · a profile is read and written only by its owner, and read by leaders
--     through the pool, which never shows a player to their own guild, their
--     guild's opponent, or its ally;
--   · a request is managed by the leader who posted it, or — for a Guild Hall
--     guild — by any officer of that guild holding the `fills` capability;
--   · an invite is answered only by the player it names.
--
-- fill_requests.guild_id is NOT a tenant scope. It records which Guild Hall
-- guild posted the request (null for a leader whose guild does not use Guild
-- Hall), so that guild's other officers can manage it.
--
-- ── LEADERS OUTSIDE GUILD HALL ──────────────────────────────────────────────
-- Guild Hall cannot see into a guild that does not use it, so a leader from
-- outside declares which threat-board guild they lead (fill_leader_claims) and
-- Guild Hall staff confirm it by hand. They may post while pending; players
-- see "Unverified leader" on their invites until staff approve.

begin;

create table if not exists fill_profiles (
  discord_id      text primary key,
  username        text not null,
  avatar          text,
  -- Paused profiles are kept but hidden from every pool.
  active          boolean not null default true,
  role            text not null,
  classes         jsonb not null default '[]'::jsonb,
  gear            int,
  -- IANA zone the availability windows are written in. Leaders see windows
  -- evaluated against the request's own start time, so the zone must be real.
  timezone        text not null default 'America/New_York',
  -- [{ "d": 0-6 (Sun-Sat), "from": "HH:MM", "to": "HH:MM" }, …]
  windows         jsonb not null default '[]'::jsonb,
  -- The threat-board guild the player plays for, if any. Never shown to a
  -- leader of that guild's opponent (or its ally): the pool hides them instead.
  home_guild_id   uuid references threat_guilds (id) on delete set null,
  -- Guilds the player won't fill against. Arrays can't carry foreign keys; the
  -- app validates ids on write and simply ignores any that stop existing.
  avoid_guild_ids uuid[] not null default '{}',
  -- The Guild Hall tenants the player belongs to, copied from their session on
  -- every save. Used for exactly one thing: a guild's own members are not
  -- "fills" for it, so they are left out of that guild's pool.
  gh_guild_ids    uuid[] not null default '{}',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint fill_profiles_role_valid check (role in ('Tank', 'DPS', 'Healer')),
  constraint fill_profiles_classes_array check (jsonb_typeof(classes) = 'array'),
  constraint fill_profiles_windows_array check (jsonb_typeof(windows) = 'array'),
  constraint fill_profiles_gear_range check (gear is null or gear between 0 and 100000)
);

create index if not exists fill_profiles_active_idx on fill_profiles (active) where active;

-- One claim per person. A second guild would mean a second leadership to
-- verify, which is a conversation with staff, not a form.
create table if not exists fill_leader_claims (
  discord_id      text primary key,
  username        text not null,
  threat_guild_id uuid not null references threat_guilds (id) on delete cascade,
  proof           text,
  status          text not null default 'pending',
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint fill_leader_claims_status_valid check (status in ('pending', 'approved', 'rejected'))
);

create table if not exists fill_requests (
  id              uuid primary key default gen_random_uuid(),
  leader_id       text not null,
  leader_name     text not null,
  -- Exactly one of these says who is asking: a Guild Hall guild, or the
  -- threat-board guild an outside leader has claimed.
  guild_id        uuid references guilds (id) on delete cascade,
  claim_guild_id  uuid references threat_guilds (id) on delete set null,
  -- The requesting guild's name as it read when posted. Kept so an invite still
  -- names who asked even if the claim or tenant later changes.
  guild_label     text not null,
  opponent_id     uuid references threat_guilds (id) on delete set null,
  starts_at       timestamptz not null,
  duration_min    int not null default 60,
  -- { "Tank": n, "DPS": n, "Healer": n }
  slots           jsonb not null,
  notes           text,
  status          text not null default 'open',
  created_at      timestamptz not null default now(),
  constraint fill_requests_status_valid check (status in ('open', 'cancelled')),
  constraint fill_requests_duration_range check (duration_min between 15 and 360),
  constraint fill_requests_slots_object check (jsonb_typeof(slots) = 'object'),
  constraint fill_requests_has_asker check (guild_id is not null or claim_guild_id is not null)
);

create index if not exists fill_requests_leader_idx on fill_requests (leader_id, starts_at);
create index if not exists fill_requests_guild_idx on fill_requests (guild_id, starts_at);

create table if not exists fill_invites (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references fill_requests (id) on delete cascade,
  discord_id      text not null,
  role            text not null,
  -- invited   → waiting on the player
  -- accepted  → holds a slot
  -- declined  → the player said no
  -- withdrawn → the leader took it back before an answer
  -- missed    → the player said yes after the role's slots were already full
  status          text not null default 'invited',
  invited_at      timestamptz not null default now(),
  responded_at    timestamptz,
  constraint fill_invites_role_valid check (role in ('Tank', 'DPS', 'Healer')),
  constraint fill_invites_status_valid check (status in ('invited', 'accepted', 'declined', 'withdrawn', 'missed')),
  constraint fill_invites_once unique (request_id, discord_id)
);

create index if not exists fill_invites_player_idx on fill_invites (discord_id);

-- ── ACCEPT ──────────────────────────────────────────────────────────────────
-- Leaders are allowed to invite more players than they have slots — the first
-- to accept wins, which is how fills are actually found. That makes accepting a
-- race, so it is one transaction holding a row lock on the PARENT request, the
-- same pattern as signup_join in saas_002: two players accepting the last Tank
-- slot at the same moment are serialised here, and the second gets 'filled'.
--
-- Results: ok | filled | not_found | not_pending | closed
create or replace function fill_accept_invite(p_invite_id uuid, p_discord_id text)
returns table (result text)
language plpgsql
as $$
declare
  v_request_id uuid;
  v_role text;
  v_status text;
  v_req_status text;
  v_starts timestamptz;
  v_slots jsonb;
  v_taken int;
  v_cap int;
begin
  select i.request_id, i.role into v_request_id, v_role
  from fill_invites i
  where i.id = p_invite_id and i.discord_id = p_discord_id;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  select r.status, r.starts_at, r.slots into v_req_status, v_starts, v_slots
  from fill_requests r
  where r.id = v_request_id
  for update;

  -- Re-read under the lock: the invite may have been withdrawn or answered
  -- between the lookup above and taking it.
  select i.status into v_status from fill_invites i where i.id = p_invite_id;

  if v_status <> 'invited' then
    return query select 'not_pending'::text;
    return;
  end if;

  if v_req_status <> 'open' or v_starts <= now() then
    return query select 'closed'::text;
    return;
  end if;

  v_cap := coalesce((v_slots ->> v_role)::int, 0);
  select count(*) into v_taken
  from fill_invites i
  where i.request_id = v_request_id and i.role = v_role and i.status = 'accepted';

  if v_taken >= v_cap then
    update fill_invites set status = 'missed', responded_at = now() where id = p_invite_id;
    return query select 'filled'::text;
    return;
  end if;

  update fill_invites set status = 'accepted', responded_at = now() where id = p_invite_id;
  return query select 'ok'::text;
end;
$$;

-- ── RLS + GRANTS (match the baseline) ───────────────────────────────────────
alter table fill_profiles enable row level security;
alter table fill_leader_claims enable row level security;
alter table fill_requests enable row level security;
alter table fill_invites enable row level security;

grant all on fill_profiles to service_role;
grant all on fill_leader_claims to service_role;
grant all on fill_requests to service_role;
grant all on fill_invites to service_role;
grant execute on function fill_accept_invite(uuid, text) to service_role;

commit;
