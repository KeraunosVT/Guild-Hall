// ============================================================================
// The elite timer board and its buttons
// ============================================================================
// Tapping a button OVERWRITES the stored timer and the previous kill time is
// gone, so the branching that decides whether to ask first is the part worth
// holding. The rest — which message each path edits, whether a customId
// survives a location name with a space in it, and whether every read and write
// is scoped to the tapping guild — are the things that break silently in
// Discord rather than throwing.
//
// No database: the data module is stubbed through the gateway's test seam.
// Cross-guild isolation against the real database is covered by
// test/botIsolation.js.
//
// Run:  node test/eliteButtons.js       (from backend/)
const gw = require('../discordGateway');
const { setEliteTimers, eliteBoard, handleEliteButton } = gw.__test;

const LOCATIONS = ['Laslan', 'Stoneguard', 'Talandre', 'Laslan Abyss', 'Stoneguard Abyss', 'Talandre Abyss', 'Nyx'];
const HOUR = 3_600_000;
const GUILD = { id: 'guild-A' };

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + detail);
  ok ? pass++ : fail++;
};

let reported;
let guildsSeen;

// `rows` maps location -> hours until next spawn (negative = window open).
function stubTimers(rows = {}) {
  reported = [];
  guildsSeen = new Set();
  setEliteTimers({
    locations: LOCATIONS,
    all: async (guildId) => {
      guildsSeen.add(guildId);
      return Object.entries(rows).map(([location, hoursUntil]) => ({
        location,
        next_spawn_at: new Date(Date.now() + hoursUntil * HOUR).toISOString(),
      }));
    },
    report: async (guildId, location, killedAt, by) => {
      guildsSeen.add(guildId);
      reported.push({ guildId, location, killedAt, by });
      return { location, killed_at: killedAt.toISOString(), next_spawn_at: new Date(killedAt.getTime() + 4 * HOUR).toISOString() };
    },
  });
}

// Records every Discord call a handler makes, so a test can assert which
// message got edited rather than guessing. guildHall is set the way
// handleInteraction's tenant resolution would have set it.
function fakeInteraction(customId, { messageId = 'BOARD1', boardExists = true } = {}) {
  const calls = [];
  const board = { id: messageId, edit: async (p) => calls.push(['board.edit', p]) };
  return {
    calls,
    customId,
    guildHall: GUILD,
    user: { username: 'ana', globalName: 'Ana' },
    message: { id: messageId },
    channel: { messages: { fetch: async (id) => (boardExists && id === messageId ? board : Promise.reject(new Error('unknown message'))) } },
    update: async (p) => { calls.push(['update', p]); },
    reply: async (p) => { calls.push(['reply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
}

const find = (calls, kind) => (calls.find((c) => c[0] === kind) || [])[1];
const flatButtons = (components) => components.flatMap((row) => row.components.map((b) => b.toJSON()));
const onlyOwnGuild = () => guildsSeen.size === 1 && guildsSeen.has(GUILD.id);

(async () => {
  // ── 1. The board ──────────────────────────────────────────────────────────
  console.log('\n1. the board');
  stubTimers({ Laslan: -1, Stoneguard: 3 });
  let board = await eliteBoard(GUILD.id);
  check('names every tracked location', LOCATIONS.every((loc) => board.content.includes(`**${loc}**`)));
  check('unreported locations say so', board.content.includes('no report yet'));
  check('open window reads as open', /\*\*Laslan\*\* — spawn window open/.test(board.content));
  check('running timer reads as running', /\*\*Stoneguard\*\* — spawns/.test(board.content));

  const buttons = flatButtons(board.components);
  check('at most 5 action rows', board.components.length <= 5, `${board.components.length}`);
  check('at most 5 buttons per row', board.components.every((r) => r.components.length <= 5));
  check('customIds and labels within Discord limits',
    buttons.every((b) => b.custom_id.length <= 100 && b.label.length <= 80));
  const ids = buttons.map((b) => b.custom_id);
  check('every location has a button, plus refresh',
    LOCATIONS.every((loc) => ids.includes(`et:kill:${loc}`)) && ids.includes('et:refresh'));
  // The tap you are most likely to want is green; the one that will ask you to
  // confirm is grey, so the difference is visible BEFORE the click.
  const style = Object.fromEntries(buttons.map((b) => [b.label, b.style]));
  check('a due boss looks different from one on cooldown', style.Laslan !== style.Stoneguard);
  check('never-reported counts as due', style.Laslan === style.Nyx);
  check('board read only this guild', onlyOwnGuild(), [...guildsSeen].join(','));

  // ── 2. Tapping a boss ─────────────────────────────────────────────────────
  console.log('\n2. tapping a boss');
  stubTimers({ Laslan: -1 });
  let i = fakeInteraction('et:kill:Laslan');
  await handleEliteButton(i);
  check('a due boss is reported immediately', reported.length === 1 && reported[0].location === 'Laslan');
  check('killed at roughly now', reported.length && Math.abs(reported[0].killedAt - Date.now()) < 5000);
  check('attributed the way /elitetimer does (username)', reported.length && reported[0].by === 'ana');
  check('written to the tapping guild', reported.length && reported[0].guildId === GUILD.id);
  // The button is on the board, so update() redraws it — no fetch needed.
  check('board redrawn in place', (find(i.calls, 'update') || {}).content?.includes('**Laslan**'));
  check('tapper told what happened', /killed — next spawn/.test((find(i.calls, 'followUp') || {}).content || ''));

  stubTimers({ Stoneguard: 3 });
  i = fakeInteraction('et:kill:Stoneguard');
  await handleEliteButton(i);
  const prompt = find(i.calls, 'reply') || {};
  check('a boss on cooldown writes nothing yet', reported.length === 0);
  check('...and asks first', /isn't due until/.test(prompt.content || ''));
  const confirm = prompt.components ? flatButtons(prompt.components)[0] : {};
  check('confirm carries the board id', confirm.custom_id === 'et:force:BOARD1:Stoneguard', confirm.custom_id);

  // Split on ':' and rejoined — a space is fine, but the rejoin is the part
  // that would silently break if someone switched to a different delimiter.
  stubTimers({ 'Stoneguard Abyss': -1 });
  await handleEliteButton(fakeInteraction('et:kill:Stoneguard Abyss'));
  check('a location with a space survives the customId', (reported[0] || {}).location === 'Stoneguard Abyss');

  stubTimers({});
  i = fakeInteraction('et:kill:Atlantis');
  await handleEliteButton(i);
  check('an unknown location is refused, not reported',
    reported.length === 0 && /isn't a tracked location/.test((find(i.calls, 'reply') || {}).content || ''));

  // ── 3. Confirming an overwrite ────────────────────────────────────────────
  console.log('\n3. confirming an overwrite');
  stubTimers({ Stoneguard: 3 });
  i = fakeInteraction('et:force:BOARD1:Stoneguard');
  await handleEliteButton(i);
  const upd = find(i.calls, 'update') || {};
  check('the timer is written', (reported[0] || {}).location === 'Stoneguard');
  check('prompt replaced with the confirmation', /killed — next spawn/.test(upd.content || ''));
  check('confirm button removed so it cannot be pressed twice', Array.isArray(upd.components) && upd.components.length === 0);
  // The board is a DIFFERENT message here, reached by the carried id.
  check('board redrawn by id', (find(i.calls, 'board.edit') || {}).content?.includes('**Stoneguard**'));
  check('confirm path touched only this guild', onlyOwnGuild(), [...guildsSeen].join(','));

  stubTimers({ Stoneguard: 3 });
  i = fakeInteraction('et:force:GONE:Stoneguard', { boardExists: false });
  await handleEliteButton(i);
  check('a deleted board does not undo a saved report',
    reported.length === 1 && /killed — next spawn/.test((find(i.calls, 'update') || {}).content || ''));

  // ── 4. Refresh ────────────────────────────────────────────────────────────
  console.log('\n4. refresh');
  stubTimers({ Laslan: 2 });
  i = fakeInteraction('et:refresh');
  await handleEliteButton(i);
  check('redraws without writing anything',
    reported.length === 0 && (find(i.calls, 'update') || {}).content?.includes('**Laslan**'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
