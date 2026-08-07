-- 005_fix_match_stats_fk.sql — makes deleting a match possible.
--
-- player_match_stats carries TWO foreign keys on match_id to wargame_matches:
-- the expected player_match_stats_match_id_fkey, and a stale duplicate named
-- "player_match.stats_match_id_fkey" (a period where an underscore belongs,
-- so presumably a typo'd hand-created constraint). The duplicate has no
-- ON DELETE CASCADE, so deleting a match fails with:
--
--   23503: update or delete on table "wargame_matches" violates foreign key
--   constraint "player_match.stats_match_id_fkey" on table "player_match_stats"
--
-- The duplicate is also why server.js has to name the constraint explicitly in
-- its PostgREST embed — with two relationships between the same pair of tables,
-- PostgREST can't infer which to use and errors with "more than one
-- relationship was found". Removing it fixes both problems.
--
-- Rather than assume the surviving constraint already cascades, this drops both
-- and recreates a single correctly-named one, so the end state is the same
-- whatever the current configuration is.
--
-- Run this in the Supabase SQL editor.

alter table player_match_stats drop constraint if exists "player_match.stats_match_id_fkey";
alter table player_match_stats drop constraint if exists player_match_stats_match_id_fkey;

alter table player_match_stats
  add constraint player_match_stats_match_id_fkey
  foreign key (match_id) references wargame_matches (id) on delete cascade;
