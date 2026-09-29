// Wargame fill pool — the rules that decide who a leader sees, and whether a
// player is free. Pure functions, no database: these are the parts that fail
// silently (a player shown to the guild they play against, or marked busy
// because a timezone was read the wrong way round), so they are pinned here.
const assert = require('assert');
const {
  isAvailable, conflictFor, overlaps, cleanSlots, cleanProfile, leaderGuilds, localParts, inPool, inviteStats,
  approvedLeaders, MAX_GUILD_LEADERS,
} = require('../wargameFills').__test;

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

const JAILED = '11111111-1111-4111-8111-111111111111';
const UNDERCOOKED = '22222222-2222-4222-8222-222222222222';
const DUSK = '33333333-3333-4333-8333-333333333333';
const MISSIONARY = '44444444-4444-4444-8444-444444444444';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const partnerOf = { [JAILED]: UNDERCOOKED, [UNDERCOOKED]: JAILED };

const player = (over = {}) => ({
  home_guild_id: null, avoid_guild_ids: [], gh_guild_ids: [], timezone: 'America/New_York', windows: [], ...over,
});
const request = (over = {}) => ({
  guild_id: TENANT, claim_guild_id: null, opponent_id: JAILED, starts_at: '2026-10-03T01:00:00Z', duration_min: 90, ...over,
});

console.log('conflicts');
test('a free agent is shown', () => assert.strictEqual(conflictFor(player(), request(), partnerOf), null));
test('the opponent\'s own player is hidden', () => assert.strictEqual(conflictFor(player({ home_guild_id: JAILED }), request(), partnerOf), 'opponent'));
test('the opponent\'s ally is hidden', () => assert.strictEqual(conflictFor(player({ home_guild_id: UNDERCOOKED }), request(), partnerOf), 'ally'));
test('an unrelated guild\'s player is shown', () => assert.strictEqual(conflictFor(player({ home_guild_id: DUSK }), request(), partnerOf), null));
test('"won\'t fill against" is honoured', () => assert.strictEqual(conflictFor(player({ avoid_guild_ids: [JAILED] }), request(), partnerOf), 'avoid'));
test('a Guild Hall guild\'s own members are not fills for it', () => assert.strictEqual(conflictFor(player({ gh_guild_ids: [TENANT] }), request(), partnerOf), 'own'));
test('an outside guild\'s own members are not fills for it', () => assert.strictEqual(
  conflictFor(player({ home_guild_id: MISSIONARY }), request({ guild_id: null, claim_guild_id: MISSIONARY }), partnerOf), 'own'));
test('a request with no opponent on record hides nobody by alliance', () => assert.strictEqual(
  conflictFor(player({ home_guild_id: UNDERCOOKED }), request({ opponent_id: null }), partnerOf), null));

console.log('availability');
// 2026-10-03T01:00Z is Friday 21:00 in New York (EDT) and Friday 18:00 in Los Angeles.
test('the start is read in the player\'s own timezone', () => {
  assert.deepStrictEqual(localParts(new Date('2026-10-03T01:00:00Z'), 'America/New_York'), { d: 5, m: 21 * 60 });
  assert.deepStrictEqual(localParts(new Date('2026-10-03T01:00:00Z'), 'America/Los_Angeles'), { d: 5, m: 18 * 60 });
});
test('a window covering the whole wargame counts', () => assert.ok(
  isAvailable(player({ windows: [{ d: 5, from: '20:00', to: '23:00' }] }), '2026-10-03T01:00:00Z', 90)));
test('a window that ends mid-wargame does not', () => assert.ok(
  !isAvailable(player({ windows: [{ d: 5, from: '20:00', to: '22:00' }] }), '2026-10-03T01:00:00Z', 90)));
test('the same instant on a different local day does not', () => assert.ok(
  !isAvailable(player({ windows: [{ d: 6, from: '20:00', to: '23:00' }] }), '2026-10-03T01:00:00Z', 90)));
test('a Los Angeles window matches the Los Angeles reading', () => assert.ok(
  isAvailable(player({ timezone: 'America/Los_Angeles', windows: [{ d: 5, from: '17:30', to: '20:00' }] }), '2026-10-03T01:00:00Z', 90)));
test('a wargame running past midnight is covered by a window to the end of the day', () => assert.ok(
  isAvailable(player({ windows: [{ d: 5, from: '22:00', to: '23:59' }] }), '2026-10-03T03:30:00Z', 90)));

console.log('clashes');
test('overlapping wargames clash', () => assert.ok(overlaps(
  { starts_at: '2026-10-03T01:00:00Z', duration_min: 60 }, { starts_at: '2026-10-03T01:30:00Z', duration_min: 60 })));
test('back-to-back wargames do not', () => assert.ok(!overlaps(
  { starts_at: '2026-10-03T01:00:00Z', duration_min: 60 }, { starts_at: '2026-10-03T02:00:00Z', duration_min: 60 })));

console.log('validation');
test('slots are counted per role', () => assert.deepStrictEqual(cleanSlots({ Tank: '1', DPS: 3 }), { Tank: 1, DPS: 3, Healer: 0 }));
test('a request with no slots is refused', () => assert.throws(() => cleanSlots({}), /at least one slot/));
test('a request with absurd slots is refused', () => assert.throws(() => cleanSlots({ DPS: 500 }), /between 0 and/));
const known = (id) => [JAILED, UNDERCOOKED, DUSK].includes(id);
const good = { role: 'Healer', classes: ['Disciple', 'Disciple', 'Crucifix'], gear: '4780', timezone: 'America/New_York',
  windows: [{ d: 5, from: '19:00', to: '23:30' }], home_guild_id: DUSK, avoid_guild_ids: [JAILED] };
test('a good profile is cleaned', () => {
  const row = cleanProfile(good, known);
  assert.deepStrictEqual(row.classes, ['Disciple', 'Crucifix']);
  assert.strictEqual(row.gear, 4780);
  assert.strictEqual(row.active, true);
});
test('an unknown role is refused', () => assert.throws(() => cleanProfile({ ...good, role: 'Bard' }, known), /Pick a role/));
test('a made-up timezone is refused', () => assert.throws(() => cleanProfile({ ...good, timezone: 'Mars/Olympus' }, known), /timezone/));
test('a window that ends before it starts is refused', () => assert.throws(
  () => cleanProfile({ ...good, windows: [{ d: 1, from: '22:00', to: '21:00' }] }, known), /ends before/));
test('a home guild that is not on the board is refused', () => assert.throws(
  () => cleanProfile({ ...good, home_guild_id: MISSIONARY }, known), /threat board/));
test('more than three classes is refused', () => assert.throws(
  () => cleanProfile({ ...good, classes: ['A', 'B', 'C', 'D'] }, known), /three/));

console.log('leaders');
test('guild leaders and `fills` holders may post; plain members may not', () => {
  const guilds = [
    { guild_id: 'a', fullAccess: true, permissions: [] },
    { guild_id: 'b', fullAccess: false, permissions: ['fills'] },
    { guild_id: 'c', fullAccess: false, permissions: ['loot.awards'] },
  ];
  assert.deepStrictEqual(leaderGuilds({ guilds }).map((g) => g.guild_id), ['a', 'b']);
  assert.deepStrictEqual(leaderGuilds({ guilds: [] }), []);
});

console.log('staff moderation');
test('a listed profile is in the pool', () => assert.ok(inPool({ active: true, staff_paused: false })));
test('a profile the player paused is not', () => assert.ok(!inPool({ active: false, staff_paused: false })));
test('a staff pause wins over the player\'s own switch', () => assert.ok(!inPool({ active: true, staff_paused: true })));
test('a profile from before saas_010 (no column) still counts as listed', () => assert.ok(inPool({ active: true })));
test('invite answers are counted per player', () => {
  const s = inviteStats([
    { discord_id: 'a', status: 'accepted' }, { discord_id: 'a', status: 'missed' },
    { discord_id: 'a', status: 'accepted' }, { discord_id: 'b', status: 'declined' },
  ]);
  assert.deepStrictEqual(s.get('a'), { invited: 0, accepted: 2, declined: 0, withdrawn: 0, missed: 1 });
  assert.strictEqual(s.get('b').declined, 1);
  assert.strictEqual(s.get('c'), undefined);
});

console.log('guild leader limit');
test('a guild may have two verified leaders', () => assert.strictEqual(MAX_GUILD_LEADERS, 2));
test('only verified leaders of that guild count, not the claimant', () => {
  const rows = [
    { discord_id: 'a', threat_guild_id: 'G', status: 'approved' },
    { discord_id: 'b', threat_guild_id: 'G', status: 'pending' },
    { discord_id: 'c', threat_guild_id: 'G', status: 'rejected' },
    { discord_id: 'd', threat_guild_id: 'H', status: 'approved' },
    { discord_id: 'e', threat_guild_id: 'G', status: 'approved' },
  ];
  assert.strictEqual(approvedLeaders(rows, 'G', 'b'), 2); // b would be a third
  assert.strictEqual(approvedLeaders(rows, 'G', 'a'), 1); // a re-approved isn't a third
  assert.strictEqual(approvedLeaders(rows, 'H', 'x'), 1);
  assert.strictEqual(approvedLeaders([], 'G', 'x'), 0);
});

console.log(`\n${passed} passed`);
