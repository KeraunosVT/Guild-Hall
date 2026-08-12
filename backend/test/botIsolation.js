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
// `customId` makes it a BUTTON press instead of a slash command — that's what
// a signup post's "I'm in" arrives as, and it carries no guild of its own
// beyond interaction.guildId, so it has to go through the same tenant
// resolution every command does.
function makeInteraction({ guildId, command, sub, opts = {}, roles = [], user = USER, customId = null }) {
  const replies = [];
  const roleSet = new Set(roles);
  return {
    guildId: String(guildId),
    commandName: command,
    customId,
    user,
    member: { roles: { cache: { has: (r) => roleSet.has(r) } } },
    isAutocomplete: () => false,
    isButton: () => Boolean(customId),
    isChatInputCommand: () => !customId,
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
    for (const t of ['late_attendance_requests', 'events', 'event_signup_entries', 'event_signups', 'elite_timers', 'loa_entries']) await s.from(t).delete().in('guild_id', ids);
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
  // Deliberately counted across EVERY guild, not just A and B: the failure this
  // guards against is a write that lands under some other tenant entirely, and
  // scoping the check to the two fixtures would be blind to exactly that.
  //
  // Compared against a before-count rather than against zero, because this
  // database legitimately holds rows the suite did not write — a seeded demo
  // guild has its own Laslan timer, and asserting zero would report that as a
  // leak the interaction never caused.
  const laslanBefore = ((await s.from('elite_timers').select('guild_id').eq('location', 'Laslan')).data || []).length;
  let i = await run(makeInteraction({ guildId: '600000000000009999', command: 'elitetimer', opts: { location: 'Laslan', time: '10:00' } }));
  check('refused with an explanation', /not registered/i.test(i.replies[0] || ''), i.replies[0] || '(no reply)');
  const orphan = (await s.from('elite_timers').select('*').eq('location', 'Laslan')).data || [];
  check('wrote no elite_timers row anywhere', orphan.length === laslanBefore,
    `${orphan.length} rows, was ${laslanBefore}`);

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

  // ── 8. Signup buttons ─────────────────────────────────────────────────────
  // The riskiest interaction in the project: a button carries nothing but an
  // occurrence uuid in its customId, and that uuid is public to anyone who can
  // read the message. If the id alone were enough to act on, a member of one
  // server could sign themselves into another server's raid by pressing a
  // button copied out of a post they don't belong to.
  console.log('\n8. signup buttons');
  const mkSignup = async (guildRow, mark) => (await s.from('event_signups').insert({
    guild_id: guildRow.id, title: `${mark} Raid`, starts_at: '2099-01-15T21:00:00Z',
    event_date: '2099-01-15', status: 'open',
  }).select('*').single()).data;
  const sgA = await mkSignup(rowA, 'A');
  const sgB = await mkSignup(rowB, 'B');

  i = await run(makeInteraction({ guildId: rowA.discord_guild_id, customId: `signup:join:${sgA.id}` }));
  const eA = await rows('event_signup_entries', rowA.id);
  check('joining from your own server works', eA.length === 1 && eA[0].signup_id === sgA.id,
    `${eA.length} entries · ${i.replies[0] || '(no reply)'}`);

  // Guild A's member presses a button whose id belongs to guild B.
  i = await run(makeInteraction({ guildId: rowA.discord_guild_id, customId: `signup:join:${sgB.id}` }));
  const eB = await rows('event_signup_entries', rowB.id);
  check('B\'s occurrence id is not reachable from A', eB.length === 0,
    `${eB.length} entries in B · ${i.replies[0] || ''}`);

  // And from an unregistered server, where tenant resolution has nothing to
  // resolve — the click must be refused before the id is trusted at all.
  i = await run(makeInteraction({ guildId: '600000000000009999', customId: `signup:join:${sgA.id}` }));
  const stillOne = await rows('event_signup_entries', rowA.id);
  check('unregistered server cannot press A\'s button', stillOne.length === 1,
    `${stillOne.length} entries · ${i.replies[0] || ''}`);

  // Withdrawing returns you to undecided, which means the row is GONE — not
  // flipped to a "declined" state, which the schema refuses to store.
  await run(makeInteraction({ guildId: rowA.discord_guild_id, customId: `signup:leave:${sgA.id}` }));
  const afterLeave = await rows('event_signup_entries', rowA.id);
  check('withdrawing removes the row rather than recording a decline', afterLeave.length === 0,
    `${afterLeave.length} entries`);

  // ── 9 ─────────────────────────────────────────────────────────────────────
  // The ping. Pure shaping, no database — but the two ways to get it wrong are
  // both silent, which is why it is asserted rather than eyeballed:
  //   · a role id listed under `parse` instead of `roles` renders a pill and
  //     notifies nobody, which looks identical to success;
  //   · @everyone put in `roles` does the same, because its id is the guild id
  //     and Discord will not reach it through the roles allow-list.
  console.log('\n9. signup ping targeting');
  const mention = (guildRow, roleId) => T.signupMention(guildRow, { mention_role_id: roleId });

  const plain = mention(rowA, '600000000000000042');
  check('a role ping names the role in the content', plain.content === '<@&600000000000000042>', plain.content);
  check('and is allowed through `roles`, not `parse`',
    JSON.stringify(plain.allowedMentions) === JSON.stringify({ roles: ['600000000000000042'] }),
    JSON.stringify(plain.allowedMentions));

  const everyone = mention(rowA, rowA.discord_guild_id);
  check('@everyone is recognised by its guild-id role', everyone.content === '@everyone', everyone.content);
  check('and goes through `parse`, which is the only way it reaches anyone',
    JSON.stringify(everyone.allowedMentions) === JSON.stringify({ parse: ['everyone'] }),
    JSON.stringify(everyone.allowedMentions));

  check('no ping configured means no content at all', mention(rowA, null) === null);
  // Guild B's id is just another snowflake to guild A — it must not be mistaken
  // for A's @everyone and widened into a server-wide ping.
  check('another tenant\'s guild id is treated as an ordinary role',
    mention(rowA, rowB.discord_guild_id).content === `<@&${rowB.discord_guild_id}>`);

  // ── 10 ────────────────────────────────────────────────────────────────────
  // /attendance-late is the one member-facing attendance command, so the
  // question here is the mirror image of the officer checks above: not "are
  // outsiders kept out" but "can a member in one server reach another server's
  // nights". The command's only input is an event id, and its autocomplete is
  // what supplies them — so both halves are checked.
  console.log('\n10. late attendance across tenants');
  const evA = (await s.from('events').insert({
    guild_id: rowA.id, title: 'Alpha Night', event_date: '2099-01-01', created_at: new Date().toISOString(),
  }).select('*').single()).data;
  const evB = (await s.from('events').insert({
    guild_id: rowB.id, title: 'Beta Night', event_date: '2099-01-01', created_at: new Date().toISOString(),
  }).select('*').single()).data;

  // The autocomplete answers through interaction.respond, which the fake
  // swallows — so it is captured here rather than read out of replies.
  const offered = [];
  const ac = makeInteraction({ guildId: rowA.discord_guild_id, command: 'attendance-late' });
  ac.isAutocomplete = () => true;
  ac.isChatInputCommand = () => false;
  ac.respond = async (choices) => { offered.push(...choices); };
  await gw.__test.handleInteraction(ac);
  const offeredIds = offered.map((c) => String(c.value));
  check('a member in A is offered A\'s night', offeredIds.includes(String(evA.id)), JSON.stringify(offeredIds));
  check('and is not offered B\'s', !offeredIds.includes(String(evB.id)));

  // Naming B's event id explicitly from inside A. The id is a real uuid that
  // really exists — it is simply not this tenant's, which is the only thing
  // standing between a member and another guild's attendance record.
  i = await run(makeInteraction({
    guildId: rowA.discord_guild_id, command: 'attendance-late', opts: { event: evB.id },
  }));
  check('filing against another tenant\'s event is refused',
    /no longer exists|which event/i.test(i.replies[0] || ''), i.replies[0] || '(no reply)');
  check('and wrote nothing into guild B', (await rows('late_attendance_requests', rowB.id)).length === 0);

  // The same call against A's own event must work, or the refusal above would
  // pass for the wrong reason — a command that refuses everything is isolated
  // and useless.
  i = await run(makeInteraction({
    guildId: rowA.discord_guild_id, command: 'attendance-late', opts: { event: evA.id, reason: 'comms dropped' },
  }));
  check('filing against its own event succeeds', /Asked to be added/i.test(i.replies[0] || ''), i.replies[0] || '(no reply)');
  const filedA = await rows('late_attendance_requests', rowA.id);
  check('the request is stamped with guild A', filedA.length === 1, `${filedA.length} rows`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const t of ['late_attendance_requests', 'events', 'event_signup_entries', 'event_signups', 'elite_timers', 'loa_entries']) await s.from(t).delete().in('guild_id', [rowA.id, rowB.id]);
  await s.from('guilds').delete().in('id', [rowA.id, rowB.id]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
