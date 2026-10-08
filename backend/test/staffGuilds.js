// ============================================================================
// The staff Guilds page — who may use it, and what each action really does
// ============================================================================
// Against the test database (needs saas_015). What it holds:
//   · only platform staff get in — a guild officer, however senior, does not;
//   · a staff suspension survives a payment, and reactivation only lifts a
//     staff suspension, never a billing one;
//   · comping reopens a billing-suspended guild and keeps the sweep away;
//   · every action lands in the affected guild's own audit log.
//
// Run:  node test/staffGuilds.js       (from backend/)
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { startServer } = require('./lib/server');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + detail);
  ok ? pass++ : fail++;
};

const DB_URL = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!DB_URL || !KEY || DB_URL === process.env.SUPABASE_URL) {
  console.error('staffGuilds: needs TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY pointing at a scratch project (not SUPABASE_URL).');
  process.exit(1);
}
const db = createClient(DB_URL, KEY);

const SERVER = '720000000000001001';
const STAFF_ID = '720000000000000001';
const OFFICER_ID = '720000000000000002';
const SUB = 'sub_test_staff_1';

async function purge() {
  await db.from('guilds').delete().eq('discord_guild_id', SERVER);
  await db.from('subscriptions').delete().eq('provider_subscription_id', SUB);
}

const sign = (payload) => jwt.sign({ verified_at: Date.now(), ...payload }, process.env.JWT_SECRET, { expiresIn: '1h' });

(async () => {
  await purge();
  const { data: g, error } = await db.from('guilds').insert({
    discord_guild_id: SERVER, house: 'House Staffcheck', tag: 'STF', aliases: ['STF'], status: 'active',
  }).select('id').single();
  if (error) { console.error('fixture:', error.message); process.exit(1); }
  await db.from('subscriptions').insert({ provider_subscription_id: SUB, guild_id: g.id, status: 'active', discord_user_id: OFFICER_ID });

  const srv = await startServer({ SESSION_REVERIFY_MINUTES: '100000', GUILD_REGISTRY_CACHE_SECONDS: '1' });
  const staffCookie = `gh_session=${sign({ id: STAFF_ID, username: 'Staffer', staff: true, guilds: [] })}`;
  // A full officer of the very guild in question — still not staff.
  const officerCookie = `gh_session=${sign({
    id: OFFICER_ID, username: 'Officer', staff: false,
    guilds: [{ guild_id: g.id, house: 'House Staffcheck', fullAccess: true, permissions: ['settings'] }],
  })}`;
  const call = (method, p, cookie, body) => fetch(`${srv.BASE}/api/staff/guilds${p}`, {
    method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const row = async () => (await db.from('guilds').select('*').eq('id', g.id).single()).data;

  try {
    console.log('\n1. who gets in');
    check('no session: refused', (await call('GET', '', '')).status === 401);
    check("the guild's own officer: refused", (await call('GET', '', officerCookie)).status === 403);
    const list = await call('GET', '', staffCookie);
    const body = await list.json();
    const mine = (body.guilds || []).find((x) => x.id === g.id);
    check('staff: sees every guild', list.status === 200 && !!mine);
    check('with its subscription attached', mine && mine.subscription && mine.subscription.status === 'active');
    check('an officer cannot suspend either', (await call('POST', `/${g.id}/suspend`, officerCookie, { note: 'x' })).status === 403);

    console.log('\n2. suspending');
    check('a reason is required', (await call('POST', `/${g.id}/suspend`, staffCookie, { note: ' ' })).status === 400);
    check('suspend', (await call('POST', `/${g.id}/suspend`, staffCookie, { note: 'chargeback fraud' })).status === 200);
    let r = await row();
    check('suspended by staff, with who and why', r.status === 'suspended' && r.suspended_reason === 'staff'
      && r.suspended_note === 'chargeback fraud' && /Staffer/.test(r.suspended_by || ''));
    check('suspending twice is a 409', (await call('POST', `/${g.id}/suspend`, staffCookie, { note: 'again' })).status === 409);
    // A payment arriving now must not reopen it.
    await db.rpc('billing_apply_subscription', {
      p_event_id: `evt_test_staff_${Date.now()}`, p_event_type: 'subscription.updated', p_occurred_at: new Date().toISOString(),
      p_payload: {}, p_subscription_id: SUB, p_customer_id: null, p_discord_user_id: OFFICER_ID, p_status: 'active',
      p_trial_ends_at: null, p_period_end: null, p_grace_days: 7,
    });
    check('a payment does not lift a staff suspension', (await row()).status === 'suspended');

    console.log('\n3. reactivating');
    check('reactivate', (await call('POST', `/${g.id}/reactivate`, staffCookie)).status === 200);
    r = await row();
    check('open, with the suspension record cleared', r.status === 'active' && !r.suspended_reason && !r.suspended_note);
    await db.from('guilds').update({ status: 'suspended', suspended_reason: 'billing' }).eq('id', g.id);
    const re = await call('POST', `/${g.id}/reactivate`, staffCookie);
    check('a BILLING suspension cannot be reactivated by hand', re.status === 409);
    check('so it stays suspended', (await row()).status === 'suspended');

    console.log('\n4. comping');
    check('comp', (await call('POST', `/${g.id}/comp`, staffCookie, { exempt: true })).status === 200);
    r = await row();
    check('comping reopens a billing-suspended guild', r.billing_exempt && r.status === 'active' && !r.suspended_reason);
    await db.from('subscriptions').update({ status: 'canceled', grace_until: new Date(Date.now() - 3_600_000).toISOString() })
      .eq('provider_subscription_id', SUB);
    const { data: swept } = await db.rpc('billing_suspend_lapsed');
    check('the lapse sweep leaves a comped guild alone', !(swept || []).some((x) => x.discord_guild_id === SERVER) && (await row()).status === 'active');
    check('uncomp', (await call('POST', `/${g.id}/comp`, staffCookie, { exempt: false })).status === 200);
    const { data: swept2 } = await db.rpc('billing_suspend_lapsed');
    check('uncomped and lapsed, the sweep suspends it', (swept2 || []).some((x) => x.discord_guild_id === SERVER));
    check('a non-boolean is refused', (await call('POST', `/${g.id}/comp`, staffCookie, { exempt: 'yes' })).status === 400);
    check('an unknown guild is a 404', (await call('POST', '/00000000-0000-0000-0000-000000000000/comp', staffCookie, { exempt: true })).status === 404);

    console.log('\n5. the guild can see what staff did');
    await new Promise((res) => setTimeout(res, 500)); // audit inserts are fire-and-forget
    const { data: log } = await db.from('audit_log').select('action').eq('guild_id', g.id);
    const actions = (log || []).map((x) => x.action);
    check('every action is in its audit log', ['STAFF suspend', 'STAFF reactivate', 'STAFF comp', 'STAFF uncomp'].every((a) => actions.includes(a)), actions.join(', '));
  } catch (err) {
    console.error('\nstaffGuilds test crashed:', err.stack || err.message);
    fail++;
  } finally {
    await srv.stop();
    await purge();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
