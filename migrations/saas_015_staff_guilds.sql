-- saas_015_staff_guilds.sql — the staff Guilds page.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_014.
--
-- Guild Hall staff can now suspend, reactivate and comp guilds from the app
-- (backend/staffGuilds.js) instead of the SQL editor. This adds what that
-- needs and nothing else:
--
--   · billing_exempt — a comped guild. Never suspended for billing, whatever
--     its subscription does. Before this, "comped" only meant "has no
--     subscription row", which couldn't be applied to a guild that already
--     had one (a partner, a refund dispute, a guild staff want to keep open).
--   · suspended_note / suspended_by / suspended_at — why staff suspended a
--     guild, who did, and when. Internal only: officers of a suspended guild
--     are told nothing (see hasBillingSuspendedGuild in backend/auth.js).

begin;

alter table guilds add column if not exists billing_exempt boolean not null default false;
alter table guilds add column if not exists suspended_note text;
alter table guilds add column if not exists suspended_by text;
alter table guilds add column if not exists suspended_at timestamptz;

-- The lapse sweep now skips comped guilds. Otherwise identical to saas_014.
create or replace function billing_suspend_lapsed()
returns table (discord_guild_id text)
language sql
as $$
  update guilds g set
    status = 'suspended',
    suspended_reason = 'billing',
    suspended_at = now(),
    suspended_by = null,
    suspended_note = null,
    updated_at = now()
  from subscriptions s
  where s.guild_id = g.id
    and s.grace_until is not null
    and s.grace_until <= now()
    and g.status = 'active'
    and not g.billing_exempt
  returning g.discord_guild_id;
$$;

grant execute on function billing_suspend_lapsed() to service_role;

commit;
