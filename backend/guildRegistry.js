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
  'admin_role_ids', 'allowed_role_ids', 'member_role_ids',
  'roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'status',
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

// Call after a guilds row is created, edited, or suspended. Clears both indexes
// since one row lives in each.
function invalidate(discordGuildId) {
  if (discordGuildId) cache.delete(String(discordGuildId));
  else cache.clear();
  byId.clear();
}

module.exports = { resolveByDiscordId, resolveById, invalidate };
