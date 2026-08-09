// ============================================================================
// Login flow — who gets in, as what, in which guild
// ============================================================================
// Drives the REAL /api/auth/discord/callback with Discord's API stubbed
// (test/lib/discordStub.js), so the whole path runs — token exchange, server
// discovery, per-guild role evaluation, session issue — with no external
// traffic and no bot.
//
// The question this answers: a member holding only the member role gets into
// their own guild and nowhere else; an officer role is what opens the admin
// area; being in the Discord server without the member role is a refusal, not
// a silent downgrade.
const path = require('path');
const jwt = require('jsonwebtoken');
const { setup } = require('./lib/harness');
const { startServer } = require('./lib/server');

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(50) + detail);
  if (ok) pass++; else { fail++; failures.push(label); }
};

const MEMBER_ROLE = '900000000000000001';
const OFFICER_ROLE = '900000000000000002';
const UNRELATED_ROLE = '900000000000000003';

(async () => {
  const fx = await setup();
  const { A, B } = fx;

  // Give both guilds a real role gate: only MEMBER_ROLE may enter, only
  // OFFICER_ROLE is an officer.
  for (const g of [A, B]) {
    await fx.supabase.from('guilds')
      .update({ allowed_role_ids: [MEMBER_ROLE], admin_role_ids: [OFFICER_ROLE] })
      .eq('id', g.id);
  }
  await new Promise((r) => setTimeout(r, 1500)); // registry cache

  // Run one login and return the decoded session, or the redirect reason.
  const login = async (fixture) => {
    const srv = await startServer({
      NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'discordStub.js')}`,
      STUB_DISCORD: JSON.stringify(fixture),
      GUILD_REGISTRY_CACHE_SECONDS: '1',
    });
    try {
      // /login sets the CSRF state cookie; the callback requires it to match.
      const start = await fetch(srv.BASE + '/api/auth/login', { redirect: 'manual' });
      const stateCookie = (start.headers.getSetCookie?.() || [])
        .find((c) => c.startsWith('gh_oauth_state='));
      const state = stateCookie.split('=')[1].split(';')[0];

      const res = await fetch(
        `${srv.BASE}/api/auth/discord/callback?code=stub&state=${state}`,
        { headers: { cookie: `gh_oauth_state=${state}` }, redirect: 'manual' },
      );
      const location = res.headers.get('location') || '';
      const session = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('gh_session='));
      return {
        reason: (location.match(/auth=(\w+)/) || [])[1] || null,
        session: session ? jwt.verify(session.split('=')[1].split(';')[0], process.env.JWT_SECRET) : null,
      };
    } finally { await srv.stop(); }  // await: the next login starts a fresh server
  };

  const user = { id: '900000000000009999', username: 'Recruit', global_name: 'Recruit' };

  // ── 1. Member role in guild B only ────────────────────────────────────────
  console.log('\n1. holds the member role in guild B only');
  let r = await login({ user, guilds: { [B.discord_guild_id]: [MEMBER_ROLE] } });
  check('signed in', !!r.session, r.reason ? 'refused: ' + r.reason : '');
  const m = r.session?.guilds || [];
  check('session carries exactly one guild', m.length === 1, m.map((g) => g.house).join(', '));
  check('and it is guild B', m[0]?.guild_id === B.id, m[0]?.house || '');
  check('no capabilities (plain member)', JSON.stringify(m[0]?.permissions) === '[]', JSON.stringify(m[0]?.permissions));
  check('not an officer', m[0]?.fullAccess === false);
  check('guild A absent from the session', !m.some((g) => g.guild_id === A.id));

  // ── 2. Officer role ───────────────────────────────────────────────────────
  console.log('\n2. holds the officer role in guild B');
  r = await login({ user, guilds: { [B.discord_guild_id]: [MEMBER_ROLE, OFFICER_ROLE] } });
  const off = (r.session?.guilds || [])[0];
  check('signed in', !!r.session, r.reason ? 'refused: ' + r.reason : '');
  check('full access in guild B', off?.fullAccess === true);
  check('holds every capability', (off?.permissions || []).length === fx.ALL.length,
    `${(off?.permissions || []).length} of ${fx.ALL.length}`);

  // ── 3. In the server, but without the member role ────────────────────────
  console.log('\n3. in the Discord server but lacks the member role');
  r = await login({ user, guilds: { [B.discord_guild_id]: [UNRELATED_ROLE] } });
  check('refused', !r.session, r.session ? '<-- LET IN' : '');
  check('told it is a rank problem, not membership', r.reason === 'forbidden', r.reason || '');

  // ── 4. In no server we host ──────────────────────────────────────────────
  console.log('\n4. in no server this hall serves');
  r = await login({ user, guilds: { 999999999999999999: [MEMBER_ROLE] } });
  check('refused', !r.session);
  check('told they are not a member', r.reason === 'not_member', r.reason || '');

  // ── 5. Member of both, officer in only one ───────────────────────────────
  console.log('\n5. member of both houses, officer in guild A only');
  r = await login({
    user,
    guilds: {
      [A.discord_guild_id]: [MEMBER_ROLE, OFFICER_ROLE],
      [B.discord_guild_id]: [MEMBER_ROLE],
    },
  });
  const both = r.session?.guilds || [];
  check('session carries both houses', both.length === 2, both.map((g) => g.house).join(', '));
  const inA = both.find((g) => g.guild_id === A.id);
  const inB = both.find((g) => g.guild_id === B.id);
  check('officer in A', inA?.fullAccess === true);
  check('plain member in B', inB?.fullAccess === false && inB?.permissions.length === 0);
  check('no flat top-level permissions on the token',
    r.session && !('permissions' in r.session),
    'permissions' in (r.session || {}) ? 'PRESENT — would apply everywhere' : '');

  await fx.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) failures.forEach((f) => console.log('  - ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
