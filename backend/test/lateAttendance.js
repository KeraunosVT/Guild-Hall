// ============================================================================
// Late attendance semantics — the window, the claim, and who owns a request
// ============================================================================
// The isolation suites prove one guild's requests can't reach another's. This
// proves the feature is CORRECT within a guild, which is a different question.
//
// Everything here fails SILENTLY when it's wrong, which is why it's worth a
// suite of its own:
//   · a window boundary off by an hour just means a member is quietly refused,
//     or quietly allowed three days later — nothing errors either way;
//   · a double approval writes TWO attendance rows for one person, which
//     inflates their rate and nothing complains;
//   · a cancel that doesn't check ownership lets anyone withdraw anyone's
//     request, and the only visible symptom is a request that "disappeared".
//
// It drives the module directly rather than going through HTTP: these are
// properties of lateAttendance.js, and a route handler in between would only
// add a place for a passing test to be lying about which layer holds them.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { assertSafeTarget } = require('./lib/harness');
const createLateAttendance = require('../lateAttendance');

const s = createClient(
  process.env.TEST_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY,
);

// Its own fixture tenant, fixed so a crashed run cleans up after itself next
// time rather than leaving a guild behind forever.
const FIXTURE = '700000000000008888';

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) pass++; else { fail++; failures.push(label); }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${detail}`);
};
const section = (t) => console.log(`\n${t}`);
const uid = (n) => `8${String(n).padStart(11, '0')}`;
const HOUR = 3_600_000;

(async () => {
  await assertSafeTarget();

  const { data: stale } = await s.from('guilds').select('id').eq('discord_guild_id', FIXTURE);
  for (const g of stale || []) {
    await s.from('late_attendance_requests').delete().eq('guild_id', g.id);
    await s.from('event_attendance').delete().eq('guild_id', g.id);
    await s.from('events').delete().eq('guild_id', g.id);
    await s.from('audit_log').delete().eq('guild_id', g.id);
    await s.from('guilds').delete().eq('id', g.id);
  }

  const { data: G, error: gErr } = await s.from('guilds').insert({
    discord_guild_id: FIXTURE, house: 'Latecomers', tag: 'LATE', aliases: ['LATE'],
    timezone: 'UTC', day_start: '01:00', status: 'active',
  }).select('*').single();
  if (gErr) {
    console.error('fixture guild failed:', gErr.message);
    if (/could not find the table|schema cache/i.test(gErr.message)) {
      console.error('  a migration in migrations/ has not been applied to this database yet.');
    }
    process.exit(1);
  }

  // No identities module: display names come straight off the request, which is
  // what this suite is about. Passing null also proves the module tolerates it.
  const late = createLateAttendance(s, null);

  // An event whose attendance was taken `hoursAgo` hours ago. created_at is the
  // anchor for the whole feature — NOT event_date — so it is what varies here.
  const mkEvent = async (hoursAgo, title = 'Probe') => (await s.from('events').insert({
    guild_id: G.id, title, event_date: '2099-01-01',
    created_at: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  }).select('*').single()).data;

  const reqRows = async (eventId) => (await s.from('late_attendance_requests')
    .select('*').eq('event_id', eventId)).data || [];
  const attRows = async (eventId) => (await s.from('event_attendance')
    .select('*').eq('event_id', eventId)).data || [];
  const failed = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

  try {
    // ── 1 ────────────────────────────────────────────────────────────────────
    // The boundary, from both sides. 23 hours ago is inside a 24-hour window;
    // 25 is outside. Tested against real timestamps rather than a mocked clock,
    // because the arithmetic being tested is the arithmetic on real timestamps.
    section('1. the 24-hour window, either side of the line');
    const fresh = await mkEvent(23, 'Fresh night');
    const stale24 = await mkEvent(25, 'Stale night');

    const okFresh = await late.request(G, { eventId: fresh.id, discordId: uid(1), displayName: 'Arwel' });
    check('inside the window: filed', okFresh.status === 'pending', okFresh.status);

    const errStale = await failed(() => late.request(G, { eventId: stale24.id, discordId: uid(1), displayName: 'Arwel' }));
    check('outside the window: refused', !!errStale && errStale.status === 400, errStale ? `HTTP ${errStale.status}` : 'ACCEPTED');
    check('outside the window: nothing written', (await reqRows(stale24.id)).length === 0);

    // The list a member is offered has to agree with what the write allows —
    // an eligible list that includes an event the write then refuses is worse
    // than no list at all.
    const eligible = await late.eligibleEvents(G, uid(2));
    const ids = eligible.map((e) => String(e.id));
    check('eligible list offers the fresh event', ids.includes(String(fresh.id)));
    check('eligible list omits the stale one', !ids.includes(String(stale24.id)));

    // ── 2 ────────────────────────────────────────────────────────────────────
    section('2. one live ask per person per event');
    const dupe = await failed(() => late.request(G, { eventId: fresh.id, discordId: uid(1), displayName: 'Arwel' }));
    check('a second pending ask is refused', !!dupe && dupe.status === 409, dupe ? `HTTP ${dupe.status}` : 'ACCEPTED');
    check('still exactly one row', (await reqRows(fresh.id)).length === 1, String((await reqRows(fresh.id)).length));
    check('the member is no longer offered it', !(await late.eligibleEvents(G, uid(1))).some((e) => String(e.id) === String(fresh.id)));

    // ── 3 ────────────────────────────────────────────────────────────────────
    // Already-credited members. Without this check an approval would write a
    // second attendance row for the same person on the same night, which shows
    // up as an attendance rate above 100% and nowhere else.
    section('3. someone already on the list cannot ask');
    await s.from('event_attendance').insert({
      guild_id: G.id, event_id: fresh.id, discord_id: uid(9), display_name: 'Bedwyr',
      joined_at: new Date().toISOString(), source: 'snapshot',
    });
    const already = await failed(() => late.request(G, { eventId: fresh.id, discordId: uid(9), displayName: 'Bedwyr' }));
    check('refused for an existing attendee', !!already && already.status === 409, already ? `HTTP ${already.status}` : 'ACCEPTED');

    // ── 4 ────────────────────────────────────────────────────────────────────
    // The reason the decision is a claim rather than a read-then-write. Two
    // officers pressing approve at the same instant is not hypothetical — it is
    // what happens when a request sits in the queue over a raid night.
    section('4. two officers approving at once');
    const race = await mkEvent(1, 'Race night');
    const raced = await late.request(G, { eventId: race.id, discordId: uid(3), displayName: 'Cadell' });

    const both = await Promise.allSettled([
      late.decide(G, raced.id, 'approved', { id: uid(90), name: 'Officer One' }),
      late.decide(G, raced.id, 'approved', { id: uid(91), name: 'Officer Two' }),
    ]);
    const won = both.filter((r) => r.status === 'fulfilled').length;
    const lost = both.filter((r) => r.status === 'rejected');
    check('exactly one approval succeeds', won === 1, `${won} succeeded`);
    check('the loser is told, not silently ignored', lost.length === 1 && lost[0].reason.status === 409,
      lost.length ? `HTTP ${lost[0].reason.status}` : 'no rejection');
    check('exactly one attendance row exists', (await attRows(race.id)).length === 1,
      String((await attRows(race.id)).length));

    const [attendanceRow] = await attRows(race.id);
    check("the row is marked 'late', not a snapshot", attendanceRow.source === 'late', attendanceRow.source);
    const [decided] = await reqRows(race.id);
    check('the request records who decided it', !!decided.decided_by, String(decided.decided_by));
    check('the request points at the row it created', decided.attendance_id === attendanceRow.id);

    // ── 5 ────────────────────────────────────────────────────────────────────
    // A denial keeps the record. Deleting it would erase the only evidence that
    // an officer looked at the claim and said no.
    section('5. a denial is recorded, not erased');
    const denyEvent = await mkEvent(2, 'Denial night');
    const toDeny = await late.request(G, { eventId: denyEvent.id, discordId: uid(4), displayName: 'Deri' });
    await late.decide(G, toDeny.id, 'denied', { id: uid(90), name: 'Officer One' });
    const [denialRow] = await reqRows(denyEvent.id);
    check('the request survives the denial', !!denialRow && denialRow.status === 'denied', denialRow && denialRow.status);
    check('no attendance was written', (await attRows(denyEvent.id)).length === 0);
    // A decided request must not block a fresh ask — a denial that was a
    // misunderstanding should be appealable while the window is still open.
    const reAsk = await failed(() => late.request(G, { eventId: denyEvent.id, discordId: uid(4), displayName: 'Deri' }));
    check('the member may ask again after a denial', reAsk === null, reAsk ? reAsk.message : '');

    // ── 6 ────────────────────────────────────────────────────────────────────
    section('6. a request belongs to the member who filed it');
    const ownEvent = await mkEvent(1, 'Ownership night');
    const mine = await late.request(G, { eventId: ownEvent.id, discordId: uid(5), displayName: 'Elin' });

    const notYours = await failed(() => late.cancel(G, mine.id, uid(6)));
    check("someone else cannot withdraw it", !!notYours && notYours.status === 404, notYours ? `HTTP ${notYours.status}` : 'CANCELLED');
    check('it is still there', (await reqRows(ownEvent.id)).length === 1);

    const ownCancel = await failed(() => late.cancel(G, mine.id, uid(5)));
    check('the owner can withdraw it', ownCancel === null, ownCancel ? ownCancel.message : '');
    check('and it is gone', (await reqRows(ownEvent.id)).length === 0);

    // Withdrawing is only for undecided asks — a member must not be able to
    // erase a denial by cancelling it after the fact.
    const decidedCancel = await failed(() => late.cancel(G, toDeny.id, uid(4)));
    check('a decided request cannot be withdrawn', !!decidedCancel && decidedCancel.status === 404,
      decidedCancel ? `HTTP ${decidedCancel.status}` : 'CANCELLED');

    // ── 7 ────────────────────────────────────────────────────────────────────
    section('7. a decision has to be a decision');
    const junk = await failed(() => late.decide(G, mine.id, 'maybe', { id: uid(90), name: 'Officer One' }));
    check("'maybe' is refused", !!junk && junk.status === 400, junk ? `HTTP ${junk.status}` : 'ACCEPTED');
    const ghost = await failed(() => late.decide(G, '00000000-0000-4000-8000-000000000000', 'approved', { id: uid(90) }));
    check('an unknown id is a 404, not a crash', !!ghost && ghost.status === 404, ghost ? `HTTP ${ghost.status}` : 'ACCEPTED');
  } finally {
    await s.from('late_attendance_requests').delete().eq('guild_id', G.id);
    await s.from('event_attendance').delete().eq('guild_id', G.id);
    await s.from('events').delete().eq('guild_id', G.id);
    await s.from('audit_log').delete().eq('guild_id', G.id);
    await s.from('guilds').delete().eq('id', G.id);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(1); });
