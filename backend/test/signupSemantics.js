// ============================================================================
// Signup semantics — capacity, the waitlist, and the races
// ============================================================================
// The isolation suites prove one guild's signups can't reach another's. This
// proves the feature is CORRECT within a guild, which is a different question
// and a harder one: almost everything here is about two things happening at the
// same instant.
//
// Why it exists at all: every one of these behaviours lives in a Postgres
// function rather than in JavaScript, precisely because they cannot be made
// correct in application code — two members clicking the last slot both read
// "5 of 6 taken" and both insert. That reasoning is only worth anything if the
// functions actually do what the comments claim, and nothing else executes
// them. This does, against a real database, with real concurrency.
//
// It drives the RPCs directly rather than going through HTTP: the properties
// under test are transactional, and a route handler in between would only add
// a place for a passing test to be lying about which layer holds the guarantee.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { assertSafeTarget } = require('./lib/harness');

const s = createClient(
  process.env.TEST_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY,
);

// Its own fixture tenant, fixed so a crashed run cleans up after itself next
// time rather than leaving a guild behind forever.
const FIXTURE = '700000000000009999';

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) pass++; else { fail++; failures.push(label); }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${detail}`);
};
const section = (t) => console.log(`\n${t}`);
const uid = (n) => `9${String(n).padStart(11, '0')}`;

(async () => {
  await assertSafeTarget();

  const { data: stale } = await s.from('guilds').select('id').eq('discord_guild_id', FIXTURE);
  for (const g of stale || []) {
    await s.from('event_signup_entries').delete().eq('guild_id', g.id);
    await s.from('event_signups').delete().eq('guild_id', g.id);
    await s.from('guilds').delete().eq('id', g.id);
  }
  const { data: G, error: gErr } = await s.from('guilds').insert({
    discord_guild_id: FIXTURE, house: 'Semantics', tag: 'SEM', aliases: ['SEM'],
    timezone: 'UTC', day_start: '01:00', status: 'active',
  }).select('*').single();
  if (gErr) {
    console.error('fixture guild failed:', gErr.message);
    if (/could not find the table|schema cache/i.test(gErr.message)) {
      console.error('  a migration in migrations/ has not been applied to this database yet.');
    }
    process.exit(1);
  }

  const mkSignup = async (capacity, startsAt = '2099-01-01T21:00:00Z') => (await s.from('event_signups').insert({
    guild_id: G.id, title: 'Probe', starts_at: startsAt, event_date: '2099-01-01',
    capacity, status: 'open',
  }).select('*').single()).data;

  const join = (id, n) => s.rpc('signup_join', {
    p_guild_id: G.id, p_signup_id: id, p_discord_id: uid(n), p_display_name: `M${n}`, p_added_by: null,
  }).then((r) => (r.error ? { err: r.error.message } : r.data[0]));
  const withdraw = (id, n) => s.rpc('signup_withdraw', {
    p_guild_id: G.id, p_signup_id: id, p_discord_id: uid(n),
  }).then((r) => (r.error ? { err: r.error.message } : r.data[0]));
  const setCap = (id, c) => s.rpc('signup_set_capacity', {
    p_guild_id: G.id, p_signup_id: id, p_capacity: c,
  }).then((r) => (r.error ? { err: r.error.message } : r.data[0]));
  const entries = async (id) => (await s.from('event_signup_entries')
    .select('discord_id, status, seq').eq('signup_id', id).order('seq')).data || [];
  const board = async (id) => (await entries(id)).map((e) => `${e.discord_id.slice(-2)}:${e.status}`).join(' ');

  // ── 1 ────────────────────────────────────────────────────────────────────
  section('1. capacity spills to the waitlist, in order');
  const a = await mkSignup(2);
  const r1 = await join(a.id, 1);
  const r2 = await join(a.id, 2);
  const r3 = await join(a.id, 3);
  const r4 = await join(a.id, 4);
  check('first two get a slot', r1.entry_status === 'going' && r2.entry_status === 'going', `${r1.entry_status}, ${r2.entry_status}`);
  check('over-cap goes to the waitlist', r3.entry_status === 'waitlist' && r4.entry_status === 'waitlist');
  check('waitlist positions are 1 then 2', r3.waitlist_position === 1 && r4.waitlist_position === 2, `${r3.waitlist_position}, ${r4.waitlist_position}`);
  check('a confirmed slot reports position 0', r1.waitlist_position === 0, String(r1.waitlist_position));

  // ── 2 ────────────────────────────────────────────────────────────────────
  // A double-tapped Discord button is one member saying one thing twice.
  section('2. joining twice is idempotent');
  const again = await join(a.id, 1);
  check('reports already, not a new row', again.result === 'already', again.result);
  check('does not demote the slot already held', again.entry_status === 'going', again.entry_status);
  check('row count is unchanged', (await entries(a.id)).length === 4, String((await entries(a.id)).length));

  // ── 3 ────────────────────────────────────────────────────────────────────
  // The promise the waitlist makes. Promoting the most recent joiner instead of
  // the longest waiter would be invisible in any single case and corrosive over
  // a season.
  section('3. a vacated slot promotes the longest waiter');
  const w = await withdraw(a.id, 1);
  check('withdraw reports what was given up', w.result === 'ok' && w.was_status === 'going', `${w.result}/${w.was_status}`);
  check('the FRONT of the queue is promoted', w.promoted_discord_id === uid(3), String(w.promoted_discord_id));
  check('not the most recent waiter', w.promoted_discord_id !== uid(4));
  check('board is 2 going / 1 waiting', await board(a.id) === '02:going 03:going 04:waitlist', await board(a.id));

  // ── 4 ────────────────────────────────────────────────────────────────────
  section('4. capacity changes never take a slot back');
  const low = await setCap(a.id, 1);
  check('lowering below the current count is accepted', low.result === 'ok', low.result);
  check('nobody already holding a slot is demoted', (await entries(a.id)).filter((e) => e.status === 'going').length === 2, await board(a.id));
  check('the lower cap governs NEW joins', (await join(a.id, 5)).entry_status === 'waitlist');
  const up = await setCap(a.id, 4);
  check('raising it promotes from the front', up.promoted === 2, `promoted=${up.promoted}`);
  check('in queue order', await board(a.id) === '02:going 03:going 04:going 05:going', await board(a.id));
  check('clearing the cap drains the waitlist', (await setCap(a.id, null)).result === 'ok');

  // ── 5 ────────────────────────────────────────────────────────────────────
  // The case the FOR UPDATE exists for. Without the lock both callers read the
  // same count and both insert, and the cap is silently exceeded.
  section('5. two people racing for the last slot');
  const b = await mkSignup(1);
  const [c1, c2] = await Promise.all([join(b.id, 10), join(b.id, 11)]);
  check('exactly one wins the slot', [c1, c2].filter((r) => r.entry_status === 'going').length === 1, `${c1.entry_status} / ${c2.entry_status}`);
  check('the other is queued, not rejected', [c1, c2].filter((r) => r.entry_status === 'waitlist').length === 1);
  check('the cap is not exceeded in the table', (await entries(b.id)).filter((e) => e.status === 'going').length === 1);

  // ── 6 ────────────────────────────────────────────────────────────────────
  section('6. ten simultaneous joins, three slots');
  const c = await mkSignup(3);
  await Promise.all(Array.from({ length: 10 }, (_, i) => join(c.id, 20 + i)));
  const rows = await entries(c.id);
  check('exactly three confirmed', rows.filter((e) => e.status === 'going').length === 3, String(rows.filter((e) => e.status === 'going').length));
  check('the other seven are queued', rows.filter((e) => e.status === 'waitlist').length === 7);
  check('no duplicate rows', new Set(rows.map((e) => e.discord_id)).size === 10, `${rows.length} rows`);

  // ── 7 ────────────────────────────────────────────────────────────────────
  // The sweep, a second process instance and the manual Remind button all
  // contend for this one field. Two winners means the guild is DM'd twice.
  section('7. the reminder claim is won exactly once');
  const claim = () => s.rpc('signup_claim_reminder', { p_guild_id: G.id, p_signup_id: c.id }).then((r) => r.data);
  const [k1, k2] = await Promise.all([claim(), claim()]);
  check('exactly one of two concurrent claims wins', [k1, k2].filter(Boolean).length === 1, `${k1} / ${k2}`);
  check('a later claim also loses', (await claim()) === false);

  // ── 8 ────────────────────────────────────────────────────────────────────
  section('8. downtime fails safe, and finished events close');
  const past = await mkSignup(null, new Date(Date.now() - 6 * 3600_000).toISOString());
  await s.from('event_signups').update({ reminder_lead_minutes: 60 }).eq('id', past.id);
  const due = await s.rpc('signup_claim_due_reminders').then((r) => r.data || []);
  check('an event that already started is NOT reminded', !due.some((r) => r.id === past.id), `${due.length} claimed`);

  const soon = await mkSignup(null, new Date(Date.now() + 30 * 60_000).toISOString());
  await s.from('event_signups').update({ reminder_lead_minutes: 60 }).eq('id', soon.id);
  check('one inside its lead time IS claimed',
    (await s.rpc('signup_claim_due_reminders').then((r) => r.data || [])).some((r) => r.id === soon.id));
  check('and never a second time',
    !(await s.rpc('signup_claim_due_reminders').then((r) => r.data || [])).some((r) => r.id === soon.id));

  const closed = await s.rpc('signup_close_finished').then((r) => r.data || []);
  check('the started event is auto-closed', closed.some((r) => r.id === past.id), `${closed.length} closed`);
  check('the upcoming one is left open', !closed.some((r) => r.id === soon.id));
  check('joining a closed occurrence is refused', (await join(past.id, 99)).result === 'closed');
  check('but withdrawing from one still works', (await withdraw(past.id, 99)).result === 'absent');

  // ── 9 ────────────────────────────────────────────────────────────────────
  // The design decision the whole feature rests on, asserted against the
  // database rather than trusted to code review: there is no way to record
  // "not coming" here. That stays the LOA system's job.
  section('9. opt-in only, enforced by the schema');
  const bad = await s.from('event_signup_entries').insert({
    guild_id: G.id, signup_id: c.id, discord_id: uid(77), display_name: 'Declined', status: 'declined',
  });
  check('status "declined" is rejected by the check constraint', bad.error?.code === '23514',
    bad.error ? bad.error.code : 'ACCEPTED — the constraint is missing');

  await s.from('event_signup_entries').delete().eq('guild_id', G.id);
  await s.from('event_signups').delete().eq('guild_id', G.id);
  await s.from('guilds').delete().eq('id', G.id);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.stack || e.message); process.exit(1); });
