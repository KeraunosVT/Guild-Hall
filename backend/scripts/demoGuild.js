#!/usr/bin/env node
// ============================================================================
// Seed (or remove) a demo guild — a complete, browsable tenant with no real
// people in it.
// ============================================================================
// Usage, from backend/:
//   node scripts/demoGuild.js                 seed into the scratch project
//   node scripts/demoGuild.js --purge         remove it again
//   node scripts/demoGuild.js --target app    seed into the LIVE app database
//   node scripts/demoGuild.js --dry-run       say what it would write, write nothing
//
// ── WHICH DATABASE, AND WHY IT DEFAULTS THE WAY IT DOES ────────────────────
// This writes two dozen invented members, their gear, their loot, and a war
// record. That is fiction, and fiction in the database members actually use is
// not a demo — it is corruption of the record officers make decisions from.
//
// So the default target is TEST_SUPABASE_URL, the scratch project the test
// suite already writes to. `--target app` exists because seeing the demo on a
// real deployment is a legitimate thing to want, but it is opt-in, it prints
// what it is about to do, and it refuses outright if it can't tell the two
// projects apart.
//
// Everything it writes hangs off ONE guilds row, so `--purge` is a cascade
// delete and cannot reach a neighbouring tenant.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const LOOT = require('../../shared/loot.json');
const SHARDS = require('../../shared/shards.json');
const { guildTimeOn } = require('../eliteTimers');
const {
  DEMO_DISCORD_GUILD, DEMO_GUILD_ID, ROLE_OFFICER, ROLE_MEMBER, ROLE_RAIDER, ROLE_TRIAL, MEMBERS,
} = require('./demoFixture');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const flag = (f) => { const i = argv.indexOf('--' + f); return i === -1 ? undefined : argv[i + 1]; };

const TARGET = flag('target') || 'test';
const DRY = has('dry-run');
const TZ = 'America/New_York';

// ── Target selection ────────────────────────────────────────────────────────
const url = TARGET === 'app' ? process.env.SUPABASE_URL : process.env.TEST_SUPABASE_URL;
const key = TARGET === 'app' ? process.env.SUPABASE_SERVICE_KEY : process.env.TEST_SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error(TARGET === 'app'
    ? 'SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.'
    : 'TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY are not set.\n'
      + '  Point them at a scratch Supabase project, or pass --target app to use the live one.');
  process.exit(1);
}
// A scratch project that is secretly the live one would make the safe default a
// lie, so it is checked rather than trusted.
if (TARGET !== 'app' && process.env.SUPABASE_URL && url === process.env.SUPABASE_URL) {
  console.error('TEST_SUPABASE_URL is the same project as SUPABASE_URL — refusing to seed fiction into the live database.\n'
    + '  Point TEST_SUPABASE_URL at a separate project, or pass --target app deliberately.');
  process.exit(1);
}

const project = url.replace(/^https?:\/\//, '').replace(/\..*$/, '');
const s = createClient(url, key);

// ── Dates, in the guild's own time ──────────────────────────────────────────
// Everything is relative to today so the demo is never stale: signups are
// always upcoming, attendance is always in the last fortnight.
const DAY = 86400_000;
const dayOf = (offset) => new Date(Date.now() + offset * DAY).toLocaleDateString('en-CA', { timeZone: TZ });
const at = (offsetDays, hh, mm) => guildTimeOn(dayOf(offsetDays), hh, mm, TZ).toISOString();
// The next calendar date on or after `offset` that falls on `dow`.
const nextDow = (dow, from = 1) => {
  for (let i = from; i < from + 8; i++) {
    if (new Date(`${dayOf(i)}T12:00:00`).getDay() === dow) return i;
  }
  return from;
};
const iso = (d = new Date()) => d.toISOString();
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

const insert = async (table, rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return [];
  if (DRY) { console.log(`  would insert ${String(list.length).padStart(3)} × ${table}`); return []; }
  const { data, error } = await s.from(table).insert(list).select('*');
  if (error) {
    throw new Error(`${table}: ${error.message}`
      + (/could not find the table|column/i.test(error.message)
        ? `\n  a migration in migrations/ has not been applied to ${project} yet.` : ''));
  }
  console.log(`  ${String(list.length).padStart(3)} × ${table}`);
  return data || [];
};

// ── Purge ───────────────────────────────────────────────────────────────────
// One delete. Every table hangs off guilds.id with `on delete cascade`, so
// there is no list of tables here to fall out of date as the schema grows.
async function purge() {
  const { data } = await s.from('guilds').select('id, house').eq('discord_guild_id', DEMO_DISCORD_GUILD);
  if (!data || !data.length) { console.log(`No demo guild in ${project}.`); return null; }
  if (DRY) { console.log(`Would delete "${data[0].house}" and everything it owns from ${project}.`); return null; }
  await s.from('guilds').delete().eq('discord_guild_id', DEMO_DISCORD_GUILD);
  console.log(`Removed "${data[0].house}" and everything it owned from ${project}.`);
  return data[0].id;
}

// ── Seed ────────────────────────────────────────────────────────────────────
async function seed() {
  // Re-seeding replaces rather than stacks: the occurrence unique index and the
  // per-member primary keys would both reject a second run otherwise, and
  // half-failing partway through is a worse state than starting clean.
  await purge();
  if (DRY) console.log('\n(dry run — nothing below is written)\n');

  const guildRow = {
    id: DEMO_GUILD_ID,
    discord_guild_id: DEMO_DISCORD_GUILD,
    house: 'House Umbral', tag: 'UMBRA', aliases: ['UMBRA', 'DUSK'],
    motto: 'Last through the dark.',
    creed: 'We show up. We call it early. We do not leave people standing in the field.',
    timezone: TZ, day_start: '01:00',
    admin_role_ids: [ROLE_OFFICER],
    allowed_role_ids: [],                         // empty = anyone in the server may sign in
    member_role_ids: [ROLE_MEMBER, ROLE_TRIAL],
    roster_channel_id: '810000000000000201',
    loa_channel_id: '810000000000000202',
    announce_channel_id: '810000000000000203',
    signup_channel_id: '810000000000000204',
    // A VOICE channel — the one the bot reads rather than writes. Set here so
    // the Attendance page opens with it already chosen, which is what the
    // setting is for.
    attendance_voice_channel_id: '810000000000000301',
    signup_mention_role_id: ROLE_RAIDER,
    status: 'active',
  };

  console.log(`Seeding "House Umbral" into ${project}…`);
  if (DRY) { console.log('  would insert   1 × guilds'); }
  const G = DRY ? { id: '00000000-0000-0000-0000-000000000000' }
    : (await insert('guilds', guildRow))[0];
  const g = { guild_id: G.id };
  const nameOf = (m) => m.name;

  // ── People ────────────────────────────────────────────────────────────────
  await insert('player_identities', MEMBERS.map((m) => ({
    ...g, discord_id: m.id, display_name: m.name,
    ingame_names: [m.name, `${m.name}TL`], created_at: iso(), updated_at: iso(),
  })));

  await insert('member_roles', MEMBERS.map((m) => ({
    ...g, discord_id: m.id,
    pvp_role: m.role, pve_role: m.role,
    pvp_classes: m.classes, pve_classes: m.classes, updated_at: iso(),
  })));

  // Item level runs 50–80 in Throne & Liberty (gearIlvl.js: MAX_LEVEL = 80), so
  // the three slots sit within a couple of levels of the average and are clamped
  // at the cap — a "weapon 118" would be visibly not a real number.
  //
  // A zero is a member who has never uploaded: the leaderboard needs one or its
  // empty state never shows. Two members sit at 80 across the board, which is
  // what sets `maxed_at`.
  const lvl = (v) => Math.max(0, Math.min(80, v));
  const geared = MEMBERS.filter((m) => m.gear > 0);
  await insert('gear_levels', geared.map((m) => ({
    ...g, discord_id: m.id, display_name: m.name,
    weapon: lvl(m.gear + 1), armor: lvl(m.gear - 1), accessory: lvl(m.gear), average: m.gear,
    submitted_at: ago(60 * 24 * (m.n % 9)),
    maxed_at: m.gear === 80 ? ago(60 * 24 * 11) : null,
  })));
  // Two earlier submissions each, so the progression chart has a line to draw.
  await insert('gear_level_history', geared.flatMap((m) => [30, 10].map((d, i) => {
    const avg = lvl(m.gear - 3 * (2 - i));
    return {
      ...g, discord_id: m.id, display_name: m.name,
      weapon: lvl(avg + 1), armor: lvl(avg - 1), accessory: avg, average: avg,
      submitted_at: ago(60 * 24 * d),
    };
  })));

  await insert('shard_counts', MEMBERS.slice(0, 16).map((m) => ({
    ...g, discord_id: m.id, display_name: m.name,
    shards: Object.fromEntries(SHARDS.types.map((t, i) => [t.key, (m.n * 7 + i * 11) % SHARDS.max])),
    updated_at: iso(),
  })));

  // ── The schedule ──────────────────────────────────────────────────────────
  // The 00:30 Saturday-night boss is stored under SUNDAY, which is the whole
  // point of including it: it is the row that proves the guild-night rollover
  // is doing something, on every page that reads the schedule.
  const schedule = await insert('event_schedule', [
    { ...g, name: 'Guild Siege', day_of_week: 0, event_time: '21:00' },
    { ...g, name: 'Boonstone Rotation', day_of_week: 2, event_time: '20:00' },
    { ...g, name: 'Riftstone Contest', day_of_week: 3, event_time: '21:30' },
    { ...g, name: 'Archboss — Morokai', day_of_week: 4, event_time: '20:00' },
    { ...g, name: 'Guild Field Boss', day_of_week: 6, event_time: '20:00' },
    { ...g, name: 'Late Field Boss', day_of_week: 0, event_time: '00:30' },
  ]);
  const sched = (name) => schedule.find((r) => r.name === name) || { id: null };

  // ── The saved party ───────────────────────────────────────────────────────
  // Seeded BEFORE the attendance history, because an event stores a frozen copy
  // of the party it ran with and needs one to exist first.
  //
  // Two of the eighteen (Wynne, Yestin) are outside the attendance list on
  // purpose: the party block strikes through anyone who was in a party and not
  // in the record, and a demo where every name is present never shows it.
  const partyPicks = [
    [0, 4, 8, 12, 16, 21],
    [1, 5, 9, 13, 17, 22],
    [2, 6, 10, 14, 18, 19],
  ];
  const siegeLayout = {
    parties: partyPicks.map((idxs, i) => ({
      id: `p${i + 1}`,
      name: `Party ${i + 1}`,
      members: idxs.map((k) => ({ id: MEMBERS[k].id, name: MEMBERS[k].name, role: MEMBERS[k].role })),
    })),
    absent: [],
  };
  const [siegeRoster] = await insert('rosters', {
    ...g, name: 'Siege — last week', event_date: dayOf(-7),
    event_schedule_id: sched('Guild Siege').id,
    layout: siegeLayout,
    created_at: ago(60 * 24 * 7), updated_at: ago(60 * 24 * 7),
  });

  // ── Attendance history ────────────────────────────────────────────────────
  // Three nights back, with attendance thinning out — enough for the breakdown
  // to have both an excused and an unexcused column to fill.
  //
  // The most recent night is deliberately within 24 hours of `now`, so the
  // member-facing page has a live "Request late attendance" window to show. The
  // other two are outside it, which is the state most nights are in.
  const past = [
    { title: 'Guild Siege', days: -7, present: 21, roster: siegeRoster },
    { title: 'Archboss — Morokai', days: -4, present: 17 },
    // The snapshot misses the demo's own viewer (MEMBERS[0], an officer) on the
    // most recent night — deliberately, because they signed up for it. That is
    // the exact case late attendance exists for, and without it the member page
    // has no live window to show and the button never appears in the demo.
    { title: 'Guild Field Boss', days: -1, present: 15, skip: 0, takenMinsAgo: 90 },
  ];
  const events = {};
  for (const p of past) {
    const takenAgo = p.takenMinsAgo || 60 * 24 * -p.days;
    const [ev] = await insert('events', {
      ...g, title: p.title, event_date: dayOf(p.days),
      event_schedule_id: sched(p.title).id, created_at: ago(takenAgo),
      // Frozen copy, not a link — see migrations/saas_004. The roster's own
      // name travels inside it so the event can still say which party it was
      // even if the roster is later deleted.
      ...(p.roster ? { roster_id: p.roster.id, party_layout: { ...siegeLayout, name: p.roster.name } } : {}),
    });
    if (DRY) continue;
    events[p.title] = ev;
    await insert('event_attendance', MEMBERS.slice(0, p.present)
      .filter((m, k) => k !== p.skip)
      .map((m) => ({
        ...g, event_id: ev.id, discord_id: m.id, display_name: m.name,
        joined_at: ago(takenAgo), source: 'snapshot',
      })));
  }

  // ── Late attendance ───────────────────────────────────────────────────────
  // One of each state the officer queue and the member page can be in: an
  // approved one (which is why Osian is on the siege list at all, an hour after
  // everyone else), a pending one waiting on an officer, and a denial — kept on
  // record, because a denial that deletes itself leaves no answer to "did
  // anyone look at this".
  if (!DRY) {
    const siege = events['Guild Siege'];
    const fieldBoss = events['Guild Field Boss'];
    const lateAdded = MEMBERS[14]; // Nerys — outside the field boss's 14 present
    const [lateRow] = await insert('event_attendance', {
      ...g, event_id: siege.id, discord_id: MEMBERS[23].id, display_name: MEMBERS[23].name,
      joined_at: ago(60 * 24 * 7 - 90), source: 'late',
    });
    await insert('late_attendance_requests', [
      { ...g, event_id: siege.id, discord_id: MEMBERS[23].id, display_name: MEMBERS[23].name,
        reason: 'Joined comms at 9:05 — was in the fight the whole time.',
        status: 'approved', requested_at: ago(60 * 24 * 7 - 30),
        decided_by: MEMBERS[0].name, decided_at: ago(60 * 24 * 7 - 90), attendance_id: lateRow.id },
      { ...g, event_id: fieldBoss.id, discord_id: lateAdded.id, display_name: lateAdded.name,
        reason: 'Discord dropped my voice state mid-pull.',
        status: 'pending', requested_at: ago(45) },
      { ...g, event_id: siege.id, discord_id: MEMBERS[20].id, display_name: MEMBERS[20].name,
        reason: 'I think I was there?', status: 'denied', requested_at: ago(60 * 24 * 7 - 20),
        decided_by: MEMBERS[3].name, decided_at: ago(60 * 24 * 7 - 60) },
    ]);
  }

  // ── Leave of absence ──────────────────────────────────────────────────────
  // One of each type, because the three read very differently on the board and
  // a demo showing only single-date entries hides two thirds of the feature.
  await insert('loa_entries', [
    { ...g, discord_id: MEMBERS[7].id, display_name: MEMBERS[7].name, type: 'event',
      event_date: dayOf(nextDow(0)), event_schedule_id: sched('Guild Siege').id,
      reason: 'Work night shift', created_at: ago(2000) },
    { ...g, discord_id: MEMBERS[12].id, display_name: MEMBERS[12].name, type: 'range',
      start_date: dayOf(1), end_date: dayOf(6), reason: 'Holiday — back Sunday', created_at: ago(4000) },
    { ...g, discord_id: MEMBERS[16].id, display_name: MEMBERS[16].name, type: 'recurring',
      day_of_week: 2, reason: 'Class every Tuesday', created_at: ago(9000) },
    // Time-scoped: out for the early event, back for the late one. This is the
    // case the whole day_start/daySlot machinery exists to get right.
    { ...g, discord_id: MEMBERS[9].id, display_name: MEMBERS[9].name, type: 'event',
      event_date: dayOf(nextDow(6)), start_time: '20:00', end_time: '22:00',
      reason: 'Late home — can make the 12:30', created_at: ago(600) },
    // Filed BEFORE a night that has already happened. Every other entry here is
    // upcoming, which means the attendance table's "LOA" status would never
    // appear on any past event — the excused column would read empty and look
    // like the feature does nothing.
    { ...g, discord_id: MEMBERS[15].id, display_name: MEMBERS[15].name, type: 'event',
      event_date: dayOf(-1), event_schedule_id: sched('Guild Field Boss').id,
      reason: 'Family thing — said so on Tuesday', created_at: ago(60 * 24 * 4) },
    { ...g, discord_id: MEMBERS[17].id, display_name: MEMBERS[17].name, type: 'range',
      start_date: dayOf(-3), end_date: dayOf(-1), reason: 'Away for the weekend', created_at: ago(60 * 24 * 5) },
  ]);

  // ── Signups ───────────────────────────────────────────────────────────────
  // Two open occurrences with deliberately different shapes: one capped and
  // over-subscribed so the waitlist is populated, one uncapped and quiet.
  const siegeIn = nextDow(0);
  const bossIn = nextDow(6);
  const [siege, boss, pastBoss] = await insert('event_signups', [
    { ...g, event_schedule_id: sched('Guild Siege').id, title: 'Guild Siege',
      starts_at: at(siegeIn, 21, 0), event_date: dayOf(siegeIn),
      capacity: 12, status: 'open', reminder_lead_minutes: 90,
      channel_id: '810000000000000204', message_id: '810000000000000900',
      mention_role_id: ROLE_RAIDER, created_by: MEMBERS[0].name, created_at: ago(3000) },
    { ...g, event_schedule_id: sched('Guild Field Boss').id, title: 'Guild Field Boss',
      starts_at: at(bossIn, 20, 0), event_date: dayOf(bossIn),
      capacity: null, status: 'open', reminder_lead_minutes: null,
      channel_id: '810000000000000204', message_id: '810000000000000901',
      mention_role_id: null, created_by: MEMBERS[3].name, created_at: ago(1500) },
    // A CLOSED occurrence for the night attendance was last taken. Without one,
    // the attendance table can never show "No-show (signed up)" or a walk-in —
    // both of those exist only in the gap between who said they were coming and
    // who was in the channel, and with no past signup there is no gap.
    { ...g, event_schedule_id: sched('Guild Field Boss').id, title: 'Guild Field Boss',
      starts_at: at(-1, 20, 0), event_date: dayOf(-1),
      capacity: null, status: 'closed', reminder_lead_minutes: null,
      channel_id: '810000000000000204', message_id: '810000000000000902',
      mention_role_id: null, created_by: MEMBERS[3].name, created_at: ago(60 * 24 * 2) },
  ]);

  if (!DRY) {
    // 16 for 12 slots: 12 going, 4 queued. `seq` is an identity column, so
    // insert order here IS the waitlist order the promotion functions honour.
    const siegeGoers = MEMBERS.slice(0, 16);
    await insert('event_signup_entries', siegeGoers.map((m, i) => ({
      ...g, signup_id: siege.id, discord_id: m.id, display_name: m.name,
      status: i < 12 ? 'going' : 'waitlist', joined_at: ago(3000 - i * 40),
      // One member added by an officer rather than clicking, so the "added by"
      // tooltip has something to say.
      added_by: i === 11 ? MEMBERS[0].name : null,
    })));
    // A thinner, role-lopsided turnout: all DPS and no healer, which is exactly
    // the state the composition banner exists to shout about.
    await insert('event_signup_entries', [8, 9, 10, 11, 12, 13, 20, 21]
      .map((idx, i) => ({
        ...g, signup_id: boss.id, discord_id: MEMBERS[idx].id, display_name: MEMBERS[idx].name,
        status: 'going', joined_at: ago(1400 - i * 30), added_by: null,
      })));
    // Last night's declarations, against the 14 who were actually in the
    // channel (MEMBERS 0–13). Indices 15 and 18 said they were coming and
    // weren't there, which is the "No-show (signed up)" status; index 15 also
    // filed an LOA afterwards, so that row carries its LOA as mitigation.
    // Everyone attending who is NOT in this list reads as a walk-in.
    await insert('event_signup_entries', [0, 1, 2, 3, 4, 5, 6, 15, 18]
      .map((idx, i) => ({
        ...g, signup_id: pastBoss.id, discord_id: MEMBERS[idx].id, display_name: MEMBERS[idx].name,
        status: 'going', joined_at: ago(60 * 24 * 2 - i * 20), added_by: null,
      })));
  }

  // ── Loot ──────────────────────────────────────────────────────────────────
  // Straight from shared/loot.json — the catalog is per-guild in the database
  // with no fallback to that file, so a tenant with no rows has an empty loot
  // page. This is what onboarding a real guild would put there.
  await insert('loot_categories', LOOT.categories.map((c, i) => ({
    ...g, key: c.key, label: c.label, sort_order: i,
  })));
  await insert('loot_items', LOOT.categories.flatMap((c) => c.items.map((it, i) => ({
    ...g, key: it.key, category_key: c.key, name: it.name, sort_order: i,
  }))));

  const allItems = LOOT.categories.flatMap((c) => c.items);
  await insert('loot_wishlists', MEMBERS.slice(0, 18).map((m) => ({
    ...g, discord_id: m.id, display_name: m.name,
    picks: Object.fromEntries([0, 1, 2].map((k) => {
      const it = allItems[(m.n * 5 + k * 7) % allItems.length];
      return [it.key, { priority: LOOT.priorities[k % LOOT.priorities.length], added_at: ago(5000 - k * 100) }];
    })),
    updated_at: iso(),
  })));

  await insert('loot_awards', [0, 3, 8, 11, 15].map((idx, i) => ({
    ...g, item_key: allItems[(idx * 5) % allItems.length].key,
    discord_id: MEMBERS[idx].id, display_name: MEMBERS[idx].name,
    priority: LOOT.priorities[i % LOOT.priorities.length],
    awarded_by: MEMBERS[0].name, awarded_at: ago(60 * 24 * (i + 2)),
  })));

  await insert('currency_awards', [1, 4, 9, 14].map((idx, i) => ({
    ...g, discord_id: MEMBERS[idx].id, display_name: MEMBERS[idx].name,
    currency: 'lucent', amount: 500 * (i + 1), reason: 'Siege MVP',
    awarded_by: MEMBERS[0].name, awarded_at: ago(60 * 24 * (i + 1)),
  })));

  await insert('lucent_requests', [
    { ...g, discord_id: MEMBERS[5].id, display_name: MEMBERS[5].name,
      item_name: 'Resilience Rune', amount: 900, status: 'pending',
      note: 'Last piece for the siege set', requested_at: ago(400) },
    { ...g, discord_id: MEMBERS[10].id, display_name: MEMBERS[10].name,
      item_name: 'Precision Rune', amount: 1400, status: 'pending', requested_at: ago(1200) },
    { ...g, discord_id: MEMBERS[2].id, display_name: MEMBERS[2].name,
      item_name: 'Endurance Rune', amount: 750, status: 'approved',
      decided_by: MEMBERS[0].name, decided_at: ago(2000), requested_at: ago(3000) },
  ]);

  // ── War record ────────────────────────────────────────────────────────────
  await insert('wargame_maps', ['Ruins of Turayne', 'Windhill Shore', 'Monolith Wastes']
    .map((name) => ({ ...g, name })));

  // 'Win' / 'Loss' are matched CASE-SENSITIVELY when the map record is tallied
  // (server.js: `m.result === 'Win'`), so lowercase here counts as neither and
  // every map reads 0 wins, 0 losses, 0% — which is exactly what it looked like
  // before this was fixed.
  const matches = [
    { title: 'Ruins of Turayne', date: -12, result: 'Win', map: 'Ruins of Turayne' },
    { title: 'Windhill Shore', date: -6, result: 'Loss', map: 'Windhill Shore' },
    { title: 'Monolith Wastes', date: -1, result: 'Win', map: 'Monolith Wastes' },
  ];
  for (const mt of matches) {
    const [row] = await insert('wargame_matches', {
      ...g, title: mt.title, match_date: dayOf(mt.date), result: mt.result, map: mt.map,
      created_at: ago(60 * 24 * -mt.date),
    });
    if (DRY) continue;
    // Ours plus an enemy guild, because the war record's whole job is telling
    // the two apart — and it does that by matching guild_name against the
    // tenant's alias list, so 'UMBRA' here is load-bearing.
    await insert('player_match_stats', [
      // A wargame has exactly two sides, and the app normalises them to 'Red'
      // and 'Yellow' — anything else (a plausible-looking 'blue', say) is
      // normalised to empty and that team's whole scoreboard renders as zeros.
      ...MEMBERS.slice(0, 20).map((m, i) => ({
        ...g, match_id: row.id, rank: i + 1, guild_name: 'UMBRA', player_name: m.name,
        team_color: 'Yellow',
        kills: 30 - i + (m.n % 7), assists: 40 - i, damage_dealt: 4_000_000 - i * 90_000,
        damage_taken: 2_000_000 + i * 40_000, healing: m.role === 'Healer' ? 3_000_000 - i * 50_000 : 120_000,
        created_at: iso(),
      })),
      ...['Corvid', 'Halvard', 'Ysolde', 'Bram', 'Ingrid', 'Torsten'].map((nm, i) => ({
        ...g, match_id: row.id, rank: 21 + i, guild_name: 'RIVAL', player_name: nm,
        team_color: 'Red', kills: 18 - i, assists: 22 - i,
        damage_dealt: 2_400_000 - i * 80_000, damage_taken: 2_600_000 + i * 30_000, healing: 90_000,
        created_at: iso(),
      })),
    ]);
  }

  // ── Odds and ends ─────────────────────────────────────────────────────────
  await insert('elite_timers', [
    { ...g, location: 'Laslan', killed_at: ago(95), next_spawn_at: at(0, 23, 30),
      reported_by: MEMBERS[8].name, pinged: false, updated_at: ago(95) },
    { ...g, location: 'Talandre', killed_at: ago(310), next_spawn_at: at(1, 2, 15),
      reported_by: MEMBERS[13].name, pinged: false, updated_at: ago(310) },
  ]);

  // The Raider role gets two capabilities, so the permissions grid has a grant
  // in it and isn't an empty screen with a catalog beside it.
  await insert('permission_grants', ['attendance', 'parties'].map((p) => ({
    ...g, subject_type: 'role', subject_id: ROLE_RAIDER, subject_label: 'Raider',
    permission: p, granted_at: ago(60 * 24 * 30),
  })));

  await insert('audit_log', [
    { ...g, actor_id: MEMBERS[0].id, actor_name: MEMBERS[0].name, action: 'signup opened: Guild Siege',
      method: 'POST', path: '/signups', feature: 'Attendance', body: {}, status_code: 200, created_at: ago(3000) },
    { ...g, actor_id: MEMBERS[3].id, actor_name: MEMBERS[3].name, action: 'attendance logged: Guild Field Boss',
      method: 'POST', path: '/admin/events', feature: 'Attendance', body: {}, status_code: 200, created_at: ago(2880) },
    { ...g, actor_id: MEMBERS[0].id, actor_name: MEMBERS[0].name, action: 'loot awarded',
      method: 'POST', path: '/admin/loot/award', feature: 'Loot', body: {}, status_code: 200, created_at: ago(2000) },
  ]);

  return G;
}

(async () => {
  try {
    if (has('purge')) { await purge(); return; }
    const G = await seed();
    if (DRY) { console.log('\nDry run complete — nothing was written.'); return; }
    console.log(`\nDemo guild ready in ${project}.`);
    console.log(`  guilds.id            ${G.id}`);
    console.log(`  discord_guild_id     ${DEMO_DISCORD_GUILD}`);
    console.log('\nNow run:  node scripts/demoServer.js');
    console.log('Remove it later with:  node scripts/demoGuild.js --purge');
  } catch (err) {
    console.error('\nFailed:', err.message);
    process.exit(1);
  }
})();
