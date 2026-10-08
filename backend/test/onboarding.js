// ============================================================================
// Paid self-serve onboarding — end to end against the test database
// ============================================================================
// Drives the real /api/onboard routes, the real Paddle webhook (signed with a
// test secret) and the real SQL functions from saas_014, with Discord answered
// by test/lib/onboardStub.js. Nothing reaches Discord or Paddle.
//
// What it holds, because each one fails quietly or expensively:
//   · no seat, no guild — and one seat makes exactly one guild, even raced;
//   · a seat belongs to the Discord account that paid for it;
//   · authority comes from Discord (Manage Server, the token's guild), never
//     from anything the browser can edit;
//   · the creator can't lock themselves out of the guild they just paid for;
//   · webhooks are idempotent and order-proof;
//   · a lapse suspends only after grace, a payment restores it, and a payment
//     NEVER lifts a suspension staff applied.
//
// Run:  node test/onboarding.js       (from backend/)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { startServer } = require('./lib/server');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + detail);
  ok ? pass++ : fail++;
};

// This suite creates and suspends guilds. It runs ONLY against a dedicated
// test project — never the database the live site serves.
const DB_URL = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!DB_URL || !KEY || DB_URL === process.env.SUPABASE_URL) {
  console.error('onboarding: needs TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY pointing at a scratch project (not SUPABASE_URL).');
  process.exit(1);
}
const db = createClient(DB_URL, KEY);

// Fixed ids, so a crashed run is cleaned up by the next one.
const BUYER = '710000000000000001';
const STRANGER = '710000000000000002';
const SERVERS = ['710000000000001001', '710000000000001002', '710000000000001003', '710000000000001004'];
const [S1, S2, S3, S4] = SERVERS;
const OFFICER = '710000000000002001';
const MEMBER = '710000000000002002';
const SUB_PREFIX = 'sub_test_onb_';
const EVT_PREFIX = 'evt_test_onb_';
const SECRET = 'pdl_ntfset_test_onboarding';

async function purge() {
  await db.from('guilds').delete().in('discord_guild_id', SERVERS);
  await db.from('subscriptions').delete().like('provider_subscription_id', `${SUB_PREFIX}%`);
  await db.from('billing_events').delete().like('event_id', `${EVT_PREFIX}%`);
}

// ── Discord fixture (rewritten between steps; the stub re-reads it) ─────────
const FIXTURE_FILE = path.join(os.tmpdir(), `gh-onboard-stub-${process.pid}.json`);
const fixture = {
  user: { id: BUYER, username: 'Founder', global_name: 'Founder' },
  tokenGuild: null,
  myGuilds: [],
  botGuilds: {},
};
const writeFixture = (patch = {}) => { Object.assign(fixture, patch); fs.writeFileSync(FIXTURE_FILE, JSON.stringify(fixture)); };
const server = (id, members) => ({
  name: `Server ${id.slice(-4)}`,
  roles: [{ id: OFFICER, name: 'Officer', position: 2 }, { id: MEMBER, name: 'Member', position: 1 }],
  members,
});

// ── HTTP helpers ────────────────────────────────────────────────────────────
let BASE;
const cookieFrom = (res, name) => {
  const c = (res.headers.getSetCookie?.() || []).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : null;
};
const errorOf = (res) => (new URL(res.headers.get('location') || 'http://x/').searchParams.get('error'));

// One OAuth round trip through /start or /bot and /callback.
async function oauthStep(startPath, onboardCookie) {
  const headers = onboardCookie ? { cookie: `gh_onboard=${onboardCookie}` } : {};
  const start = await fetch(BASE + startPath, { headers, redirect: 'manual' });
  const state = cookieFrom(start, 'gh_onboard_state');
  if (!state) return { error: errorOf(start), cookie: onboardCookie };
  const nonce = state.split('.')[1];
  const cb = await fetch(`${BASE}/api/onboard/callback?code=stub&state=${nonce}`, {
    headers: { cookie: [`gh_onboard_state=${state}`, onboardCookie && `gh_onboard=${onboardCookie}`].filter(Boolean).join('; ') },
    redirect: 'manual',
  });
  return { error: errorOf(cb), cookie: cookieFrom(cb, 'gh_onboard') || onboardCookie };
}

const getState = async (cookie) => (await fetch(`${BASE}/api/onboard/state`, { headers: { cookie: `gh_onboard=${cookie}` } })).json();
const complete = async (cookie, body) => {
  const res = await fetch(`${BASE}/api/onboard/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `gh_onboard=${cookie}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const BASICS = { house: 'House Founders', tag: 'FNDR', timezone: 'America/New_York', day_start: '01:00', admin_role_ids: [OFFICER], allowed_role_ids: [], accept_terms: true };

// Mint an onboarding cookie directly — the same derivation as auth.js
// signScoped('onboard', …) — for cases that need two at once.
const onboardKey = crypto.createHmac('sha256', process.env.JWT_SECRET || '').update('gh-scope:onboard').digest();
const mintOnboard = (payload) => jwt.sign(payload, onboardKey, { expiresIn: '2h' });

// ── Paddle webhooks ─────────────────────────────────────────────────────────
let clock = Date.parse('2026-10-07T12:00:00Z');
let evtN = 0;
async function webhook(subId, status, { buyer = BUYER, at, secret = SECRET, eventId } = {}) {
  clock += 60_000;
  const event = {
    event_id: eventId || `${EVT_PREFIX}${Date.now()}_${evtN++}`,
    event_type: `subscription.${status === 'trialing' ? 'created' : status === 'canceled' ? 'canceled' : 'updated'}`,
    occurred_at: new Date(at || clock).toISOString(),
    notification_id: 'ntf_test',
    data: {
      id: subId, status, customer_id: 'ctm_01testtesttesttesttesttest',
      custom_data: buyer ? { discord_user_id: buyer } : null,
      current_billing_period: status === 'canceled' ? null : { starts_at: '2026-10-07T12:00:00Z', ends_at: '2026-10-21T12:00:00Z' },
      items: [{ trial_dates: { starts_at: '2026-10-07T12:00:00Z', ends_at: '2026-10-21T12:00:00Z' } }],
    },
  };
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${ts};h1=${sig}` }, body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => ({})), event };
}
const guildRow = async (sid) => (await db.from('guilds').select('*').eq('discord_guild_id', sid).maybeSingle()).data;
const subRow = async (subId) => (await db.from('subscriptions').select('*').eq('provider_subscription_id', subId).maybeSingle()).data;

// Normal login, to prove the founder lands in their new guild as an officer.
async function login() {
  const start = await fetch(BASE + '/api/auth/login', { redirect: 'manual' });
  const state = cookieFrom(start, 'gh_oauth_state');
  const res = await fetch(`${BASE}/api/auth/discord/callback?code=stub&state=${state}`,
    { headers: { cookie: `gh_oauth_state=${state}` }, redirect: 'manual' });
  const reason = ((res.headers.get('location') || '').match(/auth=(\w+)/) || [])[1] || null;
  const session = cookieFrom(res, 'gh_session');
  return { reason, session: session ? jwt.verify(session, process.env.JWT_SECRET) : null };
}

(async () => {
  await purge();
  writeFixture();
  const srv = await startServer({
    NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'onboardStub.js')}`,
    STUB_DISCORD_FILE: FIXTURE_FILE,
    DISCORD_BOT_TOKEN: 'stub-bot-token',
    GUILD_REGISTRY_CACHE_SECONDS: '1',
    SESSION_REVERIFY_MINUTES: '100000',
    PADDLE_ENV: 'sandbox',
    PADDLE_API_KEY: 'test-key',
    PADDLE_PRICE_ID: 'pri_test',
    PADDLE_CLIENT_TOKEN: 'test_client',
    PADDLE_WEBHOOK_SECRET: SECRET,
    BILLING_GRACE_DAYS: '7',
  });
  BASE = srv.BASE;

  try {
    // ── 1. sign in ──────────────────────────────────────────────────────────
    console.log('\n1. signing in with Discord');
    let r = await oauthStep('/api/onboard/start');
    check('sign-in sets the onboarding cookie', !!r.cookie, r.error || '');
    const buyerCookie = r.cookie;
    const st = await getState(buyerCookie);
    check('state knows who they are', st.signedIn && st.user && st.user.id === BUYER);
    check('and that they have not paid', st.seat === null);
    check('the onboarding cookie is not a login session',
      (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `gh_session=${buyerCookie}` } })).status === 401);
    const bad = await fetch(`${BASE}/api/onboard/callback?code=stub&state=forged`, { headers: { cookie: 'gh_onboard_state=identify.real' }, redirect: 'manual' });
    check('a callback with the wrong state is refused', errorOf(bad) === 'state');

    // ── 2. no seat, no bot step ─────────────────────────────────────────────
    console.log('\n2. paying comes first');
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('adding the bot before paying is refused', r.error === 'unpaid');

    // ── 3. the webhook ──────────────────────────────────────────────────────
    console.log('\n3. the Paddle webhook');
    const SUB1 = `${SUB_PREFIX}1`;
    let w = await webhook(SUB1, 'trialing', { secret: 'forged' });
    check('a forged webhook is a 401', w.status === 401);
    check('and creates no seat', !(await subRow(SUB1)));
    w = await webhook(SUB1, 'trialing');
    check('a signed one is applied', w.status === 200 && w.body.result === 'applied', JSON.stringify(w.body));
    const replay = await webhook(SUB1, 'active', { eventId: w.event.event_id });
    check('replaying the same event id is a no-op', replay.body.result === 'duplicate');
    check('so the status is still trialing', (await subRow(SUB1)).status === 'trialing');
    check('the seat belongs to the buyer and no guild', (await subRow(SUB1)).discord_user_id === BUYER && !(await subRow(SUB1)).guild_id);
    check('state now shows the seat', (await getState(buyerCookie)).seat?.status === 'trialing');

    // ── 4. adding the bot ───────────────────────────────────────────────────
    console.log('\n4. adding the bot');
    writeFixture({ tokenGuild: { id: S1, name: 'Founders HQ' }, myGuilds: [{ id: S1, permissions: '0', owner: false }] });
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('without Manage Server, refused', r.error === 'not_manager');
    writeFixture({ user: { id: STRANGER, username: 'Other' }, myGuilds: [{ id: S1, permissions: '32', owner: false }] });
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('a different Discord account than the payer is refused', r.error === 'wrong_account');
    writeFixture({ user: { id: BUYER, username: 'Founder', global_name: 'Founder' }, tokenGuild: null });
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('no guild in the token response (cancelled) is refused', r.error === 'bot_cancelled');
    writeFixture({ tokenGuild: { id: S1, name: 'Founders HQ' }, botGuilds: { [S1]: server(S1, { [BUYER]: [OFFICER] }) } });
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('with Manage Server, the server is recorded', !r.error, r.error || '');
    const s1Cookie = r.cookie;
    const st2 = await getState(s1Cookie);
    check('state shows the server, the bot, and their roles',
      st2.server && st2.server.id === S1 && st2.server.botPresent && st2.server.heldRoleIds.includes(OFFICER));

    // ── 5. completing ───────────────────────────────────────────────────────
    console.log('\n5. finishing setup');
    let c = await complete(s1Cookie, { ...BASICS, accept_terms: false });
    check('terms must be accepted', c.status === 400);
    c = await complete(s1Cookie, { ...BASICS, admin_role_ids: [MEMBER] });
    check('an officer role they do not hold is refused (lockout guard)', c.status === 400, c.body.error || '');
    writeFixture({ botGuilds: {} });
    c = await complete(s1Cookie, BASICS);
    check('with the bot kicked, refused', c.status === 409);
    writeFixture({ botGuilds: { [S1]: server(S1, { [BUYER]: [OFFICER] }) } });
    check('nothing was created by the refusals', !(await guildRow(S1)));
    c = await complete(s1Cookie, BASICS);
    check('a valid setup creates the guild', c.status === 200 && c.body.ok, JSON.stringify(c.body));
    const g1 = await guildRow(S1);
    check('active, with the founder and terms recorded', g1 && g1.status === 'active' && g1.created_by === BUYER && !!g1.terms_accepted_at);
    check('the tag is its own alias', g1 && JSON.stringify(g1.aliases) === '["FNDR"]');
    check('the seat now points at it', (await subRow(SUB1)).guild_id === g1.id);
    check('subscription status is mirrored', g1.subscription_status === 'trialing');
    c = await complete(s1Cookie, BASICS);
    check('the same seat cannot make a second guild', c.status === 402 || c.status === 409, String(c.status));

    // ── 6. logging in afterwards ────────────────────────────────────────────
    console.log('\n6. the founder signs in');
    writeFixture({ myGuilds: [{ id: S1, permissions: '32' }] });
    await new Promise((res) => setTimeout(res, 1200)); // registry cache
    const li = await login();
    const mem = li.session && (li.session.guilds || []).find((x) => x.guild_id === g1.id);
    check('lands in the new guild', !!mem, li.reason || '');
    check('as an officer', !!(mem && mem.fullAccess));

    // ── 7. already registered ───────────────────────────────────────────────
    console.log('\n7. a server that already has a Guild Hall');
    await webhook(`${SUB_PREFIX}2`, 'trialing');
    r = await oauthStep('/api/onboard/bot', buyerCookie);
    check('adding the bot to it again is refused', r.error === 'already_registered');

    // ── 8. one seat, two servers, at once ───────────────────────────────────
    console.log('\n8. racing one seat');
    writeFixture({ botGuilds: { [S2]: server(S2, { [BUYER]: [OFFICER] }), [S3]: server(S3, { [BUYER]: [OFFICER] }) } });
    const [a, b] = await Promise.all([
      complete(mintOnboard({ uid: BUYER, username: 'Founder', sid: S2 }), BASICS),
      complete(mintOnboard({ uid: BUYER, username: 'Founder', sid: S3 }), BASICS),
    ]);
    const wins = [a, b].filter((x) => x.status === 200).length;
    check('exactly one of two concurrent claims wins', wins === 1, `${a.status} / ${b.status}`);
    check('and exactly one guild exists', [await guildRow(S2), await guildRow(S3)].filter(Boolean).length === 1);

    // ── 9. someone else's seat ──────────────────────────────────────────────
    console.log("\n9. a seat is the buyer's alone");
    await webhook(`${SUB_PREFIX}3`, 'trialing');
    writeFixture({ botGuilds: { [S4]: server(S4, { [STRANGER]: [OFFICER] }) } });
    c = await complete(mintOnboard({ uid: STRANGER, username: 'Other', sid: S4 }), BASICS);
    check("a stranger cannot spend the buyer's seat", c.status === 402);
    check('so no guild was made', !(await guildRow(S4)));

    // ── 10. lapse, grace, suspension, recovery ──────────────────────────────
    console.log('\n10. when payment lapses');
    w = await webhook(SUB1, 'canceled');
    let s = await subRow(SUB1);
    check('cancelling starts the grace period', s.status === 'canceled' && !!s.grace_until);
    check('the guild keeps working during grace', (await guildRow(S1)).status === 'active');
    const graceDays = (Date.parse(s.grace_until) - Date.now()) / 86400000;
    check('grace is about 7 days', graceDays > 6.9 && graceDays < 7.1, graceDays.toFixed(2));
    w = await webhook(SUB1, 'active', { at: clock - 3_600_000 });
    check('an older event arriving late is ignored', w.body.result === 'stale' && (await subRow(SUB1)).status === 'canceled');

    // Backdated by an hour, not a second: this machine's clock and the
    // database's differ by a few seconds, and the sweep compares against the
    // database's now().
    await db.from('subscriptions').update({ grace_until: new Date(Date.now() - 3_600_000).toISOString() })
      .eq('provider_subscription_id', SUB1);
    const { data: suspended } = await db.rpc('billing_suspend_lapsed');
    check('past grace, the sweep suspends it', (suspended || []).some((x) => x.discord_guild_id === S1));
    let g = await guildRow(S1);
    check('as a billing suspension', g.status === 'suspended' && g.suspended_reason === 'billing');
    await new Promise((res) => setTimeout(res, 1200)); // registry cache
    const li2 = await login();
    check('signing in now says to renew, not "not a member"', li2.reason === 'suspended', li2.reason || '');

    w = await webhook(SUB1, 'active');
    g = await guildRow(S1);
    check('paying again restores it', g.status === 'active' && g.suspended_reason === null);
    check('and clears the grace period', (await subRow(SUB1)).grace_until === null);

    // ── 11. staff suspensions are not for sale ──────────────────────────────
    console.log('\n11. a staff suspension survives a payment');
    await db.from('guilds').update({ status: 'suspended', suspended_reason: 'staff' }).eq('discord_guild_id', S1);
    await webhook(SUB1, 'active');
    g = await guildRow(S1);
    check('still suspended', g.status === 'suspended' && g.suspended_reason === 'staff');

    // ── 12. invite-only mode ────────────────────────────────────────────────
    // ONBOARDING_ALLOWED_USERS is how the live site is tested against Paddle's
    // sandbox without letting anyone with the public test card make a guild.
    console.log('\n12. invite-only mode');
    const inviteOnly = await startServer({
      NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'onboardStub.js')}`,
      STUB_DISCORD_FILE: FIXTURE_FILE,
      DISCORD_BOT_TOKEN: 'stub-bot-token',
      PADDLE_API_KEY: 'test-key', PADDLE_PRICE_ID: 'pri_test', PADDLE_CLIENT_TOKEN: 'test_client', PADDLE_WEBHOOK_SECRET: SECRET,
      ONBOARDING_ALLOWED_USERS: BUYER,
    });
    const mainBase = BASE;
    BASE = inviteOnly.BASE;
    try {
      writeFixture({ user: { id: STRANGER, username: 'Other' } });
      r = await oauthStep('/api/onboard/start');
      check('someone not on the list is turned away at sign-in', r.error === 'closed');
      check('and gets no setup cookie', !r.cookie);
      const strangerCookie = mintOnboard({ uid: STRANGER, username: 'Other', sid: S4 });
      check('a setup cookie from before does not show them the flow', (await getState(strangerCookie)).available === false);
      c = await complete(strangerCookie, BASICS);
      check('nor let them create a guild', c.status === 403);
      writeFixture({ user: { id: BUYER, username: 'Founder', global_name: 'Founder' } });
      r = await oauthStep('/api/onboard/start');
      check('someone on the list signs in normally', !r.error && !!r.cookie, r.error || '');
    } finally {
      await inviteOnly.stop();
      BASE = mainBase;
    }
  } catch (err) {
    console.error('\nonboarding test crashed:', err.stack || err.message);
    fail++;
  } finally {
    await srv.stop();
    await purge();
    try { fs.unlinkSync(FIXTURE_FILE); } catch { /* already gone */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
