#!/usr/bin/env node
// ============================================================================
// Run the app against the demo guild, already signed in.
// ============================================================================
// Usage, from backend/:   node scripts/demoServer.js
// Then open the URL it prints. Ctrl-C stops both processes.
//
// Two processes, on purpose:
//
//   :4310  the real server.js, unmodified, pointed at the scratch database with
//          Discord stubbed and SINGLE_GUILD_ID pinned to the demo tenant
//   :4300  a ~40-line proxy that adds a signed session cookie to every request
//
// ── WHY THE PROXY EXISTS ───────────────────────────────────────────────────
// Signing in means Discord OAuth, and OAuth is a browser redirect to
// discord.com — the axios stub cannot intercept that, because it isn't a
// request this process makes. The alternatives were a dev-only "log me in"
// route in the app, or this.
//
// It is this, because an auth bypass that ships inside server.js is one
// misconfigured environment variable away from being an auth bypass in
// production. Nothing in this file is reachable from the deployed app: it is a
// separate process that has to be started by hand, and the app it proxies has
// no idea it exists. The cookie it mints is a normal session signed with the
// normal JWT_SECRET, so the server applies exactly the checks it always does.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const perms = require('../permissions');
const { DEMO_DISCORD_GUILD, VIEWER } = require('./demoFixture');

const PROXY_PORT = parseInt(process.env.DEMO_PORT, 10) || 4300;
const APP_PORT = PROXY_PORT + 10;

const url = process.env.TEST_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set — the demo session is a real signed session and needs it.');
  process.exit(1);
}

(async () => {
  // ── Find the tenant ───────────────────────────────────────────────────────
  const supabase = createClient(url, key);
  const { data: guild, error } = await supabase.from('guilds')
    .select('id, house, tag').eq('discord_guild_id', DEMO_DISCORD_GUILD).maybeSingle();
  if (error) { console.error('Could not reach the database:', error.message); process.exit(1); }
  if (!guild) {
    console.error('No demo guild in that database yet.\n  Run:  node scripts/demoGuild.js');
    process.exit(1);
  }

  // ── Mint the session ──────────────────────────────────────────────────────
  // Every capability, because the demo exists to show the officer surfaces.
  // Same shape buildSession() produces at a real login — capabilities live per
  // membership, never at the top level, so nothing downstream can read one
  // without having chosen a guild first.
  const ALL = perms.ALL_PERMISSIONS.map((p) => p.key);
  const token = jwt.sign({
    id: VIEWER.id,
    username: VIEWER.name,
    avatar: null,
    verified_at: Date.now(),
    guilds: [{
      guild_id: guild.id,
      discord_guild_id: DEMO_DISCORD_GUILD,
      house: guild.house,
      tag: guild.tag,
      roles: [],
      permissions: ALL,
      fullAccess: true,
    }],
  }, process.env.JWT_SECRET, { expiresIn: '7d' });

  // ── Boot the real server ──────────────────────────────────────────────────
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'demoDiscordStub.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SUPABASE_URL: url,
      SUPABASE_SERVICE_KEY: key,
      // Pin the whole process to this one tenant, so there is no guild picker
      // and every request resolves to the demo without a header.
      SINGLE_GUILD_ID: guild.id,
      // Must be truthy or listMembers/listRoles/fetchMember refuse to run at
      // all. It is never sent anywhere — see the stub.
      DISCORD_BOT_TOKEN: 'demo-token-not-used',
      // The session is minted here, not by Discord; re-verifying it hourly
      // against a stub proves nothing and only risks re-issuing it wrong.
      SESSION_REVERIFY_MINUTES: '100000',
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
  });

  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  child.on('exit', (code) => { if (code) process.exitCode = code; process.exit(); });
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('exit', stop);

  // ── The proxy ─────────────────────────────────────────────────────────────
  // Straight pass-through with one header added. No body buffering — the gear
  // and scoreboard uploads are multipart images, and swallowing them into
  // memory to re-emit would break the one feature people most want to try.
  const proxy = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    const forwarded = {
      ...req.headers,
      host: `127.0.0.1:${APP_PORT}`,
      cookie: /(?:^|;\s*)gh_session=/.test(cookie) ? cookie : `${cookie ? cookie + '; ' : ''}gh_session=${token}`,
    };
    const up = http.request(
      { host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers: forwarded },
      (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); },
    );
    up.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`demo app not reachable: ${err.message}\n`);
    });
    req.pipe(up);
  });

  // Wait for the app before opening the door, so a click during boot doesn't
  // land on a 502 that looks like a broken demo.
  const ready = async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
        if (r.ok) return true;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  if (!(await ready())) {
    console.error('\nThe app did not start within 60s. Is frontend/dist built? (npm run build in frontend/)');
    stop();
    process.exit(1);
  }

  proxy.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`  ${guild.house} [${guild.tag}] — demo`);
    console.log(`  Open:  http://localhost:${PROXY_PORT}`);
    console.log(`  Signed in as ${VIEWER.name} (all capabilities)`);
    console.log('  Ctrl-C to stop. Nothing here talks to Discord.');
    console.log('────────────────────────────────────────────────────────────\n');
  });
})();
