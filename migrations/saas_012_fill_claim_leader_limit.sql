-- saas_012_fill_claim_leader_limit.sql — at most two verified leaders per guild.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_009.
--
-- A guild outside Guild Hall is led on merc by whoever staff verify through a
-- leader claim (fill_leader_claims). A guild usually has a leader and a
-- second-in-command who both post fill requests, so two verified leaders are
-- allowed per guild — and no more, so that "verified leader of X" keeps
-- meaning something to the players who receive the invites.
--
-- The app checks the limit when a claim is sent and when staff approve one,
-- and says so in a sentence. This trigger is the backstop: two staff approving
-- two different claims for the same guild at the same moment would each pass
-- the app's check, and only the database can see both. An advisory lock per
-- guild serialises them, so the second approval fails instead of making three.
--
-- Pending and rejected claims don't count: a pending claim is unverified and
-- is labelled so on every invite, and capping those would let anyone block a
-- guild's real leaders by claiming it first.

begin;

create or replace function fill_claims_leader_limit()
returns trigger
language plpgsql
as $$
declare
  v_count int;
begin
  if new.status <> 'approved' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('fill_leader_claims:' || new.threat_guild_id::text));

  select count(*) into v_count
  from fill_leader_claims
  where threat_guild_id = new.threat_guild_id
    and status = 'approved'
    and discord_id <> new.discord_id;

  if v_count >= 2 then
    raise exception 'LEADER_LIMIT: that guild already has two verified leaders';
  end if;
  return new;
end;
$$;

drop trigger if exists fill_claims_leader_limit on fill_leader_claims;
create trigger fill_claims_leader_limit
  before insert or update of status, threat_guild_id on fill_leader_claims
  for each row execute function fill_claims_leader_limit();

create index if not exists fill_leader_claims_guild_idx on fill_leader_claims (threat_guild_id, status);

commit;
