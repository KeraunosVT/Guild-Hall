// backend/discord.js — Discord bot via REST (no gateway connection).
// Lists guild members filtered to a role (for the party pool) and posts the
// finished roster embed to a channel. Requires a bot token with the
// "Server Members Intent" enabled for member listing.
const axios = require('axios');

const API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROSTER_CHANNEL_ID = process.env.DISCORD_ROSTER_CHANNEL_ID;
const MEMBER_ROLES = (process.env.DISCORD_MEMBER_ROLE_IDS || process.env.DISCORD_ALLOWED_ROLE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const botConfigured = Boolean(BOT_TOKEN && GUILD_ID);

const authHeaders = () => ({ Authorization: `Bot ${BOT_TOKEN}` });

// listMembers() is hit from several routes (roster, players, admin pool,
// awards import), and each uncached call re-paginates the entire guild member
// list — an easy way to trip Discord's rate limits. Cache the result briefly,
// dedupe concurrent callers onto one fetch, and serve the last good list if a
// refresh fails (a stale roster beats a 502).
const CACHE_TTL_MS = (parseInt(process.env.MEMBER_CACHE_SECONDS, 10) || 60) * 1000;
let membersCache = null;       // last successful result
let membersCacheAt = 0;        // when it was fetched
let membersInFlight = null;    // Promise while a fetch is running

// Fetch every guild member (paginated), keep those with a member role.
async function listMembers() {
  if (!botConfigured) {
    throw new Error('Discord bot is not configured (set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID).');
  }

  if (membersCache && Date.now() - membersCacheAt < CACHE_TTL_MS) {
    return membersCache;
  }
  if (membersInFlight) return membersInFlight;

  membersInFlight = fetchAllMembers()
    .then((members) => {
      membersCache = members;
      membersCacheAt = Date.now();
      return members;
    })
    .catch((err) => {
      if (membersCache) {
        console.warn('listMembers refresh failed — serving stale cache:', err.message);
        return membersCache;
      }
      throw err;
    })
    .finally(() => { membersInFlight = null; });

  return membersInFlight;
}

async function fetchAllMembers() {
  const members = [];
  let after = '0';
  for (let page = 0; page < 25; page++) { // safety cap (~25k members)
    const res = await axios.get(`${API}/guilds/${GUILD_ID}/members`, {
      headers: authHeaders(),
      params: { limit: 1000, after },
    });
    const batch = res.data || [];
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }

  const filtered = MEMBER_ROLES.length
    ? members.filter((m) => (m.roles || []).some((r) => MEMBER_ROLES.includes(r)))
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
// Takes the Discord server id because re-verification is per-guild now: a
// session can hold membership in several guilds, and each has to be re-checked
// against the server it belongs to. Defaults to the env guild so single-tenant
// callers are unchanged.
//
// NOTE: the rest of this module (listMembers, listRoles, postEmbed, postImage)
// is still bound to the env GUILD_ID and channel ids, with module-level caches
// that assume one guild. That is plan tasks 8 and 9 for the bot REST layer and
// is deliberately not done here — this function is the only part session
// re-verification needs.
async function fetchMember(userId, discordGuildId = GUILD_ID) {
  if (!BOT_TOKEN) throw new Error('Discord bot is not configured.');
  if (!discordGuildId) throw new Error('fetchMember: no guild id.');
  const res = await axios.get(`${API}/guilds/${discordGuildId}/members/${userId}`, {
    headers: authHeaders(),
    validateStatus: (s) => s < 500,
  });
  return { status: res.status, member: res.status === 200 ? res.data : null };
}

// Post an embed to the configured roster channel.
async function postEmbed(embed, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  if (!ROSTER_CHANNEL_ID) throw new Error('DISCORD_ROSTER_CHANNEL_ID is not set.');
  await axios.post(
    `${API}/channels/${ROSTER_CHANNEL_ID}/messages`,
    { content: content || undefined, embeds: [embed] },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
}

// Post an image file to the configured roster channel.
async function postImage(buffer, filename, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  if (!ROSTER_CHANNEL_ID) throw new Error('DISCORD_ROSTER_CHANNEL_ID is not set.');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'roster.png', contentType: 'image/png' });
  if (content) form.append('payload_json', JSON.stringify({ content }));
  await axios.post(
    `${API}/channels/${ROSTER_CHANNEL_ID}/messages`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
}

// Every role in the guild, for the permissions page to grant against. Cached on
// the same short TTL as listMembers for the same reason — roles change rarely
// and the page re-fetches on every visit.
//
// @everyone is dropped: it's a real role that every member holds, so granting
// against it would hand a capability to the entire guild, which is never what
// someone clicking a row in a permissions grid means to do.
let rolesCache = null;
let rolesCacheAt = 0;

async function listRoles() {
  if (!botConfigured) return [];
  if (rolesCache && Date.now() - rolesCacheAt < CACHE_TTL_MS) return rolesCache;
  try {
    const { data } = await axios.get(`${API}/guilds/${GUILD_ID}/roles`, { headers: authHeaders() });
    const roles = (data || [])
      .filter((r) => r.id !== GUILD_ID && !r.managed)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }))
      .sort((a, b) => b.position - a.position);
    rolesCache = roles;
    rolesCacheAt = Date.now();
    return roles;
  } catch (err) {
    if (rolesCache) {
      console.warn('listRoles refresh failed — serving stale cache:', err.message);
      return rolesCache;
    }
    throw err;
  }
}

module.exports = { listMembers, listRoles, fetchMember, postEmbed, postImage, botConfigured };
