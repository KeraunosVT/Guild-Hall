// ============================================================================
// Two-guild test harness (plan Phase 4)
// ============================================================================
// Creates two complete tenants, seeds EVERY guild-scoped table in both with
// structurally identical rows, and hands back signed sessions for officers of
// each. Everything guild B owns carries the marker string B_MARK, so a test can
// assert "this response contains no trace of the other tenant" without knowing
// the shape of each route's payload.
//
// Guild A's rows carry A_MARK for the opposite reason: a route that returns
// nothing at all would pass an isolation check vacuously. Every read is checked
// BOTH ways — A's data present, B's data absent — so an empty response is a
// failure, not a pass.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const perms = require('../../permissions');

// Prefer a dedicated test project. TEST_SUPABASE_URL exists so these suites
// never have to point at the same database the live site serves.
const URL = process.env.TEST_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const usingFallback = !process.env.TEST_SUPABASE_URL;

const supabase = createClient(URL, KEY);

// Refuse to run against a database that already holds guild data.
//
// These suites create tenants, write to every table and delete on the way out.
// All of it is scoped to their own fixture guilds, so a correct run cannot
// touch a real tenant — but "cannot" here rests on the cleanup being right,
// and that is exactly the assumption you do not want to be making against the
// database members are using. An empty database is safe to be wrong in.
//
// Set TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY to a scratch project, or
// ALLOW_TESTS_ON_NONEMPTY_DB=1 if you have decided the risk is acceptable.
const CANARY_TABLES = ['wargame_matches', 'loot_awards', 'loa_entries', 'events', 'player_identities'];

async function assertSafeTarget() {
  if (process.env.ALLOW_TESTS_ON_NONEMPTY_DB === '1') return;

  // Rows belonging to this suite's own fixture guilds don't count. A run that
  // aborts before cleanup leaves them behind, and counting those would let one
  // crash lock out every subsequent run — the guard would be protecting the
  // database from nothing but itself. purgeStale() clears them moments later.
  const { data: fixtures } = await supabase.from('guilds')
    .select('id').in('discord_guild_id', FIXTURE_DISCORD_GUILDS);
  const fixtureIds = (fixtures || []).map((r) => r.id);

  let rows = 0;
  for (const t of CANARY_TABLES) {
    let q = supabase.from(t).select('*', { count: 'exact', head: true });
    // PostgREST needs the list bracketed; an empty `not.in` matches nothing.
    if (fixtureIds.length) q = q.not('guild_id', 'in', `(${fixtureIds.join(',')})`);
    const { count } = await q;
    rows += count || 0;
  }
  if (!rows) return;

  const project = (URL || '').replace(/^https?:\/\//, '').replace(/\..*$/, '');
  throw new Error(
    `Refusing to run integration tests against ${project}: it holds ${rows} row(s) of real guild data.\n` +
    (usingFallback
      ? '  This is SUPABASE_URL — the same database the application uses.\n'
      : '  This is TEST_SUPABASE_URL.\n') +
    '  Point TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY at a scratch project,\n' +
    '  or set ALLOW_TESTS_ON_NONEMPTY_DB=1 to override deliberately.',
  );
}

const A_MARK = 'AAOWNED';
const B_MARK = 'ZZBLEAK';

// Fixed Discord ids so a crashed run can clean up after itself next time.
const FIXTURE_DISCORD_GUILDS = ['700000000000001111', '700000000000002222'];

// Every guild-scoped table, in dependency order (parents before children).
const SCOPED_TABLES = [
  'loot_categories', 'loot_items', 'loot_awards', 'loot_wishlists',
  'wargame_matches', 'wargame_maps', 'player_match_stats',
  'events', 'event_attendance', 'event_schedule',
  // Parent before child: entries cascade from signups, and purge() reverses
  // this list, so the order here is what makes the teardown legal.
  'event_signups', 'event_signup_entries',
  'player_identities', 'member_roles', 'shard_counts',
  'gear_levels', 'gear_level_history',
  'loa_entries', 'elite_timers', 'rosters',
  'currency_awards', 'lucent_requests', 'permission_grants', 'audit_log',
];

const iso = (d = new Date()) => d.toISOString();

// One tenant's worth of data. `m` is the marker, `n` a numeric suffix that keeps
// ids unique across the two guilds where a column is globally unique.
function seedRows(guildId, m, n, tag) {
  const now = iso();
  const uid = (k) => `${n}${String(k).padStart(11, '0')}`; // discord-id-shaped
  const g = { guild_id: guildId };

  return [
    ['loot_categories', { ...g, key: `cat_${m}`, label: `${m} Weapons`, sort_order: 1 }],
    ['loot_items', { ...g, key: `item_${m}`, category_key: `cat_${m}`, name: `${m} Greatsword`, sort_order: 1 }],
    ['loot_awards', { ...g, id: null, item_key: `item_${m}`, discord_id: uid(1), display_name: `${m} Player`, awarded_at: now }],
    ['loot_wishlists', { ...g, discord_id: uid(1), display_name: `${m} Player`, picks: [m], updated_at: now }],

    ['wargame_matches', { ...g, id: null, title: `${m} War`, match_date: '2099-06-01', result: 'win', map: `${m} Map`, created_at: now }],
    ['wargame_maps', { ...g, id: null, name: `${m} Map` }],

    ['events', { ...g, id: null, title: `${m} Event`, event_date: '2099-06-01', created_at: now }],
    ['event_schedule', { ...g, id: null, name: `${m} Schedule`, day_of_week: 3, event_time: '21:00' }],

    ['player_identities', { ...g, id: null, display_name: `${m} Player`, ingame_names: [`${m}Name`], discord_id: uid(1), created_at: now, updated_at: now }],
    ['member_roles', { ...g, discord_id: uid(1), pvp_classes: [m], pve_classes: [m], pvp_role: 'dps', updated_at: now }],
    ['shard_counts', { ...g, discord_id: uid(1), display_name: `${m} Player`, shards: n, updated_at: now }],

    ['gear_levels', { ...g, discord_id: uid(1), display_name: `${m} Player`, weapon: n, armor: n, accessory: n, average: n, submitted_at: now }],
    ['gear_level_history', { ...g, id: null, discord_id: uid(1), display_name: `${m} Player`, weapon: n, armor: n, accessory: n, average: n, submitted_at: now }],

    ['loa_entries', { ...g, id: null, discord_id: uid(1), type: 'event', event_date: '2099-06-01', reason: `${m} reason`, display_name: `${m} Player`, created_at: now }],
    ['elite_timers', { ...g, location: 'Laslan', killed_at: now, next_spawn_at: now, pinged: false, updated_at: now, reported_by: m }],
    ['rosters', { ...g, id: null, name: `${m} Roster`, layout: { note: m }, created_at: now, updated_at: now }],

    ['currency_awards', { ...g, id: null, discord_id: uid(1), display_name: `${m} Player`, currency: 'lucent', amount: n, reason: m, awarded_at: now }],
    ['lucent_requests', { ...g, id: null, discord_id: uid(1), display_name: `${m} Player`, item_name: `${m} Item`, amount: n, status: 'pending', requested_at: now }],
    ['permission_grants', { ...g, id: null, subject_type: 'role', subject_id: uid(7), subject_label: `${m} Role`, permission: 'match', granted_at: now }],
    ['audit_log', { ...g, id: null, actor_id: uid(1), actor_name: `${m} Actor`, action: `POST /${m}`, method: 'POST', path: `/${m}`, feature: 'Names', body: { mark: m }, status_code: 200, created_at: now }],
  ];
}

// A table the schema doesn't have yet is almost always an unapplied migration,
// not a broken fixture — and "Could not find the table in the schema cache" is
// not a sentence that tells anyone what to do about it. Say the actual thing.
function seedError(table, m, message) {
  const missing = /could not find the table/i.test(message);
  return new Error(`seed ${table} for ${m}: ${message}`
    + (missing ? `\n  '${table}' does not exist — a migration in migrations/ has not been applied to this database yet.` : ''));
}

async function insertSeed(guildId, m, n, tag) {
  const created = {};
  for (const [table, row] of seedRows(guildId, m, n, tag)) {
    const payload = { ...row };
    if (payload.id === null) delete payload.id; // let the default uuid apply
    const { data, error } = await supabase.from(table).insert(payload).select('*').maybeSingle();
    if (error) throw seedError(table, m, error.message);
    created[table] = data;
  }

  // Children that need a parent's generated id.
  const now = iso();
  const kid = async (table, row) => {
    const { data, error } = await supabase.from(table).insert(row).select('*').maybeSingle();
    if (error) throw seedError(table, m, error.message);
    created[table] = data;
  };
  await kid('player_match_stats', {
    guild_id: guildId, match_id: created.wargame_matches.id,
    // guild_name must match the guild's alias list -- the roster routes filter
    // on it, and a mismatch yields an empty response that would pass every
    // isolation check for the wrong reason.
    player_name: `${m}Name`, guild_name: tag, team_color: 'blue',
    kills: n, assists: n, damage_dealt: n, damage_taken: n, healing: n, created_at: now,
  });
  await kid('event_attendance', {
    guild_id: guildId, event_id: created.events.id,
    discord_id: `${n}${'1'.padStart(11, '0')}`, display_name: `${m} Player`, joined_at: now,
  });
  // Far-future start time on purpose: the auto-close sweep closes anything that
  // has already begun, and a fixture that closes itself mid-run would make the
  // join/withdraw isolation checks pass for the wrong reason.
  await kid('event_signups', {
    guild_id: guildId, event_schedule_id: created.event_schedule.id,
    title: `${m} Signup`, starts_at: '2099-06-01T21:00:00Z', event_date: '2099-06-01',
    capacity: 6, status: 'open', channel_id: `signup-${tag}`, created_by: `${m} Officer`,
  });
  await kid('event_signup_entries', {
    guild_id: guildId, signup_id: created.event_signups.id,
    discord_id: `${n}${'1'.padStart(11, '0')}`, display_name: `${m} Player`,
    status: 'going', joined_at: now,
  });

  return created;
}

// Remove anything these fixtures created, in reverse dependency order.
//
// Storage too: deleting the guilds row cascades across TABLES, but the assets
// bucket knows nothing about foreign keys, so uploaded icons would pile up one
// folder per run forever. They live under loot-icons/<guild_id>/ precisely so
// they can be found and removed by guild.
async function purge(guildIds) {
  if (!guildIds.length) return;
  for (const table of [...SCOPED_TABLES, 'player_match_stats', 'event_attendance'].reverse()) {
    await supabase.from(table).delete().in('guild_id', guildIds);
  }
  for (const id of guildIds) {
    const { data: objects } = await supabase.storage.from('assets').list(`loot-icons/${id}`);
    const paths = (objects || []).map((o) => `loot-icons/${id}/${o.name}`);
    if (paths.length) await supabase.storage.from('assets').remove(paths);
  }
  await supabase.from('guilds').delete().in('id', guildIds);
}

async function purgeStale() {
  const { data } = await supabase.from('guilds').select('id').in('discord_guild_id', FIXTURE_DISCORD_GUILDS);
  await purge((data || []).map((r) => r.id));
}

const guildSeed = (house, tag, discordId, tz) => ({
  house, tag, aliases: [tag], discord_guild_id: discordId, status: 'active',
  timezone: tz, day_start: '01:00',
  admin_role_ids: [], allowed_role_ids: [], member_role_ids: [],
  roster_channel_id: `roster-${tag}`, loa_channel_id: `loa-${tag}`, announce_channel_id: `ann-${tag}`,
});

// Build both tenants from scratch. Returns everything a test needs.
async function setup() {
  await assertSafeTarget();
  await purgeStale();

  const mk = async (seed) => {
    const { data, error } = await supabase.from('guilds').insert(seed).select('*').single();
    if (error) throw new Error(`create guild: ${error.message}`);
    return data;
  };

  const A = await mk(guildSeed('House Alpha', 'AAA', FIXTURE_DISCORD_GUILDS[0], 'America/New_York'));
  const B = await mk(guildSeed('House Beta', 'BBB', FIXTURE_DISCORD_GUILDS[1], 'Europe/Berlin'));

  const dataA = await insertSeed(A.id, A_MARK, 1, A.tag);
  const dataB = await insertSeed(B.id, B_MARK, 2, B.tag);

  const ALL = perms.ALL_PERMISSIONS.map((p) => p.key);
  const member = (guild, permissions) => ({
    guild_id: guild.id, discord_guild_id: String(guild.discord_guild_id),
    house: guild.house, tag: guild.tag, roles: [], permissions,
    fullAccess: permissions.length === ALL.length,
  });
  const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

  return {
    supabase, A, B, dataA, dataB, A_MARK, B_MARK, ALL,
    // An officer of A who is ALSO a plain member of B — the sharpest case:
    // the session legitimately contains B, so nothing can be rejected merely
    // for being unknown.
    officerA: sign({
      id: '700000000000000001', username: 'OfficerA', verified_at: Date.now(),
      guilds: [member(A, ALL), member(B, [])],
    }),
    officerB: sign({
      id: '700000000000000002', username: 'OfficerB', verified_at: Date.now(),
      guilds: [member(B, ALL)],
    }),
    cleanup: () => purge([A.id, B.id]),
  };
}

module.exports = { setup, purge, purgeStale, supabase, assertSafeTarget, A_MARK, B_MARK, SCOPED_TABLES, FIXTURE_DISCORD_GUILDS };
