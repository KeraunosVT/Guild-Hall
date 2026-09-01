-- saas_006_threat_board.sql — the Americas alliance map.
--
-- Run this in the Supabase SQL editor of BOTH projects (the app one and the
-- scratch one the test harness targets).
--
-- ── WHAT THIS STORES, AND WHAT IT DOES NOT ──────────────────────────────────
-- The board itself — which guilds exist on which cluster and how dangerous each
-- one is — is not here. That is imported from the community spreadsheet into
-- shared/threatBoard.json and ships with the build, because it is a fact about
-- the game world that nobody edits in-app.
--
-- What IS here is who is allied to whom. That is a fact about the same world
-- rather than about any one house, and the page that shows it is public — so
-- unlike almost every other table in this schema, THIS ONE IS NOT GUILD-SCOPED.
-- One alliance map, read by anyone, the same for everyone.
--
-- That is a deliberate exception to the multi-tenant rule, and it is declared in
-- two places that must agree: GLOBAL_TABLES in backend/tenantDb.js, and here.
-- Writes are gated on the 'threat' capability so the shared map cannot be
-- rewritten by a passing visitor, but any officer holding it edits what every
-- other house sees. updated_by records which account made each change.
--
-- ── WHY ONE ROW PER GUILD NAME, NOT ONE ROW PER PAIR ────────────────────────
-- In Throne & Liberty an alliance binds exactly two guilds, and a guild can
-- hold only one at a time. A pair-shaped row (guild_a, guild_b) cannot express
-- that rule to the database: nothing stops a name appearing as guild_a on one
-- row and guild_b on another, so "one alliance each" would survive only as long
-- as every code path remembered to check it.
--
-- Storing one row per guild name turns the rule into a key. The primary key
-- already means a name is listed once, so `partner` being a plain column means
-- it can name at most one ally — the cap is structural, and no application bug
-- can widen it. The unique index below closes the other half: a guild cannot be
-- claimed as the partner of two different guilds.
--
-- The cost is that a bond is two rows (a->b and b->a) which must agree. That is
-- what set_threat_ally() is for: a function body is one transaction, so a bond
-- is never half-written, and the four-row shuffle of stealing two already-bound
-- guilds either lands completely or not at all.

-- An earlier draft of this migration created a guild-scoped threat_board_marks.
-- It was never released, and the shape below is not an alteration of it — the
-- guild_id it was keyed on is exactly what had to go. Dropped rather than
-- migrated because it holds no data worth keeping in any deployment.
drop function if exists set_threat_ally(uuid, text, text);
drop table if exists threat_board_marks;

create table if not exists threat_alliances (
  -- The guild, as it is spelled in shared/threatBoard.json. Text rather than an
  -- id because the board is a flat file refreshed from a spreadsheet — there is
  -- no stable key upstream to point at. A rename on the sheet orphans the row,
  -- which the API drops on read rather than showing a bond to a guild that is
  -- no longer on the board.
  name       text primary key,
  -- The one guild this one is allied with. A row exists only to record a bond,
  -- so this is never null: breaking an alliance deletes both rows outright.
  partner    text not null,
  updated_at timestamptz not null default now(),
  -- Which account last touched this bond. The map is shared, so "who changed
  -- this" is a question someone will eventually need answered.
  updated_by text,
  constraint threat_alliances_not_self check (partner <> name)
);

-- The other half of the one-alliance rule: a guild may be named as at most one
-- other guild's partner.
create unique index if not exists threat_alliances_partner_uniq
  on threat_alliances (partner);

-- ── BONDING TWO GUILDS, ATOMICALLY ──────────────────────────────────────────
-- Pairing a with b can dissolve up to two existing alliances — a's and b's —
-- and writes two rows. Done as separate statements from the application, a
-- failure midway leaves one guild bound to a partner that is no longer bound
-- back, which is exactly the corruption the schema above is shaped to prevent.
-- One function body is one transaction, so that window does not exist.
--
-- Returns the names released by the pairing, so the caller can report what it
-- cost without re-reading the table.
create or replace function set_threat_ally(
  p_a text,
  p_b text,
  p_actor text default null
) returns text[]
language plpgsql
as $$
declare
  v_freed text[];
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception 'set_threat_ally: needs two different guilds';
  end if;

  -- Whoever a and b are currently bound to, other than each other.
  select coalesce(array_agg(partner), '{}')
    into v_freed
  from threat_alliances
  where name in (p_a, p_b)
    and partner not in (p_a, p_b);

  -- Release both sides first. This has to clear FOUR rows in the worst case,
  -- not two: a's row and b's row, plus the rows belonging to the guilds being
  -- displaced, which still point back at a and b. Missing that second pair is
  -- what would leave a one-sided bond behind.
  delete from threat_alliances
   where name in (p_a, p_b) or partner in (p_a, p_b);

  -- Then write the new bond, both directions.
  insert into threat_alliances (name, partner, updated_at, updated_by)
  values (p_a, p_b, now(), p_actor), (p_b, p_a, now(), p_actor);

  return v_freed;
end;
$$;
