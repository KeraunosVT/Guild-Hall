-- saas_014_billing_onboarding.sql — paid self-serve onboarding.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_013.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────
-- A guild can now add itself, but only after paying. The order is:
--
--   1. a Discord user checks out on Paddle (backend/billing.js);
--   2. Paddle's webhook lands here as a `subscriptions` row with guild_id NULL —
--      an unclaimed SEAT, owned by the Discord user named in the checkout's
--      custom data;
--   3. that user adds the bot to a server and fills in the basics
--      (backend/onboarding.js), and onboard_claim_guild() turns the seat into a
--      `guilds` row in one transaction.
--
-- One seat makes exactly one guild. Guilds with no subscriptions row at all
-- (everything created by scripts/onboardGuild.js, including every guild that
-- predates billing) are comped: nothing in billing ever touches them.
--
-- ── WHY THE STATE CHANGES ARE FUNCTIONS ─────────────────────────────────────
-- Paddle retries, and does not promise order. Two webhooks for one
-- subscription can arrive together, or a `past_due` can land after the
-- `active` that superseded it. Each function below takes its row lock first
-- and refuses anything older than what it has already applied, so the stored
-- state is always the newest one Paddle has told us about.
--
-- ── WHY THESE TABLES ARE GLOBAL ─────────────────────────────────────────────
-- A seat exists before its guild does, so it can't be scoped by guild_id. Both
-- tables are in GLOBAL_TABLES (backend/tenantDb.js); only billing.js and
-- onboarding.js read or write them, and nothing in them reaches a browser
-- except a guild's own status, through the officer billing panel.

begin;

-- ── guilds: who set it up, and why it's suspended ───────────────────────────
alter table guilds add column if not exists created_by text;
alter table guilds add column if not exists terms_accepted_at timestamptz;
-- 'billing' or 'staff'. A payment re-activates only a 'billing' suspension, so
-- paying can never undo a suspension staff applied for abuse.
alter table guilds add column if not exists suspended_reason text;
alter table guilds drop constraint if exists guilds_suspended_reason_valid;
alter table guilds add constraint guilds_suspended_reason_valid
  check (suspended_reason is null or suspended_reason in ('billing', 'staff'));

-- ── subscriptions: one row per Paddle subscription ──────────────────────────
create table if not exists subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  provider                 text not null default 'paddle',
  provider_subscription_id text not null unique,
  provider_customer_id     text,
  -- Who paid. Only this Discord user can claim the seat.
  discord_user_id          text,
  -- NULL until claimed. Unique: one subscription pays for one guild.
  guild_id                 uuid unique references guilds (id) on delete set null,
  status                   text not null,
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  -- Set when a subscription stops being in good standing; the guild is
  -- suspended once it passes. Cleared when it's back in good standing.
  grace_until              timestamptz,
  -- occurred_at of the newest event applied, so an older one arriving late is
  -- ignored rather than rolling the status back.
  last_event_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint subscriptions_status_valid
    check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled'))
);

create index if not exists subscriptions_unclaimed_idx
  on subscriptions (discord_user_id) where guild_id is null;
create index if not exists subscriptions_grace_idx
  on subscriptions (grace_until) where grace_until is not null;

-- ── billing_events: every webhook, once ─────────────────────────────────────
-- The primary key is Paddle's event_id, which is what makes a retried or
-- replayed webhook a no-op.
create table if not exists billing_events (
  event_id     text primary key,
  type         text not null,
  occurred_at  timestamptz,
  received_at  timestamptz not null default now(),
  payload      jsonb not null
);

-- ── billing_apply_subscription ──────────────────────────────────────────────
-- Record one subscription webhook and apply it. Returns:
--   result            'applied' | 'duplicate' | 'stale'
--   discord_guild_id  the claimed guild's Discord id when its status or
--                     suspension changed, so the caller can drop its caches
create or replace function billing_apply_subscription(
  p_event_id        text,
  p_event_type      text,
  p_occurred_at     timestamptz,
  p_payload         jsonb,
  p_subscription_id text,
  p_customer_id     text,
  p_discord_user_id text,
  p_status          text,
  p_trial_ends_at   timestamptz,
  p_period_end      timestamptz,
  p_grace_days      int
) returns table (result text, discord_guild_id text)
language plpgsql
as $$
declare
  v_inserted int;
  v_sub subscriptions%rowtype;
  v_good boolean := p_status in ('trialing', 'active');
  v_guild_discord text;
begin
  insert into billing_events (event_id, type, occurred_at, payload)
  values (p_event_id, p_event_type, p_occurred_at, p_payload)
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select 'duplicate'::text, null::text;
    return;
  end if;

  -- Create the row if this is the first we've heard of it, then lock it, so
  -- two events for one subscription are applied one after the other.
  insert into subscriptions (provider_subscription_id, provider_customer_id, discord_user_id, status)
  values (p_subscription_id, p_customer_id, p_discord_user_id, p_status)
  on conflict (provider_subscription_id) do nothing;

  select * into v_sub from subscriptions
  where provider_subscription_id = p_subscription_id
  for update;

  if v_sub.last_event_at is not null and p_occurred_at < v_sub.last_event_at then
    return query select 'stale'::text, null::text;
    return;
  end if;

  update subscriptions set
    provider_customer_id = coalesce(p_customer_id, provider_customer_id),
    -- The buyer is fixed by the first event that names one. A later event
    -- can't move a seat to someone else.
    discord_user_id = coalesce(discord_user_id, p_discord_user_id),
    status = p_status,
    trial_ends_at = p_trial_ends_at,
    current_period_end = p_period_end,
    grace_until = case
      when v_good then null
      else coalesce(grace_until, now() + make_interval(days => p_grace_days))
    end,
    last_event_at = p_occurred_at,
    updated_at = now()
  where id = v_sub.id;

  if v_sub.guild_id is null then
    return query select 'applied'::text, null::text;
    return;
  end if;

  -- Mirror the status onto the guild, and lift a BILLING suspension on
  -- recovery. A staff suspension is left exactly as it is.
  update guilds g set
    subscription_status = p_status,
    status = case when v_good and g.suspended_reason = 'billing' then 'active' else g.status end,
    suspended_reason = case when v_good and g.suspended_reason = 'billing' then null else g.suspended_reason end,
    updated_at = now()
  where g.id = v_sub.guild_id
  returning g.discord_guild_id into v_guild_discord;

  return query select 'applied'::text, v_guild_discord;
end;
$$;

-- ── billing_suspend_lapsed ──────────────────────────────────────────────────
-- Suspend every active guild whose grace period has run out. Run on a timer.
-- Returns the Discord ids it suspended, for cache invalidation.
create or replace function billing_suspend_lapsed()
returns table (discord_guild_id text)
language sql
as $$
  update guilds g set
    status = 'suspended',
    suspended_reason = 'billing',
    updated_at = now()
  from subscriptions s
  where s.guild_id = g.id
    and s.grace_until is not null
    and s.grace_until <= now()
    and g.status = 'active'
  returning g.discord_guild_id;
$$;

-- ── onboard_claim_guild ─────────────────────────────────────────────────────
-- Turn the caller's unclaimed seat into a guild, atomically. p_guild holds the
-- fields onboarding.js has already validated. Returns:
--   result    'ok' | 'no_seat' | 'already_registered'
--   guild_id  the new guilds.id on 'ok'
create or replace function onboard_claim_guild(
  p_discord_user_id  text,
  p_discord_guild_id text,
  p_guild            jsonb
) returns table (result text, guild_id uuid)
language plpgsql
as $$
declare
  v_sub subscriptions%rowtype;
  v_guild_id uuid;
begin
  -- Lock the oldest usable seat. If two claims race, the second waits here,
  -- then finds the seat no longer unclaimed and gets 'no_seat'.
  select * into v_sub from subscriptions
  where discord_user_id = p_discord_user_id
    and subscriptions.guild_id is null
    and status in ('trialing', 'active')
  order by created_at
  limit 1
  for update;

  if not found then
    return query select 'no_seat'::text, null::uuid;
    return;
  end if;

  begin
    insert into guilds (
      discord_guild_id, house, tag, aliases, timezone, day_start,
      admin_role_ids, allowed_role_ids, member_role_ids,
      status, subscription_status, created_by, terms_accepted_at
    ) values (
      p_discord_guild_id,
      p_guild ->> 'house',
      p_guild ->> 'tag',
      coalesce(p_guild -> 'aliases', '[]'::jsonb),
      p_guild ->> 'timezone',
      p_guild ->> 'day_start',
      coalesce(p_guild -> 'admin_role_ids', '[]'::jsonb),
      coalesce(p_guild -> 'allowed_role_ids', '[]'::jsonb),
      coalesce(p_guild -> 'member_role_ids', '[]'::jsonb),
      'active',
      v_sub.status,
      p_discord_user_id,
      now()
    )
    returning id into v_guild_id;
  exception when unique_violation then
    -- Someone registered this server first. The seat stays unclaimed.
    return query select 'already_registered'::text, null::uuid;
    return;
  end;

  update subscriptions set guild_id = v_guild_id, updated_at = now() where id = v_sub.id;
  return query select 'ok'::text, v_guild_id;
end;
$$;

-- ── RLS + GRANTS (match the baseline) ───────────────────────────────────────
alter table subscriptions enable row level security;
alter table billing_events enable row level security;

grant all on subscriptions to service_role;
grant all on billing_events to service_role;
grant execute on function billing_apply_subscription(text, text, timestamptz, jsonb, text, text, text, text, timestamptz, timestamptz, int) to service_role;
grant execute on function billing_suspend_lapsed() to service_role;
grant execute on function onboard_claim_guild(text, text, jsonb) to service_role;

commit;
