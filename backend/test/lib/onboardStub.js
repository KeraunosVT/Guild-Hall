// Preloaded into the server with --require for test/onboarding.js. Answers every
// Discord call self-serve onboarding and login make, from a fixture FILE the
// test rewrites between steps — so one server can be walked through every case
// (wrong account, no Manage Server, bot kicked, …) without a restart each.
//
// Fixture (JSON at STUB_DISCORD_FILE):
//   { "user":        { "id", "username" },             // who the OAuth token belongs to
//     "tokenGuild":  { "id", "name" } | null,          // the server the bot was "added" to
//     "myGuilds":    [{ "id", "permissions", "owner" }],  // /users/@me/guilds
//     "botGuilds":   { "<server id>": {
//        "name": "…",
//        "roles": [{ "id", "name", "position" }],
//        "members": { "<user id>": ["<role id>", …] } } } }
//
// A server missing from botGuilds is one the bot isn't in. The gateway is held
// offline exactly as scripts/demoDiscordStub.js does it, so nothing connects.
const fs = require('fs');
const axios = require('axios');
const { Client } = require('discord.js');

Client.prototype.login = async function testLogin() { return 'stub'; };

const fixture = () => {
  try { return JSON.parse(fs.readFileSync(process.env.STUB_DISCORD_FILE, 'utf8')); } catch { return {}; }
};

const realGet = axios.get.bind(axios);
const realPost = axios.post.bind(axios);
const isDiscord = (url) => typeof url === 'string' && url.includes('discord.com/api');
const ok = (data) => ({ status: 200, data });
const missing = () => ({ status: 404, data: { message: 'Unknown' } });

axios.post = async (url, ...rest) => {
  if (!isDiscord(url)) return realPost(url, ...rest);
  if (url.includes('/oauth2/token')) {
    const f = fixture();
    return ok({ access_token: 'stub-token', token_type: 'Bearer', ...(f.tokenGuild ? { guild: f.tokenGuild } : {}) });
  }
  return ok({});
};

axios.get = async (url, ...rest) => {
  if (!isDiscord(url)) return realGet(url, ...rest);
  const f = fixture();
  const path = url.replace(/^https:\/\/discord\.com\/api(\/v\d+)?/, '').split('?')[0];
  let m;

  if (path === '/users/@me') return ok(f.user || {});
  if (path === '/users/@me/guilds') return ok(f.myGuilds || []);
  // Login: the user's own member object in one server.
  if ((m = path.match(/^\/users\/@me\/guilds\/(\d+)\/member$/))) {
    const g = (f.botGuilds || {})[m[1]];
    const roles = g && g.members && g.members[f.user && f.user.id];
    return roles ? ok({ roles, user: f.user }) : missing();
  }
  // Bot: is it in the server, its roles, one member.
  if ((m = path.match(/^\/guilds\/(\d+)$/))) {
    const g = (f.botGuilds || {})[m[1]];
    return g ? ok({ id: m[1], name: g.name }) : missing();
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/roles$/))) {
    const g = (f.botGuilds || {})[m[1]];
    return g ? ok(g.roles || []) : missing();
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
    const g = (f.botGuilds || {})[m[1]];
    const roles = g && g.members && g.members[m[2]];
    return roles ? ok({ roles, user: { id: m[2] } }) : missing();
  }
  return ok({});
};
