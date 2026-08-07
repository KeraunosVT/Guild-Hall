-- 003_gear_level_history.sql — append-only log of every gear-level
-- submission, alongside the existing gear_levels table (which still holds
-- just the current/latest snapshot per member, unchanged).
--
-- Run this in the Supabase SQL editor.

create table gear_level_history (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  weapon int not null,
  armor int not null,
  accessory int not null,
  average int not null,
  submitted_at timestamptz not null default now()
);

create index gear_level_history_discord_id_idx on gear_level_history (discord_id, submitted_at desc);
