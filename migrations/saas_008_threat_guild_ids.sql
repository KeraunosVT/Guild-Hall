-- saas_008_threat_guild_ids.sql — key guilds by id, not by name.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_007.
--
-- ── THE BUG THIS FIXES ──────────────────────────────────────────────────────
-- saas_007 made threat_guilds.name the primary key. That was wrong, and it lost
-- data the moment it ran: two guilds on DIFFERENT servers may share a name, and
-- the Americas board has exactly that — "Original Sin" plays on both ENCHANTED
-- and DISTORTION. A single-column key cannot hold both, so the seed's
-- ON CONFLICT DO NOTHING silently dropped the second one and the board came up
-- with 129 of its 130 guilds. Silently, which is the worst part: nothing failed,
-- the column just quietly had one fewer guild in it.
--
-- Name was chosen as the key so that ON UPDATE CASCADE could carry a rename into
-- threat_alliances. A surrogate id gets that for free and better: ids do not
-- change when a guild is renamed OR when it transfers servers, so the alliance
-- map simply never has to be touched by either operation. The cascade existed to
-- solve a problem that only the natural key created.
--
-- ── WHAT MOVES ──────────────────────────────────────────────────────────────
-- threat_guilds gains a uuid id, and (cluster, name) becomes the unique pair —
-- one guild of a given name per cluster, which is the real-world rule.
-- threat_alliances stops referencing names and references those ids instead.
-- Existing bonds are carried over by name join, which is unambiguous here
-- because every name currently in the table is distinct (the duplicate is the
-- row that never made it in).
--
-- Everything runs in one transaction: either the board ends up keyed by id with
-- every bond intact, or nothing changes at all.

begin;

-- ── 1. threat_guilds: add the surrogate key ─────────────────────────────────
alter table threat_guilds add column if not exists id uuid not null default gen_random_uuid();

-- Swap the primary key from name to id. The name-based foreign keys on
-- threat_alliances depend on it, so they go first; they are rebuilt against ids
-- in step 3 and are not needed in between.
alter table threat_alliances drop constraint if exists threat_alliances_name_fk;
alter table threat_alliances drop constraint if exists threat_alliances_partner_fk;
alter table threat_guilds drop constraint if exists threat_guilds_pkey;
alter table threat_guilds add primary key (id);

-- The real rule: a name is unique WITHIN a cluster, not across the board.
alter table threat_guilds drop constraint if exists threat_guilds_cluster_name_uniq;
alter table threat_guilds add constraint threat_guilds_cluster_name_uniq unique (cluster, name);

-- ── 2. restore the guild saas_007 dropped ───────────────────────────────────
-- Idempotent: if it is somehow already present, this changes nothing.
insert into threat_guilds (name, cluster, status, cd, king)
values ('Original Sin', 'DISTORTION', 'Not Competitive', 'No CD', false)
on conflict (cluster, name) do nothing;

-- ── 3. threat_alliances: reference ids ──────────────────────────────────────
alter table threat_alliances add column if not exists guild_id uuid;
alter table threat_alliances add column if not exists partner_id uuid;

-- Carry existing bonds across by name. Safe because every name presently in
-- threat_alliances resolves to exactly one guild row.
update threat_alliances a
   set guild_id   = g.id
  from threat_guilds g
 where g.name = a.name and a.guild_id is null;

update threat_alliances a
   set partner_id = g.id
  from threat_guilds g
 where g.name = a.partner and a.partner_id is null;

-- Anything that failed to resolve names a guild no longer on the board; it
-- could never have been drawn, and the API already discarded it on read.
delete from threat_alliances where guild_id is null or partner_id is null;

-- The old shape goes, and with it the constraints and indexes built on it.
alter table threat_alliances drop constraint if exists threat_alliances_pkey;
alter table threat_alliances drop constraint if exists threat_alliances_not_self;
drop index if exists threat_alliances_partner_uniq;
alter table threat_alliances drop column if exists name;
alter table threat_alliances drop column if exists partner;

alter table threat_alliances alter column guild_id set not null;
alter table threat_alliances alter column partner_id set not null;
alter table threat_alliances add primary key (guild_id);

-- The one-alliance rule, unchanged in meaning: a guild is listed once (the
-- primary key) and may be claimed as at most one other guild's partner (this).
alter table threat_alliances add constraint threat_alliances_partner_uniq unique (partner_id);
alter table threat_alliances add constraint threat_alliances_not_self check (partner_id <> guild_id);

-- Deleting a guild takes its bonds with it. No ON UPDATE CASCADE is needed any
-- more — that was the natural key's problem, and ids do not change.
alter table threat_alliances add constraint threat_alliances_guild_fk
  foreign key (guild_id) references threat_guilds (id) on delete cascade;
alter table threat_alliances add constraint threat_alliances_partner_fk
  foreign key (partner_id) references threat_guilds (id) on delete cascade;

-- ── 4. bonding, by id ───────────────────────────────────────────────────────
-- Same transaction-per-call reasoning as saas_006: pairing can dissolve up to
-- two existing alliances and writes two rows, and a half-written bond is the
-- corruption the schema is shaped to prevent. Returns the ids it freed.
drop function if exists set_threat_ally(text, text, text);
create or replace function set_threat_ally(
  p_a uuid,
  p_b uuid,
  p_actor text default null
) returns uuid[]
language plpgsql
as $$
declare
  v_freed uuid[];
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception 'set_threat_ally: needs two different guilds';
  end if;

  select coalesce(array_agg(partner_id), '{}')
    into v_freed
  from threat_alliances
  where guild_id in (p_a, p_b)
    and partner_id not in (p_a, p_b);

  -- Four rows in the worst case, not two: a's and b's own rows, plus the rows
  -- belonging to the guilds being displaced, which still point back at a and b.
  delete from threat_alliances
   where guild_id in (p_a, p_b) or partner_id in (p_a, p_b);

  insert into threat_alliances (guild_id, partner_id, updated_at, updated_by)
  values (p_a, p_b, now(), p_actor), (p_b, p_a, now(), p_actor);

  return v_freed;
end;
$$;

commit;
