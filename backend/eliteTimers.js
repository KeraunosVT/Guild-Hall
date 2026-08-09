// backend/eliteTimers.js — Elite boss respawn tracking for the /elitetimer command.
// Each of the 4 locations has exactly one timer, keyed by location, overwritten
// whenever a newer kill is reported.
const LOCATIONS = require('../shared/eliteLocations.json');

const { tenantDb } = require('./tenantDb');

// Default timezone only. In multi-tenant mode the real value comes from the
// guilds row (guilds.timezone) and is passed in per call — shared/guild.json is
// the template a new guild is seeded from, not the live config (plan task 9).
// Keeping it as the fallback is what lets a single-tenant self-host that never
// passes a timezone keep behaving exactly as it does today.
// Last-resort default only — the real zone comes from guilds.timezone and is
// passed in per call.
const DEFAULT_TZ = 'America/New_York';

// Offset (ms) that `timeZone`'s wall clock reads relative to UTC at the instant `date`
// (e.g. -4h for America/New_York during EDT). Timezone-independent of the host
// machine's own local time — safe to run on a server in any timezone.
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { if (p.type !== 'literal') parts[p.type] = p.value; });
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

// Resolves an hour/minute (already disambiguated — no am/pm parsing here) to the
// UTC instant that clock time occurs today in the guild's timezone. Shared by
// parseGuildTimeToday below and by the /announce command (backend/discordGateway.js),
// which needs the same DST-aware conversion but without the kill-report rollback rule.
function guildTimeToday(hour, minute, timeZone = DEFAULT_TZ) {
  const now = new Date();
  const [y, mo, d] = now.toLocaleDateString('en-CA', { timeZone }).split('-').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, hour, minute);
  const offset = tzOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

// Parse a clock-time string ("6:40pm", "6:40 PM", "18:40") as happening today in the
// guild's timezone. If the result lands more than an hour in the future, assume the
// kill was actually just before midnight and the report came in after — shift back a day.
function parseGuildTimeToday(input, timeZone = DEFAULT_TZ) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(String(input || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3] ? m[3][0].toLowerCase() : null;
  if (minute < 0 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'p' && hour !== 12) hour += 12;
    if (ampm === 'a' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  const now = new Date();
  let result = guildTimeToday(hour, minute, timeZone);
  if (result.getTime() - now.getTime() > 60 * 60 * 1000) {
    result = new Date(result.getTime() - 24 * 60 * 60 * 1000);
  }
  return result;
}

module.exports = function createEliteTimers(supabase) {
  return {
    locations: Object.keys(LOCATIONS),
    parseGuildTimeToday,

    // Report a kill for a location — overwrites whatever timer was already there
    // FOR THIS GUILD. elite_timers is keyed on (guild_id, location) since Phase
    // 1, so two guilds each keep their own timer for the same boss.
    async report(guildId, location, killedAt, reportedBy) {
      if (!(location in LOCATIONS)) throw new Error('Unknown location.');
      const respawnMs = LOCATIONS[location].respawnHours * 60 * 60 * 1000;
      const nextSpawnAt = new Date(killedAt.getTime() + respawnMs);
      const row = {
        location,
        killed_at: killedAt.toISOString(),
        next_spawn_at: nextSpawnAt.toISOString(),
        reported_by: reportedBy || null,
        pinged: false,
        updated_at: new Date().toISOString(),
      };
      // Composite conflict target — 'location' alone no longer names a
      // constraint, so the upsert would error instead of overwriting.
      const { error } = await tenantDb(supabase, guildId)
        .from('elite_timers').upsert(row, { onConflict: 'guild_id,location' });
      if (error) throw new Error(error.message);
      return row;
    },

    async all(guildId) {
      const { data, error } = await tenantDb(supabase, guildId)
        .from('elite_timers').select('*').order('location');
      if (error) { console.error('eliteTimers.all error:', error.message); return []; }
      return data || [];
    },
  };
};

module.exports.parseGuildTimeToday = parseGuildTimeToday;
module.exports.guildTimeToday = guildTimeToday;
