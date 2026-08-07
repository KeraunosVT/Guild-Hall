-- 000_baseline.sql — the base schema for a FRESH deployment.
--
-- Reconstructed from the application code: the original schema was built by
-- hand in the Supabase SQL editor and never committed (see the note at the top
-- of 001_audit_log.sql). This file recreates every table and SQL function the
-- backend expects, in its PRE-migration shape, so that running 000 → 011 in
-- order produces a complete, current database.
--
-- IMPORTANT: run this FIRST, on an EMPTY Supabase project, then run
-- 001..011 in numeric order. Do not run this on an existing deployment —
-- it will error on the tables that already exist (which is the safe outcome).
--
-- Everything is written for the Supabase SQL editor. The backend connects with
-- the service-role key (which bypasses row-level security), so RLS is enabled
-- on every table with NO policies: the anon/public key can read nothing, and
-- only the server can touch data. This matches how the app actually works —
-- all access control lives in Express middleware, not in Postgres.

-- ── Matches ──────────────────────────────────────────────────────────────────

create table wargame_matches (
  id uuid primary key,
  title text not null default 'Wargame',
  match_date date,
  result text,              -- 'Win' | 'Loss' | 'Draw' | null
  map text,
  created_at timestamptz not null default now()
);

create index wargame_matches_match_date_idx on wargame_matches (match_date desc);

create table player_match_stats (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references wargame_matches (id) on delete cascade,
  rank int,
  weapon_1 text,
  weapon_2 text,
  guild_name text,
  player_name text,
  team_color text,          -- 'Red' | 'Yellow' | null
  kills int,
  assists int,
  damage_dealt bigint,
  damage_taken bigint,
  healing bigint,
  created_at timestamptz not null default now()
);
-- NOTE: migration 005 drops and recreates this FK. Harmless here — 005 was
-- written to converge any starting state onto one correctly-named cascading
-- constraint, which is exactly what this baseline already defines.

create index player_match_stats_match_id_idx on player_match_stats (match_id);
create index player_match_stats_player_name_idx on player_match_stats (player_name);
create index player_match_stats_guild_name_idx on player_match_stats (guild_name);

create table wargame_maps (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

-- ── Members: roles, classes, shards, gear ────────────────────────────────────

create table member_roles (
  discord_id text primary key,
  pvp_role text,            -- 'Tank' | 'DPS' | 'Healer' | null
  pve_role text,
  pvp_classes jsonb not null default '[]'::jsonb,  -- up to 3 class names
  pve_classes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table shard_counts (
  discord_id text primary key,
  display_name text,
  shards jsonb not null default '{}'::jsonb,  -- { <shard_key>: int, weapons: [{boss, weapon, build}] }
  updated_at timestamptz not null default now()
);

create table gear_levels (
  discord_id text primary key,
  display_name text,
  weapon int not null default 0,
  armor int not null default 0,
  accessory int not null default 0,
  average int not null default 0,
  submitted_at timestamptz not null default now()
  -- maxed_at is added by migration 002
);

-- ── Player identities (in-game names ↔ Discord ids) ─────────────────────────

create table player_identities (
  id uuid primary key,
  display_name text not null,
  ingame_names jsonb not null default '[]'::jsonb,
  discord_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index player_identities_discord_id_idx on player_identities (discord_id);

-- ── Loot: catalog, wishlists, awards, currency ──────────────────────────────

create table loot_categories (
  key text primary key,
  label text not null,
  sort_order int not null default 0
);

create table loot_items (
  key text primary key,
  category_key text not null references loot_categories (key) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  image_url text,
  description text,
  grade int,
  questlog_id text,
  questlog_data jsonb
);

create index loot_items_category_key_idx on loot_items (category_key);
create index loot_items_questlog_id_idx on loot_items (questlog_id);

create table loot_wishlists (
  discord_id text primary key,
  display_name text,
  picks jsonb not null default '{}'::jsonb,  -- { <item_key>: { priority, added_at } }
  updated_at timestamptz not null default now()
);

create table loot_awards (
  id uuid primary key,
  item_key text not null,   -- validated in the app, deliberately not an FK:
                            -- deleting a catalog item must not touch the ledger
  discord_id text not null,
  display_name text,
  priority text,            -- 'PvP' | 'Second Build' | 'PvE' | null
  awarded_by text,
  awarded_at timestamptz not null default now()
);

create index loot_awards_discord_id_idx on loot_awards (discord_id);
create index loot_awards_awarded_at_idx on loot_awards (awarded_at desc);

create table currency_awards (
  id uuid primary key,
  discord_id text not null,
  display_name text,
  currency text not null,   -- 'lucent' or a shard key from shared/shards.json
  amount int not null check (amount > 0),
  awarded_by text,
  awarded_at timestamptz not null default now()
  -- reason is added by migration 006
);

create index currency_awards_discord_id_idx on currency_awards (discord_id);
create index currency_awards_awarded_at_idx on currency_awards (awarded_at desc);

-- Reference data mirrored from questlog.gg by the bulk importer.
create table questlog_items (
  id text primary key,
  name text not null,
  icon text,
  description text,
  grade int,
  main_category text,
  sub_category text,
  data jsonb
);

create index questlog_items_name_idx on questlog_items (name);

-- ── Events, attendance, schedule ────────────────────────────────────────────

create table event_schedule (
  id uuid primary key,
  name text not null,
  day_of_week int not null check (day_of_week between 0 and 6),
  event_time text           -- 'HH:MM', nullable
);

create table events (
  id uuid primary key,
  title text not null,
  event_date date,
  event_schedule_id uuid references event_schedule (id) on delete set null,
  created_at timestamptz not null default now()
);

create table event_attendance (
  id uuid primary key,
  event_id uuid not null references events (id) on delete cascade,
  discord_id text not null,
  display_name text,
  joined_at timestamptz not null default now()
);

create index event_attendance_event_id_idx on event_attendance (event_id);
create index event_attendance_discord_id_idx on event_attendance (discord_id);

-- ── Leave of absence ────────────────────────────────────────────────────────

create table loa_entries (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  type text not null check (type in ('event', 'range', 'recurring')),
  event_date date,
  event_schedule_id uuid references event_schedule (id) on delete set null,
  start_date date,
  end_date date,
  day_of_week int check (day_of_week between 0 and 6),
  start_time text,          -- 'HH:MM', nullable
  end_time text,
  reason text,
  discord_message_id text,  -- the announcement post, deleted on cancel
  created_at timestamptz not null default now()
);

create index loa_entries_discord_id_idx on loa_entries (discord_id);

-- ── Rosters (party builder) ─────────────────────────────────────────────────

create table rosters (
  id uuid primary key,
  name text not null,
  layout jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  -- event_date / event_schedule_id are added by migration 004
);

-- ── Elite boss timers ───────────────────────────────────────────────────────

create table elite_timers (
  location text primary key,
  killed_at timestamptz not null,
  next_spawn_at timestamptz not null,
  reported_by text,
  pinged boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ── SQL functions ───────────────────────────────────────────────────────────
-- All three read functions take the guild's name list as a parameter rather
-- than hardcoding it, so the same functions work for any guild — the backend
-- passes Object.keys(GUILD_ALIASES), built from shared/guild.json.

-- Create-or-replace a match and ALL its player rows in one transaction.
-- Returns the number of player rows written. A failure anywhere rolls back
-- everything — no orphan matches, no lost rows.
create or replace function save_match(
  p_id uuid,
  p_title text,
  p_match_date date,
  p_result text,
  p_map text,
  p_players jsonb
) returns int
language plpgsql
as $$
declare
  inserted int;
begin
  insert into wargame_matches (id, title, match_date, result, map)
  values (p_id, coalesce(p_title, 'Wargame'), p_match_date, p_result, p_map)
  on conflict (id) do update
    set title = excluded.title,
        match_date = excluded.match_date,
        result = excluded.result,
        map = excluded.map;

  delete from player_match_stats where match_id = p_id;

  insert into player_match_stats
    (match_id, rank, weapon_1, weapon_2, guild_name, player_name,
     team_color, kills, assists, damage_dealt, damage_taken, healing)
  select
    p_id,
    (p->>'rank')::int,
    p->>'weapon_1',
    p->>'weapon_2',
    p->>'guild_name',
    p->>'player_name',
    p->>'team_color',
    (p->>'kills')::int,
    (p->>'assists')::int,
    (p->>'damage_dealt')::bigint,
    (p->>'damage_taken')::bigint,
    (p->>'healing')::bigint
  from jsonb_array_elements(p_players) as p;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- All-time per-player totals for the guild's own players.
create or replace function get_player_stats(p_guild_names text[])
returns table (
  player_name text,
  matches bigint,
  kills bigint,
  assists bigint,
  damage_dealt bigint,
  damage_taken bigint,
  healing bigint
)
language sql
stable
as $$
  select
    s.player_name,
    count(*)                          as matches,
    coalesce(sum(s.kills), 0)         as kills,
    coalesce(sum(s.assists), 0)       as assists,
    coalesce(sum(s.damage_dealt), 0)  as damage_dealt,
    coalesce(sum(s.damage_taken), 0)  as damage_taken,
    coalesce(sum(s.healing), 0)       as healing
  from player_match_stats s
  where s.guild_name = any (p_guild_names)
  group by s.player_name;
$$;

-- Guild-wide totals for the dashboard tiles.
create or replace function get_stats_summary(p_guild_names text[])
returns table (
  total_kills bigint,
  total_damage bigint,
  total_healing bigint
)
language sql
stable
as $$
  select
    coalesce(sum(s.kills), 0)        as total_kills,
    coalesce(sum(s.damage_dealt), 0) as total_damage,
    coalesce(sum(s.healing), 0)      as total_healing
  from player_match_stats s
  where s.guild_name = any (p_guild_names);
$$;

-- Every in-game name seen on our side of a scoreboard, with how many matches
-- it appears in — the Merge Names page's raw material.
create or replace function get_guild_player_counts(p_guild_names text[])
returns table (
  player_name text,
  matches bigint
)
language sql
stable
as $$
  select s.player_name, count(*) as matches
  from player_match_stats s
  where s.guild_name = any (p_guild_names)
    and s.player_name is not null
  group by s.player_name;
$$;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Public bucket for loot-item icons (uploaded via the admin UI and by the
-- questlog importer). The app reads icons by public URL.

insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do nothing;

-- ── Row-level security ──────────────────────────────────────────────────────
-- Enabled with no policies: the service-role key (used by the backend) bypasses
-- RLS entirely, and the anon key can do nothing. All authorization lives in the
-- Express layer.

alter table wargame_matches enable row level security;
alter table player_match_stats enable row level security;
alter table wargame_maps enable row level security;
alter table member_roles enable row level security;
alter table shard_counts enable row level security;
alter table gear_levels enable row level security;
alter table player_identities enable row level security;
alter table loot_categories enable row level security;
alter table loot_items enable row level security;
alter table loot_wishlists enable row level security;
alter table loot_awards enable row level security;
alter table currency_awards enable row level security;
alter table questlog_items enable row level security;
alter table event_schedule enable row level security;
alter table events enable row level security;
alter table event_attendance enable row level security;
alter table loa_entries enable row level security;
alter table rosters enable row level security;
alter table elite_timers enable row level security;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The backend connects as service_role. When this file is run through the
-- Supabase dashboard's SQL editor, these grants are usually applied
-- automatically via default privileges — but running it through psql, a
-- direct connection, or a migration tool can create the tables under a role
-- whose objects carry no grants, and then even service_role (which bypasses
-- RLS, not plain Postgres permissions) gets "permission denied". Explicit
-- grants make the baseline work identically however it's executed, and the
-- default-privileges lines extend that to every future migration.

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
