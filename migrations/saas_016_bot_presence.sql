-- saas_016_bot_presence.sql — notice when the bot is removed from a guild's server.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_015.
--
-- A guild whose Discord server no longer has the Guild Hall bot keeps working
-- on the website, but everything Discord-side quietly stops: slash commands,
-- roster/LOA/signup posts, attendance snapshots, role lookups. Nothing used to
-- record that, so nobody — the guild's officers or staff — found out until
-- something failed to post.
--
-- bot_removed_at is set when the bot leaves (or is kicked from) the server and
-- cleared when it's added back (backend/discordGateway.js, which also
-- reconciles every guild on connect, to catch changes made while it was
-- offline). Officers see a banner with a link to add it back; staff see it on
-- the Guilds page and get a message in the staff channel.

begin;

alter table guilds add column if not exists bot_removed_at timestamptz;

commit;
