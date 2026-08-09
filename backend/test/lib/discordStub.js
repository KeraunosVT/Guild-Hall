// Preloaded into the server with --require so the real OAuth callback can run
// without touching Discord. Only discord.com URLs are intercepted; Supabase and
// everything else go through untouched.
//
// The fixture is a JSON blob in STUB_DISCORD:
//   { "user": { "id": "...", "username": "..." },
//     "guilds": { "<discord_guild_id>": ["<role id>", ...] } }
// A guild listed here is one the user is in; its array is the roles they hold
// there. Anything not listed simply isn't returned, which is how "not a member"
// is expressed.
const axios = require('axios');

const fixture = (() => {
  try { return JSON.parse(process.env.STUB_DISCORD || '{}'); } catch { return {}; }
})();

const realGet = axios.get.bind(axios);
const realPost = axios.post.bind(axios);
const isDiscord = (url) => typeof url === 'string' && url.includes('discord.com/api');

axios.post = async (url, ...rest) => {
  if (!isDiscord(url)) return realPost(url, ...rest);
  if (url.includes('/oauth2/token')) return { status: 200, data: { access_token: 'stub-token' } };
  return { status: 200, data: {} };
};

axios.get = async (url, ...rest) => {
  if (!isDiscord(url)) return realGet(url, ...rest);

  // The user's server list — only what the fixture says they're in.
  if (url.endsWith('/users/@me/guilds')) {
    return { status: 200, data: Object.keys(fixture.guilds || {}).map((id) => ({ id })) };
  }

  // Their member object in one server. 404 when they aren't in it, which is
  // exactly what Discord returns and what login treats as "not a member".
  const m = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
  if (m) {
    const roles = (fixture.guilds || {})[m[1]];
    if (!roles) return { status: 404, data: null };
    return { status: 200, data: { roles, user: fixture.user || {} } };
  }

  return { status: 200, data: {} };
};
