// ============================================================================
// Billing: the Paddle webhook, without Paddle or a database
// ============================================================================
// The webhook is the only way money becomes access, so the things worth holding
// are the ones that fail quietly: a forged or replayed signature being accepted,
// a payload whose buyer we misread (the seat goes to nobody, or to the wrong
// person), and a database failure answered with 200 — which tells Paddle to
// stop retrying an event we never applied.
//
// The SQL side (ordering, grace, staff suspensions surviving a payment, seat
// claiming) runs against the real database in test/onboarding.js.
//
// Run:  node test/billing.js       (from backend/)
const crypto = require('crypto');
const createBilling = require('../billing');
const { verifySignature, normalizeSubscription } = createBilling;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + detail);
  ok ? pass++ : fail++;
};

const SECRET = 'pdl_ntfset_test_secret';
const sign = (body, ts, secret = SECRET) =>
  `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
const NOW = 1_800_000_000;

console.log('\n1. signatures');
const body = '{"event_id":"evt_1"}';
check('a correct signature verifies', verifySignature(Buffer.from(body), sign(body, NOW), SECRET, { nowSec: NOW }));
check('a different secret does not', !verifySignature(Buffer.from(body), sign(body, NOW, 'other'), SECRET, { nowSec: NOW }));
check('a changed body does not', !verifySignature(Buffer.from(body + ' '), sign(body, NOW), SECRET, { nowSec: NOW }));
check('a stale timestamp does not', !verifySignature(Buffer.from(body), sign(body, NOW - 301), SECRET, { nowSec: NOW }));
check('inside the tolerance does', verifySignature(Buffer.from(body), sign(body, NOW - 299), SECRET, { nowSec: NOW }));
const rotated = `${sign(body, NOW).split(';')[0]};h1=deadbeef;${sign(body, NOW).split(';')[1]}`;
check('any matching h1 during rotation verifies', verifySignature(Buffer.from(body), rotated, SECRET, { nowSec: NOW }));
check('a missing header does not', !verifySignature(Buffer.from(body), undefined, SECRET, { nowSec: NOW }));
check('garbage does not', !verifySignature(Buffer.from(body), 'ts=abc;h1=zz', SECRET, { nowSec: NOW }));
check('no secret configured never verifies', !verifySignature(Buffer.from(body), sign(body, NOW, ''), '', { nowSec: NOW }));

console.log('\n2. reading a subscription event');
const BUYER = '123456789012345678';
const event = (type, data = {}) => ({
  event_id: `evt_${Math.random().toString(36).slice(2)}`,
  event_type: type,
  occurred_at: '2026-10-07T12:00:00Z',
  data: {
    id: 'sub_01',
    status: 'trialing',
    customer_id: 'ctm_01',
    custom_data: { discord_user_id: BUYER },
    current_billing_period: { starts_at: '2026-10-07T12:00:00Z', ends_at: '2026-10-21T12:00:00Z' },
    items: [{ trial_dates: { starts_at: '2026-10-07T12:00:00Z', ends_at: '2026-10-21T12:00:00Z' } }],
    ...data,
  },
});
const n = normalizeSubscription(event('subscription.created'));
check('the buyer comes from custom_data', n.discordUserId === BUYER);
check('the trial end comes from the item', n.trialEndsAt === '2026-10-21T12:00:00Z');
check('the period end comes from the billing period', n.periodEnd === '2026-10-21T12:00:00Z');
check('status passes through', n.status === 'trialing');
check('a malformed buyer id is dropped, not trusted',
  normalizeSubscription(event('subscription.created', { custom_data: { discord_user_id: 'abc' } })).discordUserId === null);
check('no custom_data means no buyer',
  normalizeSubscription(event('subscription.created', { custom_data: null })).discordUserId === null);
check('a canceled sub has no period, and that is fine',
  normalizeSubscription(event('subscription.canceled', { status: 'canceled', current_billing_period: null })).periodEnd === null);
check('an unknown status is not a subscription event',
  normalizeSubscription(event('subscription.updated', { status: 'weird' })) === null);
check('a transaction event is not a subscription event',
  normalizeSubscription({ ...event('transaction.completed'), event_type: 'transaction.completed' }) === null);

console.log('\n3. the webhook handler');
function fakeDb({ rpcResult = [{ result: 'applied', discord_guild_id: null }], rpcError = null } = {}) {
  const calls = { rpc: [], upsert: [] };
  const seen = new Set();
  return {
    calls,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return { data: rpcResult, error: rpcError }; },
    from: () => ({
      insert: async (row) => {
        calls.upsert.push(row);
        if (seen.has(row.event_id)) return { error: { code: '23505', message: 'duplicate key' } };
        seen.add(row.event_id);
        return { error: null };
      },
    }),
  };
}
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (j) => { r.body = j; return r; };
  return r;
}
function fakeReq(payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'paddle-signature': sign(raw, ts, secret) };
  return { body: Buffer.from(raw), get: (h) => headers[h.toLowerCase()] };
}
const ENV = { PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_API_KEY: 'k', PADDLE_PRICE_ID: 'pri_1', PADDLE_CLIENT_TOKEN: 'test_x', BILLING_GRACE_DAYS: '7' };

(async () => {
  {
    const db = fakeDb();
    const res = fakeRes();
    await createBilling(db, { env: ENV }).handleWebhook(fakeReq(event('subscription.created'), { secret: 'forged' }), res);
    check('a forged webhook is a 401', res.statusCode === 401);
    check('and touches nothing', db.calls.rpc.length === 0 && db.calls.upsert.length === 0);
  }
  {
    const db = fakeDb();
    const res = fakeRes();
    const ev = event('subscription.created');
    await createBilling(db, { env: ENV }).handleWebhook(fakeReq(ev), res);
    const a = db.calls.rpc[0] && db.calls.rpc[0].args;
    check('a real one is applied through the RPC', db.calls.rpc[0] && db.calls.rpc[0].name === 'billing_apply_subscription');
    check('with the event id (for dedupe)', a && a.p_event_id === ev.event_id);
    check('the buyer', a && a.p_discord_user_id === BUYER);
    check('and the configured grace', a && a.p_grace_days === 7);
    check('and answers 200', res.statusCode === 200);
  }
  {
    const changed = [];
    const db = fakeDb({ rpcResult: [{ result: 'applied', discord_guild_id: '999999999999999999' }] });
    await createBilling(db, { env: ENV, onGuildChanged: (id) => changed.push(id) })
      .handleWebhook(fakeReq(event('subscription.activated', { status: 'active' })), fakeRes());
    check('a guild whose status changed has its cache dropped', changed[0] === '999999999999999999');
  }
  {
    const db = fakeDb({ rpcError: { message: 'connection reset' } });
    const res = fakeRes();
    await createBilling(db, { env: ENV }).handleWebhook(fakeReq(event('subscription.updated')), res);
    check('a database failure is a 500, so Paddle retries', res.statusCode === 500);
  }
  {
    const db = fakeDb();
    const res = fakeRes();
    const ev = { event_id: 'evt_txn', event_type: 'transaction.completed', occurred_at: '2026-10-07T12:00:00Z', data: { id: 'txn_1' } };
    await createBilling(db, { env: ENV }).handleWebhook(fakeReq(ev), res);
    check('an event we do not act on is recorded', db.calls.upsert[0] && db.calls.upsert[0].event_id === 'evt_txn');
    check('and answered 200 so it is not retried', res.statusCode === 200 && db.calls.rpc.length === 0);
    const again = fakeRes();
    await createBilling(db, { env: ENV }).handleWebhook(fakeReq(ev), again);
    check('a retry of it is still 200, not a duplicate-key 500', again.statusCode === 200);
  }
  {
    const res = fakeRes();
    await createBilling(fakeDb(), { env: { ...ENV, PADDLE_WEBHOOK_SECRET: '' } }).handleWebhook(fakeReq(event('subscription.created')), res);
    check('with no secret configured, nothing is accepted', res.statusCode === 503);
  }

  console.log('\n4. configuration');
  check('sandbox unless production is named', createBilling(null, { env: ENV }).environment === 'sandbox');
  check('production when named', createBilling(null, { env: { ...ENV, PADDLE_ENV: 'production' } }).environment === 'production');
  check('a typo is still sandbox', createBilling(null, { env: { ...ENV, PADDLE_ENV: 'prod' } }).environment === 'sandbox');
  check('not configured without a price', !createBilling(null, { env: { ...ENV, PADDLE_PRICE_ID: '' } }).configured);
  let threw = false;
  try { await createBilling(null, { env: ENV }).portalUrl('not-a-customer'); } catch { threw = true; }
  check('the portal refuses a malformed customer id', threw);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
