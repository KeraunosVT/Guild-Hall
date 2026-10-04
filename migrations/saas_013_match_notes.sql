-- saas_013_match_notes.sql — free-text notes on a war record.
--
-- Run this in the Supabase SQL editor of BOTH projects, BEFORE deploying the
-- code that sends p_notes: until it runs, every match save fails because the
-- app calls a save_match() signature that doesn't exist yet.
--
-- Notes go through save_match() with the rest of the match metadata rather than
-- a separate update, so a match and its notes are written in the same
-- transaction. The old 7-argument save_match is dropped, not overloaded: two
-- versions differing only by a defaulted parameter make PostgREST's named-
-- argument lookup ambiguous.

begin;

alter table wargame_matches add column if not exists notes text;

drop function if exists save_match(uuid, uuid, text, date, text, text, jsonb);

create or replace function save_match(
  p_guild_id uuid,
  p_id uuid,
  p_title text,
  p_match_date date,
  p_result text,
  p_map text,
  p_players jsonb,
  p_notes text default null
) returns int
language plpgsql
as $$
declare
  inserted int;
begin
  insert into wargame_matches (id, guild_id, title, match_date, result, map, notes)
  values (p_id, p_guild_id, coalesce(p_title, 'Wargame'), p_match_date, p_result, p_map, p_notes)
  on conflict (id) do update
    set title = excluded.title,
        match_date = excluded.match_date,
        result = excluded.result,
        map = excluded.map,
        notes = excluded.notes
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

commit;
