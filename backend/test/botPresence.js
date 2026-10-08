// ============================================================================
// Bot presence — noticing when a guild's server removes the bot
// ============================================================================
// Against the test database (needs saas_016), through the gateway's test seam,
// with no Discord connection. What it holds:
//   · a removal is recorded and staff are told — once, not on every repeat;
//   · a server that isn't a Guild Hall guild is ignored;
//   · adding the bot back clears it;
//   · the on-connect reconcile catches changes made while the bot was offline,
//     and touches only guilds whose state actually changed.
//
// Run:  node test/botPresence.js       (from backend/)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + detail);
  ok ? pass++ : fail++;
};

const DB_URL = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!DB_URL || !KEY || DB_URL === process.env.SUPABASE_URL) {
  console.error('botPresence: needs TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY pointing at a scratch project (not SUPABASE_URL).');
  process.exit(1);
}
const db = createClient(DB_URL, KEY);

// The gateway must never connect from a test.
process.env.DISCORD_BOT_TOKEN = '';
const gateway = require('../discordGateway');
const { markBotPresence, reconcileBotPresence } = gateway.__test;

const X = '730000000000001001';
const Y = '730000000000001002';
const NOT_OURS = '730000000000009999';

async function purge() { await db.from('guilds').delete().in('discord_guild_id', [X, Y]); }
const removedAt = async (sid) => (await db.from('guilds').select('bot_removed_at').eq('discord_guild_id', sid).single()).data.bot_removed_at;

(async () => {
  await purge();
  const { error } = await db.from('guilds').insert([
    { discord_guild_id: X, house: 'House Presence', tag: 'PRS', aliases: ['PRS'], status: 'active' },
    { discord_guild_id: Y, house: 'House Steady', tag: 'STD', aliases: ['STD'], status: 'active' },
  ]);
  if (error) { console.error('fixture:', error.message); process.exit(1); }

  // A fake client: the bot can see every server except those listed as gone.
  const gone = new Set();
  gateway.__test.wire(db, { guilds: { cache: { has: (id) => !gone.has(String(id)) } } });
  const told = [];
  gateway.setPresenceListener((e) => { told.push(e); });

  try {
    console.log('\n1. the bot is removed');
    check('a removal is recorded', await markBotPresence(X, false));
    check('with when', !!(await removedAt(X)));
    check('and staff are told, naming the guild', told.length === 1 && told[0].present === false && told[0].house === 'House Presence');
    check('a repeat event changes nothing', !(await markBotPresence(X, false)));
    check('and is not reported twice', told.length === 1);
    check("a server that isn't a Guild Hall guild is ignored", !(await markBotPresence(NOT_OURS, false)));
    check('the other guild is untouched', !(await removedAt(Y)));

    console.log('\n2. the bot is added back');
    check('re-adding clears it', await markBotPresence(X, true));
    check('the timestamp is gone', !(await removedAt(X)));
    check('and staff are told it is back', told.length === 2 && told[1].present === true);
    check('adding when already present changes nothing', !(await markBotPresence(X, true)));

    console.log('\n3. catching up after the bot was offline');
    told.length = 0;
    gone.add(X);
    let r = await reconcileBotPresence();
    check('a server that removed the bot meanwhile is found', r.removed === 1 && !!(await removedAt(X)), JSON.stringify(r));
    check('guilds that still have the bot are left alone', !(await removedAt(Y)));
    r = await reconcileBotPresence();
    check('a second pass finds nothing new', r.removed === 0 && r.restored === 0);
    gone.delete(X);
    r = await reconcileBotPresence();
    check('a server that re-added it meanwhile is restored', r.restored === 1 && !(await removedAt(X)));
    check('each change reported exactly once', told.length === 2, `${told.length}`);
  } catch (err) {
    console.error('\nbotPresence test crashed:', err.stack || err.message);
    fail++;
  } finally {
    await purge();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
