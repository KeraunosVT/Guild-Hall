-- 001_audit_log.sql — Audit log of admin-area writes.
-- This is the first tracked migration in this repo; earlier schema changes
-- (including the save_match() function referenced in backend/admin.js's
-- comments) were applied directly in Supabase's SQL editor and were never
-- committed, so there is no true "000" to reference here.
--
-- Run this in the Supabase SQL editor.

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,        -- the acting admin's name AS OF the action — frozen,
                             -- never re-resolved against current identity state
                             -- (unlike loot_awards/loa_entries, which re-resolve
                             -- live via identities.js).
  method text not null,
  path text not null,       -- relative to /api/admin, e.g. "/loot/awards/abc-123"
  feature text,             -- human-readable label derived from path prefix
  body jsonb,               -- sanitized req.body snapshot; empty for DELETEs,
                             -- since every DELETE route in admin.js identifies
                             -- its target via req.params, not body.
  status_code int not null,
  created_at timestamptz not null default now()
);

create index audit_log_created_at_idx on audit_log (created_at desc);
create index audit_log_discord_id_idx on audit_log (discord_id);
