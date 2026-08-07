-- 004_roster_event_binding.sql — binds a saved roster to the occasion it was
-- built for, so loading it can re-check LOA against that date/event instead of
-- against whatever "today" happens to be.
--
-- Both columns are nullable: rosters saved before this migration have no
-- occasion, and load treats them as before (no re-check, no diff banner).
-- event_schedule_id stays null for a roster built for a whole date rather than
-- one scheduled event — the same "all events" scope the party builder's event
-- dropdown already means by an empty value.
--
-- Run this in the Supabase SQL editor.

alter table rosters add column event_date date;
alter table rosters add column event_schedule_id uuid
  references event_schedule (id) on delete set null;
