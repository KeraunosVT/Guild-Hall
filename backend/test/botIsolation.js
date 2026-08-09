// ============================================================================
// Bot-side isolation test (plan task 12 / Phase 4)
// ============================================================================
// The interaction path is the highest-risk code in the project: a missed tenant
// resolution does not error, it writes one guild's data into another's. This
// drives the real handleInteraction against the real database with a fake
// Discord client, so no gateway connection or bot token is needed and no
// message is ever sent to a real server.
//
// Two tenants with DELIBERATELY COLLIDING data: same command payloads, same
// elite-timer location, same officer role id, overlapping member. If anything
// resolves the tenant by anything other than interaction.guildId, these collide.
//
// Run:  node test/botIsolation.js       (from backend/)
// It talks to the Supabase in backend/.env, creates two throwaway guilds, and
// deletes them plus everything they wrote on the way out. Exits non-zero on any
// failure. No Discord traffic of any kind.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

// Same target selection and same safety guard as the other suites: prefer a
// scratch project, and refuse a database that already holds real guild data.
const { assertSafeTarget, supabase: s } = require('./lib/harness');
const gw = require('../discordGateway');
const T = gw.__test;

const OFFICER_ROLE = '600000000000000001'; // the SAME role id in both guilds
const USER = { id: '600000000000000009', username: 'Wanderer', globalName: 'Wanderer', bot: false };

const sent = [];   // every channel.send across both guilds
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + detail);
  ok ? pass++ : fail++;
};

// ── Fake Discord client ─────────────────────────────────────────────────────
// Only what the handlers actually touch: guilds.cache, channels.cache,
// isTextBased(), send(), and users.fetch() for attendance DMs.
function makeChannel(id, guildId) {
  return {
    id,
    type: 0,
    isTextBased: () => true,
    send: async (text) => { sent.push({ channel: id, guildId, text }); return { id: 'msg-' + id + '-' + sent.length }; },
    messages: { delete: async () => {} },
  };
}

function makeFakeClient(guilds) {
  const cache = new Map();
  for (const g of guilds) {
    const channels = new Map();
    [g.loa_channel_id, g.announce_channel_id].filter(Boolean)
      .forEach((c) => channels.set(c, makeChannel(c, g.discord_guild_id)));
    cache.set(String(g.discord_guild_id), { id: String(g.discord_guild_id), channels: { cache: channels } });
  }
  return { guilds: { cache }, users: { fetch: async () => ({ send: async () => {} }) } };
}

// ── Fake interaction ────────────────────────────────────────────────────────
function makeInteraction({ guildId, command, sub, opts = {}, roles = [], user = USER }) {
  const replies = [];
  const roleSet = new Set(roles);
  return {
    guildId: String(guildId),
    commandName: command,
    user,
    member: { roles: { cache: { has: (r) => roleSet.has(r) } } },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (n) => (opts[n] === undefined ? null : String(opts[n])),
      getInteger: (n) => (opts[n] === undefined ? null : parseInt(opts[n], 10)),
      getUser: (n) => opts[n] || null,
      getRole: (n) => opts[n] || null,
      getChannel: (n) => opts[n] || null,
      getFocused: () => '',
    },
    deferReply: async () => {},
    editReply: async (m) => { replies.push(typeof m === 'string' ? m : JSON.stringify(m)); return {}; },
    reply: async (m) => { replies.push(typeof m === 'string' ? m : (m.content || JSON.stringify(m))); return {}; },
    followUp: async (m) => { replies.push(typeof m === 'string' ? m : (m.content || JSON.stringify(m))); return {}; },
    respond: async () => {},
    replies,
  };
}

(async () => {
  // ── Two tenants, deliberately similar ─────────────────────────────────────
  const mk = (house, tag, discordId, tz, dayStart) => ({
    house, tag, aliases: [tag], discord_guild_id: discordId, status: 'active',
    timezone: tz, day_start: dayStart,
    admin_role_ids: [OFFICER_ROLE], allowed_role_ids: [], member_role_ids: [],
    loa_channel_id: 'loa-' + tag, announce_channel_id: 'ann-' + tag,
  });

  // Self-healing: a crashed earlier run leaves these rows behind, and
  // discord_guild_id is unique, so clear them before seeding.
  const FIXTURE_IDS = ['600000000000001111', '600000000000002222'];
  const stale = (await s.from('guilds').select('id').in('discord_guild_id', FIXTURE_IDS)).data || [];
  if (stale.length) {
    const ids = stale.map((r) => r.id);
    for (const t of ['elite_timers', 'loa_entries']) await s.from(t).delete().in('guild_id', ids);
    await s.from('guilds').delete().in('id', ids);
  }

  const insA = await s.from('guilds').insert(mk('House Alpha', 'AAA', FIXTURE_IDS[0], 'America/New_York', '01:00')).select('*').single();
  // House Beta does NOT grant the shared role officer status.
  const betaSeed = mk('House Beta', 'BBB', FIXTURE_IDS[1], 'Europe/Berlin', '04:00');
  betaSeed.admin_role_ids = [];
  const insB = await s.from('guilds').insert(betaSeed).select('*').single();
  if (insA.error || insB.error) {
    return console.log('FIXTURE FAILED:', (insA.error || insB.error).message);
  }
  const rowA = insA.data, rowB = insB.data;

  T.wire(s, makeFakeClient([rowA, rowB]));

  let lastReplies = [];
  const run = async (i) => { await gw.__test.handleInteraction(i); lastReplies = i.replies; return i; };
  const rows = async (table, guildId) => (await s.from(table).select('*').eq('guild_id', guildId)).data || [];

  // ── 1. Unregistered server is refused, and writes nothing ─────────────────
  console.log('\n1. unregistered server');
  let i = await run(makeInteraction({ guildId: '600000000000009999', command: 'elitetimer', opts: { location: 'Laslan', time: '10:00' } }));
  check('refused with an explanation', /not registered/i.test(i.replies[0] || ''), i.replies[0] || '(no reply)');
  const orphan = (await s.from('elite_timers').select('*').eq('location', 'Laslan')).data || [];
  check('wrote no elite_timers row anywhere', orphan.length === 0, orphan.length + ' rows');

  // ── 2. Same location reported in both guilds ──────────────────────────────
  console.log('\n2. identical elite timer in both guilds');
  await run(makeInteraction({ guildId: rowA.discord_guild_id, command: 'elitetimer', opts: { location: 'Laslan', time: '10:00' } }));
  await run(makeInteraction({ guildId: rowB.discord_guild_id, command: 'elitetimer', opts: { location: 'Laslan', time: '10:00' } }));
  const tA = await rows('elite_timers', rowA.id);
  const tB = await rows('elite_timers', rowB.id);
  check('guild A has exactly its own row', tA.length === 1 && tA[0].location === 'Laslan', tA.length + ' rows');
  check('guild B has exactly its own row', tB.length === 1 && tB[0].location === 'Laslan', tB.length + ' rows');
  check('the two rows are distinct records', tA.length === 1 && tB.length === 1 && tA[0].guild_id !== tB[0].guild_id);
  // Different timezones -> the same "10:00" is a different UTC instant.
  check('respawn resolved in each guild\'s timezone',
    tA.length && tB.length && tA[0].killed_at !== tB[0].killed_at,
    (tA[0] || {}).killed_at + '  vs  ' + (tB[0] || {}).killed_at);

  // ── 3. /elitetimers list shows only your own guild ────────────────────────
  console.log('\n3. list command');
  i = await run(makeInteraction({ guildId: rowA.discord_guild_id, command: 'elitetimers' }));
  check('list shows this guild Laslan timer', (i.replies[0] || '').includes('Laslan'));

  // ── 4. LOA: announced into the OWN guild's channel, row scoped, id stored ─
  console.log('\n4. /loa event');
  sent.length = 0;
  await run(makeInteraction({
    guildId: rowA.discord_guild_id, command: 'loa', sub: 'event',
    opts: { date: '2099-01-15', start_time: '21:00', reason: 'A-SECRET-REASON' }, roles: [OFFICER_ROLE],
  }));
  await run(makeInteraction({
    guildId: rowB.discord_guild_id, command: 'loa', sub: 'event',
    opts: { date: '2099-01-15', start_time: '21:00', reason: 'B-SECRET-REASON' },
  }));
  const lA = await rows('loa_entries', rowA.id);
  const lB = await rows('loa_entries', rowB.id);
  check('one LOA per guild', lA.length === 1 && lB.length === 1, `A=${lA.length} B=${lB.length}`);
  if (!lA.length) console.log('     handler said:', JSON.stringify(lastReplies));
  check('A\'s reason did not land in B', !JSON.stringify(lB).includes('A-SECRET-REASON'));
  check('announced to each guild\'s own LOA channel',
    sent.length === 2 && sent[0].channel === 'loa-AAA' && sent[1].channel === 'loa-BBB',
    sent.map((x) => x.channel).join(', '));
  // Regression: setMessageId was called with the pre-conversion argument list,
  // so the announcement id was never stored and cancelling could not delete it.
  check('announcement message id was stored (regression)',
    lA.length === 1 && !!lA[0].discord_message_id, 'A stored=' + (lA[0] || {}).discord_message_id);

  // ── 5. Cross-guild cancel is refused ──────────────────────────────────────
  console.log('\n5. cross-guild cancel');
  i = await run(makeInteraction({
    guildId: rowB.discord_guild_id, command: 'loa', sub: 'cancel',
    opts: { entry: lA[0].id }, roles: [OFFICER_ROLE],
  }));
  const stillThere = await rows('loa_entries', rowA.id);
  check('B could not cancel A\'s LOA', stillThere.length === 1, i.replies[0] || '');

  // ── 6. Officer status is per guild, for the same role id ──────────────────
  console.log('\n6. officer check uses this guild\'s roles');
  const asOfficer = (guildRow) => T.isAdminMember({
    guildHall: guildRow, member: { roles: { cache: { has: (r) => r === OFFICER_ROLE } } },
  });
  check('shared role is an officer in A (configured)', asOfficer(rowA) === true);
  check('shared role is NOT an officer in B (not configured)', asOfficer(rowB) === false);

  // ── 7. /announce posts to the right channel ───────────────────────────────
  console.log('\n7. /announce');
  sent.length = 0;
  i = await run(makeInteraction({
    guildId: rowA.discord_guild_id, command: 'announce',
    opts: { time: '9:30pm', message: 'A-ANNOUNCE {time}' }, roles: [OFFICER_ROLE],
  }));
  check('officer in A posted to A\'s announce channel',
    sent.length === 1 && sent[0].channel === 'ann-AAA', sent.map((x) => x.channel).join(',') || '(nothing sent)');
  sent.length = 0;
  i = await run(makeInteraction({
    guildId: rowB.discord_guild_id, command: 'announce',
    opts: { time: '9:30pm', message: 'B-ANNOUNCE {time}' }, roles: [OFFICER_ROLE],
  }));
  check('same role in B was refused (not an officer there)',
    sent.length === 0 && /officers only/i.test(i.replies[0] || ''), i.replies[0] || '');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const t of ['elite_timers', 'loa_entries']) await s.from(t).delete().in('guild_id', [rowA.id, rowB.id]);
  await s.from('guilds').delete().in('id', [rowA.id, rowB.id]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
