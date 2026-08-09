#!/usr/bin/env node
// ============================================================================
// Verify this deployment's Discord credentials — without anyone logging in.
// ============================================================================
//   node scripts/checkDiscordConfig.js
//
// `auth=config` on the login page means Discord rejected the token exchange,
// and the three causes have three different fixes. This checks each one
// directly against Discord instead of inferring it from a failed sign-in:
//
//   1. Do DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET belong to the SAME
//      application? (A mismatched pair is `invalid_client`.)
//   2. Does DISCORD_BOT_TOKEN belong to that same application? A bot from a
//      different app can't see the guilds this one serves — no slash commands,
//      and listMembers fails for every tenant.
//   3. Is DISCORD_REDIRECT_URI what the portal must contain, character for
//      character? (A mismatch is `invalid_grant`.)
//
// No secret is ever printed. Run it on the machine that serves the site — the
// point is to test the env that deployment actually has.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
  DISCORD_REDIRECT_URI, APP_URL,
} = process.env;

const API = 'https://discord.com/api/v10';
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); failures++; };
const info = (m) => console.log('        ' + m);
let failures = 0;

(async () => {
  console.log('Discord configuration check\n');

  // ── present at all? ───────────────────────────────────────────────────────
  for (const [name, v] of [
    ['DISCORD_CLIENT_ID', DISCORD_CLIENT_ID],
    ['DISCORD_CLIENT_SECRET', DISCORD_CLIENT_SECRET],
    ['DISCORD_BOT_TOKEN', DISCORD_BOT_TOKEN],
    ['DISCORD_REDIRECT_URI', DISCORD_REDIRECT_URI],
  ]) {
    if (!v) bad(`${name} is not set`);
  }
  if (failures) { console.log('\nFix the missing values first.'); process.exit(1); }

  console.log(`client_id    ${DISCORD_CLIENT_ID}`);
  console.log(`redirect_uri ${DISCORD_REDIRECT_URI}`);
  console.log(`app_url      ${APP_URL}\n`);

  // ── 1. client_id + client_secret are a valid pair ────────────────────────
  // client_credentials exercises exactly the same credential check the login
  // token exchange does, without needing an authorization code.
  console.log('1. client id + secret');
  const cc = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }).toString(),
  });
  const ccBody = await cc.json().catch(() => ({}));
  if (cc.status === 200) {
    ok('the secret belongs to this application');
  } else if (ccBody.error === 'invalid_client') {
    bad('invalid_client — the secret does NOT belong to this client id');
    info('Developer Portal -> your app -> OAuth2 -> Reset Secret, and make sure');
    info(`you are looking at application ${DISCORD_CLIENT_ID}, not another one.`);
  } else {
    bad(`unexpected response ${cc.status}: ${JSON.stringify(ccBody)}`);
  }

  // ── 2. the bot token belongs to the same application ─────────────────────
  console.log('\n2. bot token');
  const appRes = await fetch(`${API}/oauth2/applications/@me`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (appRes.status === 401) {
    bad('the bot token is invalid or was regenerated');
  } else if (!appRes.ok) {
    bad(`could not read the application (HTTP ${appRes.status})`);
  } else {
    const app = await appRes.json();
    if (String(app.id) === String(DISCORD_CLIENT_ID)) {
      ok(`bot token belongs to the same application ("${app.name}")`);
    } else {
      bad(`bot token belongs to application ${app.id} ("${app.name}"), NOT ${DISCORD_CLIENT_ID}`);
      info('Login would still work, but the bot in each guild is the wrong one:');
      info('no slash commands, and Roster/Parties fail because listMembers needs');
      info('this deployment\'s bot to be a member of the guild.');
    }
    // Read from whichever application the BOT TOKEN belongs to — which is not
    // necessarily DISCORD_CLIENT_ID. Naming the app matters: a bare "enabled"
    // here, while the token belongs to the wrong app, reads as reassurance
    // about an application this deployment does not actually use.
    const intents = app.flags || 0;
    // GATEWAY_GUILD_MEMBERS_LIMITED (1<<14) / GATEWAY_GUILD_MEMBERS (1<<15)
    const hasMembers = Boolean(intents & (1 << 14)) || Boolean(intents & (1 << 15));
    const whose = `on "${app.name}" (${app.id})`;
    if (hasMembers) ok(`Server Members Intent is enabled ${whose}`);
    else bad(`Server Members Intent is NOT enabled ${whose} — listMembers cannot page the roster`);
    if (String(app.id) !== String(DISCORD_CLIENT_ID)) {
      info(`That intent reading is for ${app.id}, NOT ${DISCORD_CLIENT_ID}.`);
      info(`Once the bot token is replaced, re-run this to check ${DISCORD_CLIENT_ID}.`);
    }
  }

  // ── 3. redirect uri shape ────────────────────────────────────────────────
  console.log('\n3. redirect uri');
  const expected = APP_URL ? `${String(APP_URL).replace(/\/$/, '')}/api/auth/discord/callback` : null;
  if (expected && DISCORD_REDIRECT_URI !== expected) {
    bad(`does not match APP_URL — expected ${expected}`);
  } else {
    ok('consistent with APP_URL');
  }
  if (!/^https:\/\//.test(DISCORD_REDIRECT_URI) && !/localhost/.test(DISCORD_REDIRECT_URI)) {
    bad('is not https — Discord requires https for non-localhost redirects');
  }
  if (/\/$/.test(DISCORD_REDIRECT_URI)) bad('has a trailing slash — the portal entry must match exactly');
  info('This string must appear VERBATIM in Developer Portal -> OAuth2 -> Redirects.');
  info('Discord answers invalid_grant when it differs by even one character.');

  console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('check failed:', e.message); process.exit(1); });
