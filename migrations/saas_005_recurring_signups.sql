-- saas_005_recurring_signups.sql — let a scheduled event open its own signups.
--
-- Run this in the Supabase SQL editor of BOTH projects (the app one and the
-- scratch one the test harness targets).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
-- event_schedule already holds the recurrence: a name, a day of week, and a
-- time. What was missing was anyone to act on it — an officer opened every
-- Saturday's raid call by hand, and the week they forgot, the guild found out
-- by nobody signing up. These columns say "and open signups for it", and the
-- gateway's sweep does the opening.
--
-- The signup settings live HERE rather than being re-typed per occurrence for
-- the same reason the recurrence itself does: a weekly raid has one capacity
-- and one reminder lead, and the place to change them is the place that
-- describes the raid.
--
-- ── WHY THE LEDGER TABLE IS NOT REDUNDANT ───────────────────────────────────
-- There is already a partial unique index on
--     event_signups (guild_id, event_schedule_id, event_date)
-- which stops two sweeps opening the same night twice. That is NOT enough,
-- because it only holds while the row exists. An officer who deletes an
-- auto-opened signup — cancelled raid, wrong capacity, whatever — would have it
-- silently re-created within five minutes, forever, with no way to stop it
-- short of turning the feature off.
--
-- signup_auto_opens is the record that this occurrence WAS opened once, and it
-- outlives the signup it opened (the FK nulls rather than cascades). The sweep
-- reads this table, never event_signups, to decide what still needs doing. So:
--   · deleted by an officer  -> ledger row remains -> never resurrected
--   · opened by hand first   -> sweep's create() hits the unique index, keeps
--                               the ledger row, and leaves the officer's alone
-- Inserting the ledger row BEFORE creating the signup is also what makes the
-- claim atomic across processes: two sweeps race on the primary key, one gets
-- 23505 and stops. Same shape as the reminder claim in saas_002.

-- ── RECURRENCE SETTINGS ─────────────────────────────────────────────────────

alter table event_schedule
  -- Off for every existing schedule. Turning this on is a per-event decision an
  -- officer makes deliberately; a migration that started posting to Discord on
  -- its own would be a surprise of exactly the wrong kind.
  add column if not exists signup_auto_open boolean not null default false,
  -- How far ahead the occurrence opens. Bounded because both ends are wrong:
  -- 0 would open it as it starts, and a year ahead is a signup nobody remembers
  -- committing to. A week is the default because it is one cycle of a weekly
  -- event — the next one opens about as the last one closes.
  add column if not exists signup_open_days_ahead int not null default 7
    check (signup_open_days_ahead between 1 and 30),
  -- The rest mirror the columns of the same name on event_signups; they are
  -- copied onto each occurrence as it is created, not read live from here.
  -- A capacity changed today must not silently re-cap a signup people have
  -- already been promoted into (see signup_set_capacity's refusal to demote).
  add column if not exists signup_capacity int
    check (signup_capacity is null or signup_capacity > 0),
  add column if not exists signup_reminder_lead_minutes int
    check (signup_reminder_lead_minutes is null or signup_reminder_lead_minutes > 0),
  -- NULL means this recurrence pings nobody. It does NOT mean "fall back to the
  -- guild default" — the same distinction saas_003 draws for event_signups, and
  -- for the same reason: a guild with a default set needs a way to say quiet.
  add column if not exists signup_mention_role_id text;

-- Auto-opening needs a time to open at: the occurrence's starts_at is what the
-- reminder and the auto-close are both measured against, and an event with no
-- time has no such instant. Enforced here as well as in the settings route
-- because the route is not the only thing that can write this row.
alter table event_schedule drop constraint if exists event_schedule_auto_needs_time;
alter table event_schedule add constraint event_schedule_auto_needs_time
  check (signup_auto_open = false or event_time is not null);

-- ── THE CLAIM LEDGER ────────────────────────────────────────────────────────

create table if not exists signup_auto_opens (
  guild_id uuid not null references guilds (id) on delete cascade,
  event_schedule_id uuid not null references event_schedule (id) on delete cascade,
  -- The guild NIGHT, matching event_signups.event_date — not the calendar day
  -- a 12:30am event lands on.
  event_date date not null,
  -- What the claim produced. Nullable in two distinct situations, both normal:
  -- the row was claimed but the signup then turned out to already exist (opened
  -- by hand), or the signup has since been deleted. Neither means "try again".
  signup_id uuid references event_signups (id) on delete set null,
  created_at timestamptz not null default now(),
  -- The claim itself. Two sweeps inserting at once: one wins, one gets 23505.
  primary key (guild_id, event_schedule_id, event_date)
);

-- The sweep's read is "which of these candidate dates have I already done for
-- this schedule", which the primary key's leading columns already serve.

alter table signup_auto_opens enable row level security;
grant all on signup_auto_opens to service_role;
