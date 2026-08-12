-- saas_004_attendance_revamp.sql — time windows, late requests, frozen parties.
--
-- Run this in the Supabase SQL editor of BOTH projects (the app one and the
-- scratch one the test harness targets). Idempotent: every statement is
-- `if not exists`, so re-running it is a no-op.

-- ── THE DEFAULT VOICE CHANNEL TO SNAP ───────────────────────────────────────
-- Note the name: this is a VOICE channel, and it is the only one on the guilds
-- row that is. Every other *_channel_id here is a text channel the bot posts
-- into; this one is a channel the bot READS a member list out of. Do not add it
-- to the CHANNELS array in the settings page — that array is fed by
-- listTextChannels(), and a text-channel dropdown cannot offer a voice channel.
--
-- NULL means "ask every time", which is what officers do today.
alter table guilds add column if not exists attendance_voice_channel_id text;

-- ── THE PARTY THE NIGHT ACTUALLY RAN WITH ───────────────────────────────────
-- Two columns, because they answer two different questions.
--
-- roster_id is a breadcrumb: which saved roster was this built from. It is
-- nullable and ON DELETE SET NULL, because deleting a roster must not delete
-- the history of nights that used it.
--
-- party_layout is the record. It is a COPY of rosters.layout taken when
-- attendance was saved, not a join. Rosters are living documents — officers
-- reshuffle them week to week and the party builder saves over them — so a
-- join would make last month's event silently start displaying this month's
-- party, and there would be no way to notice. The same reasoning as
-- event_signups.mention_role_id in saas_003: a record of what happened is not
-- a live view of configuration.
alter table events add column if not exists roster_id uuid references rosters (id) on delete set null;
alter table events add column if not exists party_layout jsonb;

-- ── HOW AN ATTENDANCE ROW GOT HERE ──────────────────────────────────────────
-- 'snapshot' — read out of a voice channel when attendance was taken.
-- 'late'     — added afterwards by an officer approving a late request.
--
-- Stored explicitly rather than inferred from joined_at. A snapshot stamps one
-- identical timestamp on every row, so "later than its siblings" LOOKS like a
-- reliable tell — until someone re-snaps a channel, or a backfill rewrites the
-- column, and every past late approval quietly becomes indistinguishable.
--
-- NOT NULL with a default, so the existing rows are correct without a backfill:
-- everything written before this migration came from a voice snapshot.
alter table event_attendance add column if not exists source text not null default 'snapshot';

-- ── LATE ATTENDANCE REQUESTS ────────────────────────────────────────────────
-- A member who was there but isn't in the snapshot asks to be added; an officer
-- decides. The request is kept after the decision rather than deleted — "who
-- has been asking every week" and "who turned them down" are the questions this
-- table exists to be able to answer, and both are gone if a denial deletes the
-- row.
--
-- attendance_id points at the event_attendance row an approval created, so an
-- approval can be traced to its cause (and so a re-run can tell it already did
-- the work). Deliberately NOT a foreign key: an officer deleting an attendance
-- row must not cascade into the decision record that explains it.
create table if not exists late_attendance_requests (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  discord_id text not null,
  display_name text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  attendance_id uuid
);

-- The officer queue's query: this guild's pending requests, newest first.
create index if not exists late_requests_guild_status_idx
  on late_attendance_requests (guild_id, status, requested_at desc);

-- The member's own history, for "have I already asked about this one".
create index if not exists late_requests_guild_discord_idx
  on late_attendance_requests (guild_id, discord_id, requested_at desc);

-- One LIVE ask per person per event — a partial index, so a decided request
-- doesn't block a re-ask (a denial that was a misunderstanding should be
-- appealable). This is the duplicate check: doing it with a SELECT first would
-- lose the race between two clicks on a slow connection, which is exactly how
-- double-submits happen.
create unique index if not exists late_requests_one_pending_idx
  on late_attendance_requests (event_id, discord_id) where status = 'pending';

-- Same posture as every other table on this line: RLS on, no policies, and the
-- service_role key the server uses bypasses it. The real tenant boundary is
-- tenantDb() in application code, which the leak audit enforces statically.
alter table late_attendance_requests enable row level security;
