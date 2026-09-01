-- saas_006_threat_board.sql — a guild's reading of the Americas threat board.
--
-- Run this in the Supabase SQL editor of BOTH projects (the app one and the
-- scratch one the test harness targets).
--
-- ── WHAT THIS STORES, AND WHAT IT DOES NOT ──────────────────────────────────
-- The board itself — which guilds exist on which cluster and how dangerous each
-- one is — is not here. That is imported from the community spreadsheet into
-- shared/threatBoard.json and ships with the build, because it is a fact about
-- the game world that every tenant reads identically and nobody edits in-app.
--
-- What IS here is the part each house works out for itself: who is allied to
-- whom. Two houses watching the same server will disagree about that, and both
-- are entitled to their own answer, so this table is guild-scoped like any
-- other tenant data.
--
-- ── WHY ONE ROW PER GUILD NAME, NOT ONE ROW PER PAIR ────────────────────────
-- In Throne & Liberty an alliance binds exactly two guilds, and a guild can
-- hold only one at a time. A pair-shaped row (guild_a, guild_b) cannot express
-- that rule to the database: nothing stops a name appearing as guild_a on one
-- row and guild_b on another, so "one alliance each" would survive only as long
-- as every code path remembered to check it.
--
-- Storing one row per guild name turns the rule into a key. The primary key
-- (guild_id, name) already means a name is listed once, so `partner` being a
-- plain column means it can name at most one ally — the cap is structural, and
-- no application bug can widen it. The partial unique index below closes the
-- other half: a guild cannot be claimed as the partner of two different guilds.
--
-- The cost is that a bond is two rows (a->b and b->a) which must agree. That is
-- what set_threat_ally() is for: a function body is one transaction, so a bond
-- is never half-written, and the four-row shuffle of stealing two already-bound
-- guilds either lands completely or not at all.

create table if not exists threat_board_marks (
  guild_id   uuid not null references guilds(id) on delete cascade,
  -- The guild being marked, as it is spelled in shared/threatBoard.json. Text
  -- rather than an id because the board is a flat file refreshed from a
  -- spreadsheet — there is no stable key upstream to point at. A rename on the
  -- sheet orphans the mark, which the API drops on read rather than showing a
  -- bond to a guild that is no longer on the board.
  name       text not null,
  -- The one guild this one is allied with. A row exists only to record a bond,
  -- so this is never null: breaking an alliance deletes both rows outright.
  partner    text not null,
  updated_at timestamptz not null default now(),
  primary key (guild_id, name),
  -- A guild cannot ally itself.
  constraint threat_board_marks_not_self check (partner <> name)
);

-- The other half of the one-alliance rule: within a house's reading, a guild may
-- be named as at most one other guild's partner.
create unique index if not exists threat_board_marks_partner_uniq
  on threat_board_marks (guild_id, partner);

-- Keeps the common read — every bond this house has mapped — off a sequential
-- scan as the table grows across tenants.
create index if not exists threat_board_marks_guild_idx
  on threat_board_marks (guild_id);

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
  p_guild_id uuid,
  p_a text,
  p_b text
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
  from threat_board_marks
  where guild_id = p_guild_id
    and name in (p_a, p_b)
    and partner not in (p_a, p_b);

  -- Release both sides first. This has to clear FOUR rows in the worst case,
  -- not two: a's row and b's row, plus the rows belonging to the guilds being
  -- displaced, which still point back at a and b. Missing that second pair is
  -- what would leave a one-sided bond behind.
  delete from threat_board_marks
   where guild_id = p_guild_id
     and (name in (p_a, p_b) or partner in (p_a, p_b));

  -- Then write the new bond, both directions.
  insert into threat_board_marks (guild_id, name, partner, updated_at)
  values (p_guild_id, p_a, p_b, now()), (p_guild_id, p_b, p_a, now());

  return v_freed;
end;
$$;
