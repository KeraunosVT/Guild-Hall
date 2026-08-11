-- saas_003_signup_mentions.sql — ping a Discord role when signups open.
--
-- Run this in the Supabase SQL editor of BOTH projects (the app one and the
-- scratch one the test harness targets). Two columns, no functions.
--
-- ── WHY THIS IS A COLUMN AND NOT A SETTING READ AT SEND TIME ────────────────
-- The role is resolved once, when the announcement is created, and stored on
-- the occurrence — the same reasoning as channel_id directly above it. An
-- officer changing the guild default later must move the NEXT signup without
-- rewriting what an already-posted message says it notified. A post is a
-- historical record of who was called; it is not a live view of configuration.
--
-- ── WHY NULL IS A REAL VALUE, NOT "UNSET" ───────────────────────────────────
-- NULL on event_signups means "this occurrence pings nobody", chosen at create
-- time. It does NOT fall back to the guild default — the fallback happens once,
-- in application code, while the row is being built. Falling back at post time
-- instead would make "no ping" impossible to express for a guild that has a
-- default set, which is the more common request of the two.
alter table event_signups add column if not exists mention_role_id text;

-- The guild's default. NULL means signups ping nobody unless an officer picks a
-- role for that specific occurrence.
--
-- Per-guild config lives on the guilds row, never in an environment variable:
-- one deployment serves many guilds, and a role snowflake from one Discord
-- server means nothing in another.
alter table guilds add column if not exists signup_mention_role_id text;

-- No index: this column is only ever read alongside the row it hangs off, and
-- nothing filters by it.
--
-- No check constraint on the shape either. It is validated as a snowflake in
-- guildSettings.js and eventSignups.js, and the one value that is deliberately
-- NOT a "normal" role — the @everyone role, whose id equals the Discord guild
-- id — has to remain storable here.
