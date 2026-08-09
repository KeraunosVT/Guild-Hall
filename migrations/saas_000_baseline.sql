-- ============================================================================
-- Guild Hall SaaS — Phase 1 Multi-Tenant Baseline
-- ============================================================================
-- A FRESH, EMPTY schema for the hosted multi-tenant service. Run once on a NEW
-- Supabase project. This is NOT for your single-guild deployment — that keeps
-- running the original migrations/000_baseline.sql on its own host.
--
-- What's different from the single-tenant baseline:
--   1. A `guilds` tenant registry (replaces shared/guild.json + per-guild .env).
--   2. `guild_id uuid NOT NULL` on every tenant table, cascading from guilds.
--   3. Natural-key primary keys that were globally unique (loot_categories.key,
--      member_roles.discord_id, etc.) become COMPOSITE with guild_id, because
--      two guilds must be able to use the same category key or hold the same
--      member's discord_id independently.
--   4. `questlog_items` stays GLOBAL (no guild_id) — it's a cache of game facts
--      scraped from questlog.gg, not guild data. Shared safely because it holds
--      nothing guild-specific.
--   5. All four SQL functions take p_guild_id and scope to it.
--   6. Row-Level Security policies enforce tenant isolation at the database
--      layer as a safety net beneath app-level scoping (see the RLS section).
--
-- No backfill: the service starts with zero tenants. The first `guilds` row is
-- created by real signup (Phase 5), or by hand for the first pilot guild.
-- ============================================================================

-- ── TENANT REGISTRY ─────────────────────────────────────────────────────────
-- One row per guild using the service. Everything that was per-guild config in
-- the single-tenant app (shared/guild.json branding + timezone, and the
-- DISCORD_* env vars) lives here instead, resolved per request.

create table guilds (
  id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null unique,   -- the Discord server this guild maps to
  -- Identity / branding (was shared/guild.json)
  house text not null,                     -- ceremonial display name
  tag text not null,                       -- in-game guild tag as it appears on scoreboards
  aliases jsonb not null default '[]'::jsonb, -- past/current in-game names, for war-record continuity
  motto text,
  creed text,
  -- Locale (was hardcoded GUILD_TZ / GUILD_DAY_START)
  timezone text not null default 'America/New_York',
  day_start text not null default '01:00',
  -- Discord wiring (was DISCORD_* env vars). Role/channel IDs are per guild.
  admin_role_ids jsonb not null default '[]'::jsonb,
  allowed_role_ids jsonb not null default '[]'::jsonb,  -- empty = any member may log in
  member_role_ids jsonb not null default '[]'::jsonb,   -- empty = defaults to allowed
  roster_channel_id text,
  loa_channel_id text,
  announce_channel_id text,
  -- Lifecycle
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  -- Billing hook for Phase 6 (nullable until you charge)
  subscription_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index guilds_status_idx on guilds (status);

-- ── MATCHES ─────────────────────────────────────────────────────────────────

create table wargame_matches (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  title text not null default 'Wargame',
  match_date date,
  result text,
  map text,
  created_at timestamptz not null default now()
);

create index wargame_matches_guild_date_idx on wargame_matches (guild_id, match_date desc);

create table player_match_stats (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  match_id uuid not null references wargame_matches (id) on delete cascade,
  rank int,
  weapon_1 text,
  weapon_2 text,
  guild_name text,          -- the scoreboard guild-tag text (may be an enemy's); NOT the tenant
  player_name text,
  team_color text,
  kills int,
  assists int,
  damage_dealt bigint,
  damage_taken bigint,
  healing bigint,
  created_at timestamptz not null default now()
);

create index player_match_stats_guild_match_idx on player_match_stats (guild_id, match_id);
create index player_match_stats_guild_player_idx on player_match_stats (guild_id, player_name);

-- wargame_maps.name was globally unique; now unique per guild.
create table wargame_maps (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  name text not null,
  unique (guild_id, name)
);

-- ── MEMBERS: roles, shards, gear ────────────────────────────────────────────
-- discord_id was the PK in single-tenant. Now (guild_id, discord_id) is the
-- natural key — the same person can be in two guilds with different roles.

create table member_roles (
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  pvp_role text,
  pve_role text,
  pvp_classes jsonb not null default '[]'::jsonb,
  pve_classes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (guild_id, discord_id)
);

create table shard_counts (
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  shards jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (guild_id, discord_id)
);

create table gear_levels (
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  weapon int not null default 0,
  armor int not null default 0,
  accessory int not null default 0,
  average int not null default 0,
  submitted_at timestamptz not null default now(),
  maxed_at timestamptz,                    -- folded in from migration 002
  primary key (guild_id, discord_id)
);

-- gear_level_history (migration 003) — append-only, surrogate PK already.
create table gear_level_history (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  weapon int not null,
  armor int not null,
  accessory int not null,
  average int not null,
  submitted_at timestamptz not null default now()
);

create index gear_level_history_guild_member_idx on gear_level_history (guild_id, discord_id, submitted_at desc);

-- ── PLAYER IDENTITIES ───────────────────────────────────────────────────────

create table player_identities (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  display_name text not null,
  ingame_names jsonb not null default '[]'::jsonb,
  discord_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index player_identities_guild_discord_idx on player_identities (guild_id, discord_id);

-- ── LOOT ────────────────────────────────────────────────────────────────────
-- loot_categories.key and loot_items.key were global PKs. Now composite with
-- guild_id: each guild curates its OWN catalog (sort order, custom icons,
-- what's enabled). New guilds get a seeded default catalog at signup (Phase 5).

create table loot_categories (
  guild_id uuid not null references guilds (id) on delete cascade,
  key text not null,
  label text not null,
  sort_order int not null default 0,
  primary key (guild_id, key)
);

create table loot_items (
  guild_id uuid not null references guilds (id) on delete cascade,
  key text not null,
  category_key text not null,
  name text not null,
  sort_order int not null default 0,
  image_url text,
  description text,
  grade int,
  questlog_id text,                        -- optional link to the GLOBAL questlog_items cache
  questlog_data jsonb,
  primary key (guild_id, key),
  foreign key (guild_id, category_key) references loot_categories (guild_id, key) on delete cascade
);

create index loot_items_guild_category_idx on loot_items (guild_id, category_key);
create index loot_items_guild_questlog_idx on loot_items (guild_id, questlog_id);

create table loot_wishlists (
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  picks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (guild_id, discord_id)
);

-- item_key is deliberately NOT an FK (deleting a catalog item must not touch
-- the ledger) — same as single-tenant, just now guild-scoped.
create table loot_awards (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  item_key text not null,
  discord_id text not null,
  display_name text,
  priority text,
  awarded_by text,
  awarded_at timestamptz not null default now()
);

create index loot_awards_guild_discord_idx on loot_awards (guild_id, discord_id);
create index loot_awards_guild_awarded_idx on loot_awards (guild_id, awarded_at desc);

create table currency_awards (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  currency text not null,
  amount int not null check (amount > 0),
  reason text,                             -- folded in from migration 006
  awarded_by text,
  awarded_at timestamptz not null default now()
);

create index currency_awards_guild_discord_idx on currency_awards (guild_id, discord_id);
create index currency_awards_guild_awarded_idx on currency_awards (guild_id, awarded_at desc);

-- lucent_requests (migrations 007 + 009 + 011 folded in)
create table lucent_requests (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  item_key text,
  item_name text not null,
  amount int not null check (amount > 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'paid')),
  request_type text,                       -- migration 009
  potential_id int,                        -- migration 011
  requested_by text,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  currency_award_id uuid                   -- the currency_awards row created on "paid"
);

create index lucent_requests_guild_status_idx on lucent_requests (guild_id, status, requested_at desc);
create index lucent_requests_guild_discord_idx on lucent_requests (guild_id, discord_id);
create index lucent_requests_potential_idx on lucent_requests (guild_id, potential_id) where potential_id is not null;

-- ── QUESTLOG ITEMS — GLOBAL (no guild_id) ───────────────────────────────────
-- Deliberately NOT tenant-scoped. This is a shared cache of canonical game item
-- definitions scraped from questlog.gg — game facts, not guild data. Populated
-- once by the importer, read by all guilds. Sharing it is pure dedup with no
-- isolation risk, because it contains nothing private to any guild. Guilds
-- reference it by id via loot_items.questlog_id but never write it per-guild.

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

-- market_potentials (migration 010) — region-keyed market snapshots. This is
-- also game/region reference data rather than guild data, BUT the app reads it
-- in guild-scoped flows and a guild may care about different regions. Kept
-- GLOBAL keyed by region (matches the scraper's model); if you later want
-- per-guild region selection, that's a guild *setting*, not a copy of this data.
create table market_potentials (
  region text primary key,
  items jsonb not null,
  item_count int not null default 0,
  fetched_at timestamptz not null default now()
);

-- ── EVENTS, ATTENDANCE, SCHEDULE ────────────────────────────────────────────

create table event_schedule (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  name text not null,
  day_of_week int not null check (day_of_week between 0 and 6),
  event_time text
);

create index event_schedule_guild_idx on event_schedule (guild_id);

create table events (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  title text not null,
  event_date date,
  event_schedule_id uuid references event_schedule (id) on delete set null,
  created_at timestamptz not null default now()
);

create index events_guild_date_idx on events (guild_id, event_date desc);

create table event_attendance (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  discord_id text not null,
  display_name text,
  joined_at timestamptz not null default now()
);

create index event_attendance_guild_event_idx on event_attendance (guild_id, event_id);
create index event_attendance_guild_discord_idx on event_attendance (guild_id, discord_id);

-- ── LEAVE OF ABSENCE ────────────────────────────────────────────────────────

create table loa_entries (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  discord_id text not null,
  display_name text,
  type text not null check (type in ('event', 'range', 'recurring')),
  event_date date,
  event_schedule_id uuid references event_schedule (id) on delete set null,
  start_date date,
  end_date date,
  day_of_week int check (day_of_week between 0 and 6),
  start_time text,
  end_time text,
  reason text,
  discord_message_id text,
  created_at timestamptz not null default now()
);

create index loa_entries_guild_discord_idx on loa_entries (guild_id, discord_id);

-- ── ROSTERS (migration 004 folded in) ───────────────────────────────────────

create table rosters (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  name text not null,
  layout jsonb not null,
  event_date date,
  event_schedule_id uuid references event_schedule (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rosters_guild_idx on rosters (guild_id);

-- ── ELITE TIMERS ────────────────────────────────────────────────────────────
-- location was the global PK; now composite with guild_id.

create table elite_timers (
  guild_id uuid not null references guilds (id) on delete cascade,
  location text not null,
  killed_at timestamptz not null,
  next_spawn_at timestamptz not null,
  reported_by text,
  pinged boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (guild_id, location)
);

-- ── PERMISSION GRANTS (migration 008 folded in) ─────────────────────────────
-- The unique constraint gains guild_id: the same role may hold the same
-- permission in two different guilds independently.

create table permission_grants (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  subject_type text not null check (subject_type in ('role', 'user')),
  subject_id text not null,
  subject_label text,
  permission text not null,
  granted_by text,
  granted_at timestamptz not null default now(),
  unique (guild_id, subject_type, subject_id, permission)
);

create index permission_grants_guild_subject_idx on permission_grants (guild_id, subject_type, subject_id);

-- ── AUDIT LOG (migration 001 folded in) ─────────────────────────────────────

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  actor_id text,
  actor_name text,
  action text not null,
  method text,
  path text,
  body jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_guild_created_idx on audit_log (guild_id, created_at desc);

-- ── SQL FUNCTIONS ───────────────────────────────────────────────────────────
-- All scope to a single guild via p_guild_id. save_match stamps guild_id on
-- every row it writes; the read functions filter by it.

create or replace function save_match(
  p_guild_id uuid,
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
  insert into wargame_matches (id, guild_id, title, match_date, result, map)
  values (p_id, p_guild_id, coalesce(p_title, 'Wargame'), p_match_date, p_result, p_map)
  on conflict (id) do update
    set title = excluded.title,
        match_date = excluded.match_date,
        result = excluded.result,
        map = excluded.map
    where wargame_matches.guild_id = p_guild_id;  -- never let one guild edit another's match

  delete from player_match_stats where match_id = p_id and guild_id = p_guild_id;

  insert into player_match_stats
    (guild_id, match_id, rank, weapon_1, weapon_2, guild_name, player_name,
     team_color, kills, assists, damage_dealt, damage_taken, healing)
  select
    p_guild_id, p_id,
    (p->>'rank')::int, p->>'weapon_1', p->>'weapon_2', p->>'guild_name',
    p->>'player_name', p->>'team_color',
    (p->>'kills')::int, (p->>'assists')::int,
    (p->>'damage_dealt')::bigint, (p->>'damage_taken')::bigint, (p->>'healing')::bigint
  from jsonb_array_elements(p_players) as p;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function get_player_stats(p_guild_id uuid, p_guild_names text[])
returns table (
  player_name text, matches bigint, kills bigint, assists bigint,
  damage_dealt bigint, damage_taken bigint, healing bigint
)
language sql stable
as $$
  select s.player_name, count(*),
         coalesce(sum(s.kills),0), coalesce(sum(s.assists),0),
         coalesce(sum(s.damage_dealt),0), coalesce(sum(s.damage_taken),0),
         coalesce(sum(s.healing),0)
  from player_match_stats s
  where s.guild_id = p_guild_id and s.guild_name = any (p_guild_names)
  group by s.player_name;
$$;

create or replace function get_stats_summary(p_guild_id uuid, p_guild_names text[])
returns table (total_kills bigint, total_damage bigint, total_healing bigint)
language sql stable
as $$
  select coalesce(sum(s.kills),0), coalesce(sum(s.damage_dealt),0), coalesce(sum(s.healing),0)
  from player_match_stats s
  where s.guild_id = p_guild_id and s.guild_name = any (p_guild_names);
$$;

create or replace function get_guild_player_counts(p_guild_id uuid, p_guild_names text[])
returns table (player_name text, matches bigint)
language sql stable
as $$
  select s.player_name, count(*)
  from player_match_stats s
  where s.guild_id = p_guild_id and s.guild_name = any (p_guild_names)
    and s.player_name is not null
  group by s.player_name;
$$;

-- ── STORAGE ─────────────────────────────────────────────────────────────────
-- Shared bucket for loot-item icons. Objects should be namespaced by guild id
-- in their path (e.g. '<guild_id>/<item_key>.png') so one guild can't overwrite
-- another's icon — enforce that in the upload path in application code.

insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do nothing;

-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- The backend connects as service_role. Explicit grants so this works however
-- the SQL is executed (dashboard, psql, or a migration tool).

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ── ROW-LEVEL SECURITY (tenant isolation safety net) ────────────────────────
-- The backend uses the service_role key, which BYPASSES RLS — so app-level
-- guild_id scoping (Phase 2) remains the primary mechanism. RLS here is the
-- belt-and-suspenders layer: enable it on every tenant table so that if you
-- ever query with a non-service key, or add a policy-scoped role later, a
-- missing guild filter fails CLOSED (returns nothing) instead of leaking.
--
-- guilds + the two global tables get RLS enabled with no policy (service_role
-- only). questlog_items and market_potentials are global-read reference data.

alter table guilds enable row level security;
alter table wargame_matches enable row level security;
alter table player_match_stats enable row level security;
alter table wargame_maps enable row level security;
alter table member_roles enable row level security;
alter table shard_counts enable row level security;
alter table gear_levels enable row level security;
alter table gear_level_history enable row level security;
alter table player_identities enable row level security;
alter table loot_categories enable row level security;
alter table loot_items enable row level security;
alter table loot_wishlists enable row level security;
alter table loot_awards enable row level security;
alter table currency_awards enable row level security;
alter table lucent_requests enable row level security;
alter table questlog_items enable row level security;
alter table market_potentials enable row level security;
alter table event_schedule enable row level security;
alter table events enable row level security;
alter table event_attendance enable row level security;
alter table loa_entries enable row level security;
alter table rosters enable row level security;
alter table elite_timers enable row level security;
alter table permission_grants enable row level security;
alter table audit_log enable row level security;

-- NOTE: With service_role bypassing RLS, no per-row policies are strictly
-- required for the current architecture. If Phase 2 later introduces a
-- request-scoped role that sets `app.current_guild` via set_config(), add
-- policies of the form:
--   create policy tenant_isolation on <table>
--     using (guild_id = current_setting('app.current_guild')::uuid);
-- on each tenant table. Left as a documented hook rather than dead policy code.
