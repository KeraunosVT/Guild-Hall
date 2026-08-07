-- 012_atomic_event_save.sql — create an attendance event and its rows in one
-- transaction.
--
-- createEvent() did two inserts and, if the second failed, deleted the first as
-- a compensating action. That's a rollback you have to get right by hand, and it
-- has its own failure mode: if the compensating delete also fails (connection
-- dropped, database busy — exactly when the first failure is likeliest), you're
-- left with an event showing zero attendees and no error trail explaining it.
--
-- Same reasoning that made save_match() a function. A Postgres function body is
-- a single transaction, so either both inserts land or neither does, and there
-- is no cleanup path to get wrong.
--
-- Run this in the Supabase SQL editor.

create or replace function save_event(
  p_id uuid,
  p_title text,
  p_event_date date,
  p_event_schedule_id uuid,
  p_attendees jsonb
) returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  insert into events (id, title, event_date, event_schedule_id, created_at)
  values (p_id, p_title, p_event_date, p_event_schedule_id, now());

  -- gen_random_uuid() per row and now() for joined_at, so the caller doesn't
  -- have to mint ids client-side the way the two-insert version did.
  insert into event_attendance (id, event_id, discord_id, display_name, joined_at)
  select gen_random_uuid(), p_id, a->>'id', left(coalesce(a->>'name', ''), 120), now()
  from jsonb_array_elements(p_attendees) as a;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
