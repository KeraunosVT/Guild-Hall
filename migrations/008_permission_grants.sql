-- 008_permission_grants.sql — granular admin capabilities.
--
-- Replaces a single isAdmin boolean with named capabilities, granted either to
-- a Discord role (everyone holding it inherits) or to one person directly.
--
-- Roles are the primary mechanism because they self-maintain: strip the role in
-- Discord and the access goes with it. Per-person grants are the exception, for
-- giving one member something without inventing a Discord role for them — but
-- they don't self-clean, so the UI flags grants whose subject is no longer in
-- the guild.
--
-- subject_label is a display snapshot, not a key. Role names and member names
-- are resolved live from Discord; this keeps a stale grant readable when the
-- role has been deleted or the member has left, the same reason
-- lucent_requests.item_name is stored alongside item_key.
--
-- Nothing changes when this table is empty: DISCORD_ADMIN_ROLE_IDS still grants
-- every capability, so existing admins are unaffected until grants are added.
-- That env var stays the way in — it's deliberately not editable from the site,
-- so a bad grant can't lock everyone out.
--
-- Run this in the Supabase SQL editor.

create table permission_grants (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('role', 'user')),
  subject_id text not null,
  subject_label text,
  permission text not null,
  granted_by text,
  granted_at timestamptz not null default now(),
  unique (subject_type, subject_id, permission)
);

create index permission_grants_subject_idx on permission_grants (subject_type, subject_id);
