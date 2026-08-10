#!/usr/bin/env node
// ============================================================================
// Onboard a guild — create a tenant row from Discord ids.
// ============================================================================
// Usage:
//   node scripts/onboardGuild.js --config path/to/guild.json
//   node scripts/onboardGuild.js --house "House" --tag TAG --server 123 ...
//   ... --dry-run     print what would be written, change nothing
//
// WHY THIS VALIDATES INSTEAD OF JUST INSERTING
// Per-guild config resolves row-first, then falls back to the DISCORD_* env
// vars. That fallback exists so the original single-guild deployment kept
// working mid-conversion, and for a NEW tenant it is a trap:
//
//   admin_role_ids  = []  ->  the env deployment's officers become officers here
//   loa_channel_id  = ''  ->  this guild's LOA posts go to the env guild's channel
//
// Neither errors. Both are silent cross-tenant bleed. So every field the
// fallback covers is REQUIRED here, and a blank one stops the insert.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes('--' + name);

let input = {};
const configPath = flag('config');
if (configPath) input = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

const guild = {
  discord_guild_id: String(flag('server') || input.discord_guild_id || '').trim(),
  house: (flag('house') || input.house || '').trim(),
  tag: (flag('tag') || input.tag || '').trim(),
  aliases: asList(flag('aliases') || input.aliases),
  timezone: (flag('timezone') || input.timezone || 'America/New_York').trim(),
  day_start: (flag('day-start') || input.day_start || '01:00').trim(),
  admin_role_ids: asList(flag('officer-roles') || input.admin_role_ids),
  allowed_role_ids: asList(flag('member-roles') || input.allowed_role_ids),
  member_role_ids: asList(flag('member-roles') || input.member_role_ids),
  roster_channel_id: String(flag('roster-channel') || input.roster_channel_id || '').trim(),
  loa_channel_id: String(flag('loa-channel') || input.loa_channel_id || '').trim(),
  announce_channel_id: String(flag('announce-channel') || input.announce_channel_id || '').trim(),
  // Optional, unlike the three above: blank means signup posts go to the
  // announce channel, which is where a guild already talks about events. It is
  // only worth setting when signups deserve a room of their own.
  signup_channel_id: String(flag('signup-channel') || input.signup_channel_id || '').trim() || null,
  status: 'active',
};

// ── validation ──────────────────────────────────────────────────────────────
const problems = [];
const snowflake = /^\d{17,20}$/;

if (!snowflake.test(guild.discord_guild_id)) problems.push('server: not a Discord id (17-20 digits)');
if (!guild.house) problems.push('house: required');
if (!guild.tag) problems.push('tag: required');
if (!guild.aliases.length) problems.push('aliases: required — the in-game tag EXACTLY as it appears on match scoreboards, or war records resolve to nobody');
if (!/^\d{2}:\d{2}$/.test(guild.day_start)) problems.push('day-start: must be HH:MM');
try { new Intl.DateTimeFormat('en-US', { timeZone: guild.timezone }); }
catch { problems.push(`timezone: "${guild.timezone}" is not an IANA zone`); }

// The fields the env fallback covers. Blank here means another tenant's config
// silently applies, so these are hard failures rather than warnings.
for (const [field, why] of [
  ['admin_role_ids', 'blank means the deployment env\'s officer roles apply to this guild'],
  ['allowed_role_ids', 'blank means the deployment env\'s allow-list applies to this guild'],
  ['roster_channel_id', 'blank means rosters post into the deployment env\'s channel'],
  ['loa_channel_id', 'blank means LOA posts go to the deployment env\'s channel'],
  ['announce_channel_id', 'blank means announcements go to the deployment env\'s channel'],
]) {
  const v = guild[field];
  const empty = Array.isArray(v) ? !v.length : !v;
  if (empty) problems.push(`${field}: required — ${why}`);
}
for (const f of ['admin_role_ids', 'allowed_role_ids', 'member_role_ids']) {
  const bad = guild[f].filter((id) => !snowflake.test(id));
  if (bad.length) problems.push(`${f}: not Discord ids — ${bad.join(', ')}`);
}
for (const f of ['roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'signup_channel_id']) {
  if (guild[f] && !snowflake.test(guild[f])) problems.push(`${f}: not a Discord id — ${guild[f]}`);
}

if (problems.length) {
  console.error('Cannot onboard:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}

// Not fatal, but almost always a copy-paste slip worth seeing.
const notes = [];
if (guild.roster_channel_id === guild.announce_channel_id) {
  notes.push('roster and announce channels are the same — rosters and @-pings land in one place');
}
if (guild.loa_channel_id === guild.roster_channel_id) notes.push('LOA and roster channels are the same');

// ── write ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('Tenant to create:');
  for (const [k, v] of Object.entries(guild)) console.log('  ' + k.padEnd(20) + JSON.stringify(v));
  if (notes.length) console.log('\nNotes:\n' + notes.map((n) => '  ! ' + n).join('\n'));

  if (has('dry-run')) { console.log('\n--dry-run: nothing written.'); return; }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: existing } = await supabase.from('guilds')
    .select('id, house').eq('discord_guild_id', guild.discord_guild_id).maybeSingle();
  if (existing) {
    console.error(`\nThat Discord server is already registered as "${existing.house}" (${existing.id}).`);
    process.exit(1);
  }

  const { data, error } = await supabase.from('guilds').insert(guild).select('*').single();
  if (error) { console.error('\nInsert failed:', error.message); process.exit(1); }

  console.log(`\nCreated. guild_id = ${data.id}`);
  console.log('The registry caches the Discord-id mapping for 60s, so slash commands');
  console.log('may report "not registered" for up to a minute. No restart needed.');
})();
