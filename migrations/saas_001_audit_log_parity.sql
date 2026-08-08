-- saas_001_audit_log_parity.sql — restore the two audit_log columns the
-- multi-tenant baseline dropped.
--
-- Lineage note: migrations 000–012 in this folder are the SINGLE-TENANT schema.
-- The multi-tenant rewrite starts from saas_000_baseline.sql, which was applied
-- directly in the Supabase SQL editor and is not committed here. This is the
-- first tracked migration on top of that baseline.
--
-- WHY THIS EXISTS
-- The SaaS baseline rebuilt audit_log as:
--     (id, guild_id, actor_id, actor_name, action, method, path, body,
--      created_at)
-- renaming discord_id/display_name -> actor_id/actor_name, adding a NOT NULL
-- `action`, and dropping `feature` and `status_code` entirely. But
-- backend/auditLog.js still wrote all four of the old names and never wrote
-- `action`, so EVERY audit insert failed. The failure was invisible: the insert
-- deliberately swallows its error so a logging fault can't crash the server, so
-- the log simply stayed empty.
--
-- `action` needs no migration — the code now populates it ("POST /loot/awards").
-- It is the baseline's only NOT NULL description column, method and path both
-- being nullable there.
--
-- The rename is the baseline's call and the code now follows it (auditLog.js
-- writes actor_id/actor_name and aliases them back to the old names on read, so
-- the API response shape and the viewer page are unchanged). But the two DROPPED
-- columns are real features with no equivalent, so they come back here:
--
--   feature      — the human-readable label the viewer's filter dropdown is
--                  built from (frontend/src/pages/AuditLog.jsx). Without it the
--                  filter has nothing to populate and the column renders "—".
--   status_code  — the HTTP status the logged request finished with. Only 2xx
--                  responses are logged today, so it looks constant, but it is
--                  the record of WHAT the server actually answered, which is the
--                  part an audit trail exists to preserve.
--
-- Run this in the Supabase SQL editor.

-- Both nullable, unlike the single-tenant 001_audit_log.sql where status_code
-- was NOT NULL. Any rows written before this migration genuinely have no value
-- for either, and a synthetic default (0, '') would be a lie in an audit table.
-- The application always supplies both.
alter table audit_log add column if not exists feature text;
alter table audit_log add column if not exists status_code int;

comment on column audit_log.feature is
  'Human-readable label derived from the request path prefix (see FEATURE_PREFIXES in backend/auditLog.js). Frozen at write time.';
comment on column audit_log.status_code is
  'HTTP status the logged request finished with. Only 2xx are recorded today.';

-- The viewer's primary query is "this guild's entries, newest first", then
-- optionally narrowed by actor or feature. Every index is guild_id-leading:
-- a bare (created_at) index would make one tenant's page scan every tenant's
-- rows. `if not exists` so this is safe to re-run and safe regardless of which
-- indexes saas_000_baseline.sql already created.
create index if not exists audit_log_guild_created_idx
  on audit_log (guild_id, created_at desc);
create index if not exists audit_log_guild_actor_idx
  on audit_log (guild_id, actor_id);
create index if not exists audit_log_guild_feature_idx
  on audit_log (guild_id, feature);
