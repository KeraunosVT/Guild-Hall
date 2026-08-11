// Preloaded into the demo server with --require, so every Discord call the app
// makes is answered locally from scripts/demoFixture.js.
//
// WHY A STUB RATHER THAN JUST CLEARING THE BOT TOKEN
// With no token, discord.js's listMembers() returns [] by design. That is
// correct behaviour and a terrible demo: the roster is empty, the party builder
// has nobody to place, the permissions grid has no roles, and the signup
// officer view can't tell you who hasn't answered — because all of those ask
// Discord who is in the server, not the database. Serving the fixture here is
// what makes those screens show what they'd show for a real guild.
//
// Only discord.com/api URLs are intercepted; Supabase and everything else pass
// through untouched. Nothing is ever sent to Discord: the write paths (posting
// an embed, sending a DM) are answered with a plausible id and dropped.
const axios = require('axios');
const { Client } = require('discord.js');
const { DEMO_DISCORD_GUILD, ROLES, MEMBERS } = require('./demoFixture');

// ── The gateway is neutered, not disabled ───────────────────────────────────
// The demo NEEDS a DISCORD_BOT_TOKEN set, because listMembers(), listRoles()
// and fetchMember() all refuse outright when `botConfigured` is false — the
// roster and the settings page would be empty for want of a token that is never
// actually used, since axios above answers those calls locally.
//
// But a set token also makes discordGateway.start() open a real websocket, and
// a fake token means a login failure on a loop in the console. A login that
// resolves without connecting leaves the gateway's `ready` flag false, which is
// exactly the state every gateway function already guards against — so it goes
// quiet and does nothing, and no slash command is ever registered (that happens
// inside the clientReady handler, which never fires).
Client.prototype.login = async function demoLogin() {
  console.log('[demo] Discord gateway held offline — nothing connects.');
  return 'demo-token';
};

const realGet = axios.get.bind(axios);
const realPost = axios.post.bind(axios);
const realPatch = axios.patch.bind(axios);
const isDiscord = (u) => typeof u === 'string' && u.includes('discord.com/api');

// Discord's own member shape, which is what fetchAllMembers() unpacks.
const memberPayload = (m) => ({
  user: { id: m.id, username: m.name.toLowerCase(), global_name: m.name, avatar: null, bot: false },
  nick: null,
  roles: m.discordRoles,
  joined_at: new Date(Date.now() - (m.n + 30) * 86400_000).toISOString(),
});

const byId = new Map(MEMBERS.map((m) => [m.id, m]));

axios.get = async (url, ...rest) => {
  if (!isDiscord(url)) return realGet(url, ...rest);

  // The full member list, for the roster, party builder and officer views.
  if (/\/guilds\/\d+\/members$/.test(url)) {
    return { status: 200, data: url.includes(DEMO_DISCORD_GUILD) ? MEMBERS.map(memberPayload) : [] };
  }

  // One member — session re-verification, and the Guild Settings lockout guard,
  // which fails CLOSED if it can't confirm the actor still holds an officer
  // role. Without this the settings page would refuse every save.
  const one = url.match(/\/guilds\/(\d+)\/members\/(\d+)$/);
  if (one) {
    const m = one[1] === DEMO_DISCORD_GUILD ? byId.get(one[2]) : null;
    return m ? { status: 200, data: memberPayload(m) } : { status: 404, data: null };
  }

  if (/\/guilds\/\d+\/roles$/.test(url)) {
    return { status: 200, data: url.includes(DEMO_DISCORD_GUILD) ? ROLES.map((r) => ({ ...r, managed: false })) : [] };
  }

  // OAuth, for completeness — the demo signs its own session, so this is only
  // reached if someone clicks through the real login flow.
  if (url.endsWith('/users/@me/guilds')) return { status: 200, data: [{ id: DEMO_DISCORD_GUILD }] };
  const mine = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
  if (mine) {
    return mine[1] === DEMO_DISCORD_GUILD
      ? { status: 200, data: { roles: MEMBERS[0].discordRoles, user: { id: MEMBERS[0].id, username: MEMBERS[0].name } } }
      : { status: 404, data: null };
  }

  return { status: 200, data: {} };
};

// Writes are swallowed. A demo that posted to a channel would be posting into a
// channel id that doesn't exist, and the failure would surface as a red error
// on an otherwise working page.
const fakeWrite = async (url, ...rest) => {
  if (!isDiscord(url)) return realPost(url, ...rest);
  if (url.includes('/oauth2/token')) return { status: 200, data: { access_token: 'demo-token' } };
  return { status: 200, data: { id: String(Date.now()) } };
};
axios.post = fakeWrite;
axios.patch = async (url, ...rest) => (isDiscord(url) ? { status: 200, data: {} } : realPatch(url, ...rest));

console.log('[demo] Discord stubbed — no traffic leaves this machine.');
