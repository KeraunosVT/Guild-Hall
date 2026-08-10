-- saas_002_event_signups.sql — opt-in attendance signups for a dated occurrence
-- of a scheduled event.
--
-- Lineage note: migrations 000–012 in this folder are the SINGLE-TENANT schema.
-- The multi-tenant line starts at saas_000_baseline.sql; this is the second
-- tracked migration on top of it. Run it in the Supabase SQL editor.
--
-- ── THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS ────────────────────────
-- A signup row means "I am coming". There is no row for "I am not coming".
-- Absence is the LOA system's job (loa_entries), and it already models the
-- three shapes an absence takes (one-off, range, recurring, each optionally
-- time-scoped). Recording it a second time here would give officers two
-- records that can disagree, with no rule for which wins.
--
-- So the status check is deliberately narrow:
--     check (status in ('going', 'waitlist'))
-- Adding 'declined' or 'maybe' therefore cannot happen as a drive-by change in
-- application code — it needs a migration, which is a place to have the
-- argument. The absence of a row is "hasn't answered", and the reminder sweep
-- reads exactly that: no entry AND no LOA means nobody knows either way.
--
-- ── WHY THE WRITES ARE FUNCTIONS ──────────────────────────────────────────
-- Capacity is a race. Two members clicking the last slot both read "5 of 6
-- taken" and both insert, and the event is over-full with no error anywhere.
-- Every mutation below therefore takes `select … for update` on the PARENT
-- event_signups row first, which serialises all of that occurrence's joins,
-- withdrawals and capacity edits against each other — and only those. Locking
-- one row rather than the table means a busy Saturday's six concurrent signups
-- don't queue behind each other.

-- ── TABLES ──────────────────────────────────────────────────────────────────

create table if not exists event_signups (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  -- Which recurring event this is an occurrence of. Nullable: a one-off
  -- ("Saturday siege practice") is a legitimate thing to open signups for.
  -- ON DELETE SET NULL matches events/rosters — removing a schedule entry must
  -- not delete the attendance history hanging off it.
  event_schedule_id uuid references event_schedule (id) on delete set null,
  title text not null,
  -- The instant it begins, in UTC. This is what the auto-close and the reminder
  -- lead time are measured against, so it is a timestamptz and never a local
  -- string — an event at 00:30 has to compare correctly against "now".
  starts_at timestamptz not null,
  -- The GUILD NIGHT this belongs to, not necessarily starts_at's calendar day:
  -- the 12:30am field boss is Saturday night's last event. Stored rather than
  -- derived because attendance reconciliation and LOA both key off this date,
  -- and re-deriving the rollover in three places is how they drift apart.
  event_date date not null,
  -- NULL = uncapped. Lowering it never demotes anyone (see signup_set_capacity).
  capacity int check (capacity is null or capacity > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  -- Where the announcement actually landed, resolved once at post time. Keeping
  -- it on the row rather than re-reading the guild's configured channel means
  -- changing that setting later moves NEW signups without orphaning the buttons
  -- on posts already out there.
  channel_id text,
  message_id text,
  -- Minutes before starts_at to DM the undecided. NULL = no reminder.
  reminder_lead_minutes int check (reminder_lead_minutes is null or reminder_lead_minutes > 0),
  -- Claimed (set) BEFORE the DMs go out, by a conditional update. That is what
  -- makes a duplicate batch impossible across two sweeps, two processes, and
  -- the manual "Remind" button — they all contend for this one field.
  reminder_sent_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_signups_guild_starts_idx on event_signups (guild_id, starts_at desc);
-- The sweep's two queries are cross-guild and time-ordered, so they get their
-- own index without guild_id leading.
create index if not exists event_signups_open_starts_idx on event_signups (starts_at) where status = 'open';
-- One signup per occurrence: re-posting must reuse the row, not make a second
-- one that splits the attendee list in half. Partial, because a one-off signup
-- has no schedule id and several of those on one night are fine.
create unique index if not exists event_signups_occurrence_idx
  on event_signups (guild_id, event_schedule_id, event_date)
  where event_schedule_id is not null;

create table if not exists event_signup_entries (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references guilds (id) on delete cascade,
  signup_id uuid not null references event_signups (id) on delete cascade,
  discord_id text not null,
  display_name text,
  -- OPT-IN ONLY. See the header. Widening this is a migration, on purpose.
  status text not null check (status in ('going', 'waitlist')),
  -- FIFO ordering for the waitlist. joined_at alone is not enough: two inserts
  -- in the same millisecond tie, and a tie in a queue is a coin flip over who
  -- gets promoted. An identity column is monotonic by construction.
  seq bigint generated by default as identity,
  joined_at timestamptz not null default now(),
  -- NULL when the member signed themselves up; the officer's name when they
  -- were added on someone's behalf.
  added_by text,
  -- Belt and braces over the functions' own guard: one entry per member per
  -- occurrence, so a double-clicked button can never make two rows.
  unique (signup_id, discord_id)
);

create index if not exists event_signup_entries_signup_idx on event_signup_entries (signup_id, status, seq);
create index if not exists event_signup_entries_guild_discord_idx on event_signup_entries (guild_id, discord_id);

-- Place in the queue, 1-based; 0 for a confirmed slot or no entry at all.
-- Defined before its callers because join and withdraw both reference it, and
-- every read needs the same answer — a waitlist that numbers people one way in
-- Discord and another way on the website is worse than one that doesn't number
-- them at all.
create or replace function signup_waitlist_position(p_signup_id uuid, p_discord_id text)
returns int
language sql stable
as $$
  select coalesce((
    select pos from (
      select e.discord_id, row_number() over (order by e.seq) as pos
      from event_signup_entries e
      where e.signup_id = p_signup_id and e.status = 'waitlist'
    ) ranked
    where ranked.discord_id = p_discord_id
  ), 0)::int;
$$;

-- ── JOIN ────────────────────────────────────────────────────────────────────
-- Returns a result CODE rather than raising, so the caller branches on data
-- instead of pattern-matching an error message across a PostgREST boundary.
--   result: 'ok' | 'already' | 'closed' | 'not_found'
--   entry_status: 'going' | 'waitlist' (null when result isn't ok/already)
--   waitlist_position: 1-based place in the queue, or 0 for a confirmed slot
--
-- Idempotent: joining twice is 'already' with the current standing, never a
-- second row and never a silent demotion of a slot already held.
--
-- The third column is NOT called `position`: that is a col_name_keyword in
-- Postgres, which may name a table column but may not name an OUT parameter —
-- RETURNS TABLE parses those as type_function_name, and the whole migration
-- fails with a syntax error pointing at the word itself.
create or replace function signup_join(
  p_guild_id uuid,
  p_signup_id uuid,
  p_discord_id text,
  p_display_name text,
  p_added_by text
) returns table (result text, entry_status text, waitlist_position int)
language plpgsql
as $$
declare
  v_capacity int;
  v_status text;
  v_going int;
  v_existing text;
  v_new text;
begin
  -- FOR UPDATE on the parent is the whole concurrency story: every other
  -- mutation for this occurrence blocks here until this one commits, so the
  -- count below cannot go stale between reading it and inserting.
  select capacity, status into v_capacity, v_status
  from event_signups
  where id = p_signup_id and guild_id = p_guild_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, 0;
    return;
  end if;

  select e.status into v_existing
  from event_signup_entries e
  where e.signup_id = p_signup_id and e.discord_id = p_discord_id;

  if found then
    return query
      select 'already'::text, v_existing, signup_waitlist_position(p_signup_id, p_discord_id);
    return;
  end if;

  -- Checked AFTER the existing-entry lookup so someone already signed up still
  -- gets their standing back from a closed occurrence rather than a bare error.
  if v_status <> 'open' then
    return query select 'closed'::text, null::text, 0;
    return;
  end if;

  select count(*) into v_going
  from event_signup_entries e
  where e.signup_id = p_signup_id and e.status = 'going';

  v_new := case when v_capacity is null or v_going < v_capacity then 'going' else 'waitlist' end;

  insert into event_signup_entries (guild_id, signup_id, discord_id, display_name, status, added_by)
  values (p_guild_id, p_signup_id, p_discord_id, left(coalesce(p_display_name, ''), 120), v_new, p_added_by);

  return query
    select 'ok'::text, v_new, signup_waitlist_position(p_signup_id, p_discord_id);
end;
$$;

-- ── WITHDRAW ────────────────────────────────────────────────────────────────
-- Returns you to undecided — it does NOT record a decline (see the header).
-- Giving up a confirmed slot promotes the longest-waiting person into it, in
-- the same transaction, so the slot can't be lost or double-filled.
--
-- Allowed on a closed occurrence on purpose: withdrawal only ever frees
-- capacity, and an officer correcting a mistake after the event started
-- shouldn't have to reopen it.
--   result: 'ok' | 'absent' | 'not_found'
create or replace function signup_withdraw(
  p_guild_id uuid,
  p_signup_id uuid,
  p_discord_id text
) returns table (result text, was_status text, promoted_discord_id text, promoted_display_name text)
language plpgsql
as $$
declare
  v_capacity int;
  v_was text;
  v_promoted_id text;
  v_promoted_name text;
begin
  select capacity into v_capacity
  from event_signups
  where id = p_signup_id and guild_id = p_guild_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, null::text, null::text;
    return;
  end if;

  delete from event_signup_entries e
  where e.signup_id = p_signup_id and e.discord_id = p_discord_id
  returning e.status into v_was;

  if not found then
    return query select 'absent'::text, null::text, null::text, null::text;
    return;
  end if;

  -- Only a vacated CONFIRMED slot can be filled. Someone leaving the waitlist
  -- moves everyone behind them up by definition; nobody changes status.
  if v_was = 'going' and v_capacity is not null then
    update event_signup_entries
    set status = 'going'
    where id = (
      select e.id from event_signup_entries e
      where e.signup_id = p_signup_id and e.status = 'waitlist'
      order by e.seq
      limit 1
    )
    returning discord_id, display_name into v_promoted_id, v_promoted_name;
  end if;

  return query select 'ok'::text, v_was, v_promoted_id, v_promoted_name;
end;
$$;

-- ── CAPACITY ────────────────────────────────────────────────────────────────
-- Raising it (or clearing it) promotes from the front of the queue until the
-- new cap is met. Lowering it NEVER demotes: someone who was told they had a
-- slot has already planned their evening around it, and taking it back
-- silently because an officer typed 18 instead of 24 is the worse failure. The
-- lower cap governs new joins from that moment on.
--   result: 'ok' | 'not_found'
create or replace function signup_set_capacity(
  p_guild_id uuid,
  p_signup_id uuid,
  p_capacity int
) returns table (result text, promoted int)
language plpgsql
as $$
declare
  v_going int;
  v_room int;
  v_promoted int := 0;
begin
  perform 1 from event_signups
  where id = p_signup_id and guild_id = p_guild_id
  for update;

  if not found then
    return query select 'not_found'::text, 0;
    return;
  end if;

  update event_signups
  set capacity = p_capacity, updated_at = now()
  where id = p_signup_id and guild_id = p_guild_id;

  select count(*) into v_going
  from event_signup_entries e
  where e.signup_id = p_signup_id and e.status = 'going';

  if p_capacity is null then
    v_room := (select count(*) from event_signup_entries e
               where e.signup_id = p_signup_id and e.status = 'waitlist');
  else
    v_room := p_capacity - v_going;
  end if;

  if v_room > 0 then
    with promote as (
      select e.id from event_signup_entries e
      where e.signup_id = p_signup_id and e.status = 'waitlist'
      order by e.seq
      limit v_room
    )
    update event_signup_entries e
    set status = 'going'
    from promote
    where e.id = promote.id;
    get diagnostics v_promoted = row_count;
  end if;

  return query select 'ok'::text, v_promoted;
end;
$$;

-- ── REMINDER CLAIM (one occurrence, for the manual button) ──────────────────
-- True exactly once. The guards are the point:
--   reminder_sent_at is null — nobody has claimed it yet
--   status = 'open'          — a finished event doesn't chase anyone
--   starts_at > now()        — a process that was down for six hours must not
--                              wake up and DM the guild about events that have
--                              already been and gone
create or replace function signup_claim_reminder(p_guild_id uuid, p_signup_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_claimed uuid;
begin
  update event_signups
  set reminder_sent_at = now()
  where id = p_signup_id
    and guild_id = p_guild_id
    and reminder_sent_at is null
    and status = 'open'
    and starts_at > now()
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

-- ── SWEEP: claim every due reminder, across all guilds ──────────────────────
-- Deliberately NOT guild-scoped: this is the background sweep in the gateway
-- process, which serves every tenant. It is a single UPDATE … RETURNING, so
-- claiming and selecting are the same statement — two sweeps racing cannot
-- both come away with the same row, because the second one's re-check of
-- `reminder_sent_at is null` fails against the first one's committed write.
-- Each returned row carries its own guild_id; the caller must scope everything
-- it then does by that, never by a default.
create or replace function signup_claim_due_reminders()
returns setof event_signups
language sql
as $$
  update event_signups s
  set reminder_sent_at = now()
  where s.status = 'open'
    and s.reminder_lead_minutes is not null
    and s.reminder_sent_at is null
    and s.starts_at > now()
    and s.starts_at <= now() + make_interval(mins => s.reminder_lead_minutes)
  returning s.*;
$$;

-- ── SWEEP: close everything that has started ────────────────────────────────
-- Returns what it closed so the caller can strip the buttons off those posts.
-- Also cross-guild; same rule about scoping by the returned guild_id.
create or replace function signup_close_finished()
returns setof event_signups
language sql
as $$
  update event_signups s
  set status = 'closed', updated_at = now()
  where s.status = 'open' and s.starts_at <= now()
  returning s.*;
$$;

-- ── GUILD CONFIG ────────────────────────────────────────────────────────────
-- Which channel signup posts land in. Per-guild config lives on the guilds row,
-- never in an environment variable: one deployment serves many guilds, and an
-- env var would put every tenant's signups in whichever channel the deployment
-- was configured for. NULL falls back to announce_channel_id at post time.
alter table guilds add column if not exists signup_channel_id text;

-- ── RLS + GRANTS (match the baseline) ───────────────────────────────────────
alter table event_signups enable row level security;
alter table event_signup_entries enable row level security;

grant all on event_signups to service_role;
grant all on event_signup_entries to service_role;
grant execute on function signup_join(uuid, uuid, text, text, text) to service_role;
grant execute on function signup_waitlist_position(uuid, text) to service_role;
grant execute on function signup_withdraw(uuid, uuid, text) to service_role;
grant execute on function signup_set_capacity(uuid, uuid, int) to service_role;
grant execute on function signup_claim_reminder(uuid, uuid) to service_role;
grant execute on function signup_claim_due_reminders() to service_role;
grant execute on function signup_close_finished() to service_role;
