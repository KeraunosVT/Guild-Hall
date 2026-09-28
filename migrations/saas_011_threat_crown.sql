-- saas_011_threat_crown.sql — the crown becomes editable, one per cluster.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_008.
-- (It does not depend on saas_009/010; the number is just the next free one.)
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- threat_guilds.king marks the guild holding its cluster. It came from the
-- spreadsheet import and nothing in the app could change it, so a siege that
-- changed hands left the board wrong until someone edited the database.
--
-- A cluster has at most one king, and until now that was only true because the
-- seed happened to say so. Once staff can move the crown it has to be a rule,
-- or a double click or two staff editing at once leaves two crowned guilds on
-- one column — which the board would render without complaint, and which
-- nobody could tell apart from the real one. So:
--
--   · a partial unique index: at most one king per cluster, enforced by the
--     database, not by the page;
--   · set_threat_king(): moving the crown is "uncrown the old holder, crown the
--     new one", and that has to be one transaction — two separate updates would
--     either briefly break the index or briefly leave the cluster with nobody.
--
-- A cluster with NO king is allowed: the crown can be contested, or simply not
-- known, and forcing one would make staff guess.
--
-- Adding a guild needs nothing here: threat_guilds already has a generated id,
-- and (cluster, name) is already unique (saas_008).

begin;

-- Refuse to proceed over data that already breaks the rule, and say which
-- cluster. Guessing which of two kings is real would be worse than stopping.
do $$
declare
  v_cluster text;
begin
  select cluster into v_cluster
  from threat_guilds
  where king
  group by cluster
  having count(*) > 1
  limit 1;
  if found then
    raise exception 'Cluster % has more than one king. Set king = false on all but one of its guilds, then run this again.', v_cluster;
  end if;
end $$;

create unique index if not exists threat_guilds_one_king_per_cluster
  on threat_guilds (cluster) where king;

-- Crown one guild, uncrowning whoever held its cluster. Returns the id of the
-- previous holder, or null if the cluster had none (or this guild already held it).
create or replace function set_threat_king(p_guild uuid, p_actor text)
returns uuid
language plpgsql
as $$
declare
  v_cluster text;
  v_prev uuid;
begin
  -- Lock the new king's row first, then the cluster's current king. Every
  -- crown change goes through here, so two at once on the same cluster queue
  -- up behind the same lock instead of both succeeding.
  select cluster into v_cluster from threat_guilds where id = p_guild for update;
  if not found then
    raise exception 'That guild is not on the board.';
  end if;

  select id into v_prev
  from threat_guilds
  where cluster = v_cluster and king and id <> p_guild
  for update;

  -- Uncrown first: the unique index is checked per statement, so crowning
  -- first would collide with the holder who hasn't been cleared yet.
  if v_prev is not null then
    update threat_guilds
    set king = false, updated_at = now(), updated_by = p_actor
    where id = v_prev;
  end if;

  update threat_guilds
  set king = true, updated_at = now(), updated_by = p_actor
  where id = p_guild and not king;

  return v_prev;
end;
$$;

grant execute on function set_threat_king(uuid, text) to service_role;

commit;
