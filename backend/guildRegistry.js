'use strict';

// ── TENANT REGISTRY LOOKUP ───────────────────────────────────────────────────
// Maps a Discord server id to its Guild Hall tenant row. This is the bot-side
// twin of the HTTP resolveGuild middleware: an interaction arrives carrying
// only interaction.guildId (a Discord snowflake), and everything downstream
// needs the guilds.id uuid to scope by.
//
// Task 12 in the plan calls this the highest-risk piece in the project, because
// a missed resolution here doesn't fail — it writes one guild's data into
// another's. So the contract is deliberately blunt: this returns a row or null,
// and callers must refuse to proceed on null rather than falling back to any
// kind of default guild.
//
// The cache is keyed by discord_guild_id, which is the unique column on guilds.
// It caches the *mapping*, not guild data, so it can't serve one tenant's
// content to another — the worst a stale entry does is briefly miss a
// just-registered server or keep a just-suspended one alive for the TTL.

const CACHE_TTL_MS = (parseInt(process.env.GUILD_REGISTRY_CACHE_SECONDS, 10) || 60) * 1000;

const cache = new Map(); // discord_guild_id -> { row, at }

// The columns every caller needs: the uuid to scope by, plus the per-guild
// config that used to live in shared/guild.json and the DISCORD_* env vars
// (plan task 9). Selected explicitly so a schema addition can't silently start
// shipping secrets into logs.
const COLUMNS = [
  'id', 'discord_guild_id', 'house', 'tag', 'aliases', 'timezone', 'day_start',
  // Branding, served to the browser by GET /api/guild. Omitting these made that
  // endpoint return null for every guild's motto and creed — the values were on
  // the row, just never selected.
  'motto', 'creed',
  'admin_role_ids', 'allowed_role_ids', 'member_role_ids',
  // Every channel the bot posts to. A column added to `guilds` but forgotten
  // HERE does not error — it arrives as undefined on every resolved row, so the
  // feature reading it silently behaves as if it were never configured. That is
  // what happened to signup_channel_id: posts fell back to the announce channel
  // no matter what was set, and the settings form would then have saved that
  // undefined back over the real value.
  'roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'signup_channel_id', 'status',
].join(', ');

async function resolveByDiscordId(supabase, discordGuildId) {
  if (!supabase || !discordGuildId) return null;

  const hit = cache.get(discordGuildId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;

  const { data, error } = await supabase
    .from('guilds').select(COLUMNS).eq('discord_guild_id', String(discordGuildId)).maybeSingle();

  if (error) {
    // Serve a stale mapping rather than dropping a working guild on a blip, but
    // never invent one: a cold cache with a broken database resolves to null,
    // which callers treat as "not registered" and refuse.
    console.error('guildRegistry lookup failed:', error.message);
    return hit ? hit.row : null;
  }

  // A suspended tenant resolves to null — same treatment as unregistered, so
  // billing/abuse suspension needs no separate check at every call site.
  const row = data && data.status === 'active' ? data : null;
  cache.set(discordGuildId, { row, at: Date.now() });
  return row;
}

// The same lookup keyed by the tenant uuid, for the HTTP side: the session
// (or SINGLE_GUILD_ID) yields a guilds.id, and handlers need the timezone and
// day_start off that row, not just the id — the guild-night rollover in loa.js
// is per-guild config now, not a process-wide constant.
const byId = new Map(); // guilds.id -> { row, at }

async function resolveById(supabase, guildId) {
  if (!supabase || !guildId) return null;

  const hit = byId.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;

  const { data, error } = await supabase
    .from('guilds').select(COLUMNS).eq('id', guildId).maybeSingle();

  if (error) {
    console.error('guildRegistry lookup failed:', error.message);
    return hit ? hit.row : null;
  }

  const row = data && data.status === 'active' ? data : null;
  byId.set(guildId, { row, at: Date.now() });
  return row;
}

// Which of these Discord servers do we host? Login asks this with the user's
// whole Discord server list, which for an active account can be a hundred ids —
// so it is one `in` query, not a hundred cached point lookups. A cold cache
// with resolveByDiscordId in a loop would put 100 round-trips on the login path.
//
// Only hosted, active guilds come back, so the caller never learns anything
// about servers we don't host — it just gets a shorter list than it sent.
async function resolveManyByDiscordIds(supabase, discordGuildIds) {
  if (!supabase || !Array.isArray(discordGuildIds) || !discordGuildIds.length) return [];

  const ids = [...new Set(discordGuildIds.map(String))];
  const { data, error } = await supabase
    .from('guilds').select(COLUMNS).in('discord_guild_id', ids).eq('status', 'active');

  if (error) {
    // No stale fallback here: this decides which guilds a session may touch, and
    // a half-remembered answer is worse than making the user sign in again.
    console.error('guildRegistry bulk lookup failed:', error.message);
    return [];
  }

  const rows = data || [];
  // Warm the point-lookup cache too — resolveById runs on every request that
  // follows, and login has just paid for these rows.
  const at = Date.now();
  rows.forEach((row) => {
    cache.set(String(row.discord_guild_id), { row, at });
    byId.set(row.id, { row, at });
  });
  return rows;
}

// Call after a guilds row is created, edited, or suspended. Clears both indexes
// since one row lives in each.
function invalidate(discordGuildId) {
  if (discordGuildId) cache.delete(String(discordGuildId));
  else cache.clear();
  byId.clear();
}

module.exports = { resolveByDiscordId, resolveById, resolveManyByDiscordIds, invalidate };
