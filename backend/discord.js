// backend/discord.js — Discord bot via REST (no gateway connection).
// Lists guild members filtered to a role (for the party pool) and posts the
// finished roster embed to a channel. Requires a bot token with the
// "Server Members Intent" enabled for member listing.
//
// PER-GUILD (plan tasks 8 and 9)
// Every call takes the guilds row, and every cache is keyed by Discord server
// id. This module used to bind one DISCORD_GUILD_ID and one channel id at
// import time and share a single members cache across the process — which on a
// shared deployment would have served one guild's member list to another, and
// posted every guild's roster into the first guild's channel.
//
// Config comes from the guilds row and nowhere else. There used to be an env
// fallback for the original single-guild deployment; it is gone, because on a
// shared deployment it silently gave one tenant another tenant's channels and
// roles. A row missing a field is a configuration error, and every function
// here says so rather than quietly acting on somebody else's server.
const axios = require('axios');

const API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// The token is the only process-wide requirement now — which guild to act on
// arrives with each call. (One bot, many servers: Model A in the plan.)
const botConfigured = Boolean(BOT_TOKEN);

const authHeaders = () => ({ Authorization: `Bot ${BOT_TOKEN}` });

// ── Per-guild config, from the row only ─────────────────────────────────────
const guildIdOf = (guild) => String((guild && guild.discord_guild_id) || '');
const rosterChannelOf = (guild) => (guild && guild.roster_channel_id) || '';
const memberRolesOf = (guild) => (Array.isArray(guild && guild.member_role_ids)
  ? guild.member_role_ids.map(String).filter(Boolean) : []);

// Resolve the guild id or refuse. Falling back to a configured default here
// would be the worst possible failure: it wouldn't error, it would quietly act
// on the wrong server — post one guild's roster into another's channel, or hand
// back another guild's member list.
function requireGuildId(guild, fn) {
  if (!botConfigured) throw new Error('Discord bot is not configured (set DISCORD_BOT_TOKEN).');
  const id = guildIdOf(guild);
  if (!id) throw new Error(`${fn}: no Discord guild id — pass the guilds row.`);
  return id;
}

// ── Short-lived per-guild cache ─────────────────────────────────────────────
// listMembers() is hit from several routes (roster, players, admin pool,
// awards import), and each uncached call re-paginates the entire guild member
// list — an easy way to trip Discord's rate limits. Cache briefly, dedupe
// concurrent callers onto one fetch, and serve the last good value if a refresh
// fails (a stale roster beats a 502).
//
// Keyed by guild, so one guild's traffic can't evict or answer another's.
const CACHE_TTL_MS = (parseInt(process.env.MEMBER_CACHE_SECONDS, 10) || 60) * 1000;

function makeCache(label) {
  const entries = new Map(); // guildId -> { value, at, inFlight }

  function cached(guildId, fetcher) {
    let e = entries.get(guildId);
    if (!e) { e = { value: null, at: 0, inFlight: null }; entries.set(guildId, e); }

    if (e.value && Date.now() - e.at < CACHE_TTL_MS) return Promise.resolve(e.value);
    if (e.inFlight) return e.inFlight;

    e.inFlight = fetcher()
      .then((value) => { e.value = value; e.at = Date.now(); return value; })
      .catch((err) => {
        if (e.value) {
          console.warn(`${label} refresh failed for guild ${guildId} — serving stale cache:`, err.message);
          return e.value;
        }
        throw err;
      })
      .finally(() => { e.inFlight = null; });

    return e.inFlight;
  }

  // Drop one guild's entry. Only the guild that changed pays the reload —
  // clearing every tenant because one edited its settings would be a
  // self-inflicted thundering herd, same reasoning as permissions.invalidate().
  cached.forget = (guildId) => { entries.delete(guildId); };
  return cached;
}

const membersCache = makeCache('listMembers');
const rolesCache = makeCache('listRoles');

// Call after a guild's Discord wiring changes. member_role_ids decides who is
// even IN listMembers' result, so without this a settings save appears to do
// nothing for up to a minute and the officer saves again.
function invalidateGuild(guild) {
  const id = guildIdOf(guild);
  if (!id) return;
  membersCache.forget(id);
  rolesCache.forget(id);
}

// ── Members ─────────────────────────────────────────────────────────────────
// Every member of the guild (paginated), keeping those with a member role.
async function listMembers(guild) {
  const guildId = requireGuildId(guild, 'listMembers');
  return membersCache(guildId, () => fetchAllMembers(guildId, memberRolesOf(guild)));
}

async function fetchAllMembers(guildId, memberRoles) {
  const members = [];
  let after = '0';
  for (let page = 0; page < 25; page++) { // safety cap (~25k members)
    const res = await axios.get(`${API}/guilds/${guildId}/members`, {
      headers: authHeaders(),
      params: { limit: 1000, after },
    });
    const batch = res.data || [];
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }

  const filtered = memberRoles.length
    ? members.filter((m) => (m.roles || []).some((r) => memberRoles.includes(r)))
    : members;

  return filtered
    .filter((m) => m.user && !m.user.bot)
    .map((m) => ({
      id: m.user.id,
      name: m.nick || m.user.global_name || m.user.username,
      avatar: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
        : null,
      joinedAt: m.joined_at || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Fetch one guild member by user id (for session re-verification).
// Returns { status, member } — 404 means they're no longer in the guild.
//
// Takes a raw Discord server id rather than the row: re-verification walks the
// memberships in a session, which already carry the id. No default — verifying a
// member against an unspecified guild is meaningless.
async function fetchMember(userId, discordGuildId) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  if (!discordGuildId) throw new Error('fetchMember: no guild id.');
  const res = await axios.get(`${API}/guilds/${discordGuildId}/members/${userId}`, {
    headers: authHeaders(),
    validateStatus: (s) => s < 500,
  });
  return { status: res.status, member: res.status === 200 ? res.data : null };
}

// ── Roles ───────────────────────────────────────────────────────────────────
// Every role in the guild, for the permissions page to grant against. Same
// short TTL as listMembers for the same reason — roles change rarely and the
// page re-fetches on every visit.
//
// @everyone is dropped: it's a real role that every member holds, so granting
// against it would hand a capability to the entire guild, which is never what
// someone clicking a row in a permissions grid means to do.
async function listRoles(guild) {
  if (!botConfigured) return [];
  const guildId = guildIdOf(guild);
  if (!guildId) return [];

  return rolesCache(guildId, async () => {
    const { data } = await axios.get(`${API}/guilds/${guildId}/roles`, { headers: authHeaders() });
    return (data || [])
      // The @everyone role's id equals the guild's id — that's the check here,
      // not a comparison against some configured guild.
      .filter((r) => r.id !== guildId && !r.managed)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }))
      .sort((a, b) => b.position - a.position);
  });
}

// ── Posting ─────────────────────────────────────────────────────────────────
function rosterChannel(guild, fn) {
  requireGuildId(guild, fn); // token + guild sanity first
  const channel = rosterChannelOf(guild);
  if (!channel) throw new Error(`${fn}: this guild has no roster channel configured.`);
  return channel;
}

// Post an embed to the guild's roster channel.
async function postEmbed(guild, embed, content) {
  const channel = rosterChannel(guild, 'postEmbed');
  await axios.post(
    `${API}/channels/${channel}/messages`,
    { content: content || undefined, embeds: [embed] },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
}

// Post an image file to the guild's roster channel.
async function postImage(guild, buffer, filename, content) {
  const channel = rosterChannel(guild, 'postImage');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'roster.png', contentType: 'image/png' });
  if (content) form.append('payload_json', JSON.stringify({ content }));
  await axios.post(
    `${API}/channels/${channel}/messages`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
}

module.exports = { listMembers, listRoles, fetchMember, postEmbed, postImage, botConfigured, invalidateGuild };
