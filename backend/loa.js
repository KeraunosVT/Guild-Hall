// backend/loa.js — Leave-of-absence entries, shared between the website's
// /api/loa routes and the /loa Discord command so both write through the
// same validation instead of maintaining it twice.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Timezone and rollover come from shared/guild.json — the same per-guild
// config file the branding lives in — so another guild re-theming this app
// isn't silently stuck on US Eastern. Fallbacks keep an older guild.json
// (without these keys) working unchanged.
const GUILD_IDENTITY = require('../shared/guild.json');
const { tenantDb } = require('./tenantDb');

// DEFAULTS ONLY. In multi-tenant mode timezone and day_start come from the
// guilds row and are passed in per call; shared/guild.json is the template a
// new guild is seeded from, not the live config (plan task 9). Keeping these as
// fallbacks is what lets a single-tenant self-host that passes nothing keep
// behaving exactly as it does today.
const DEFAULT_TZ = GUILD_IDENTITY.timezone || 'America/New_York';

// A guild night doesn't end at midnight. The 12:30am Guild Field Boss is the
// tail of the previous evening's block, not the start of a new day — the
// schedule stores it on the calendar day it actually occurs (Sunday 00:30),
// and everything here maps that back to the night it belongs to (Saturday).
//
// Anything before this wall-clock time counts as the night before. It has to
// sit after the guild's latest event (12:30am) and before the earliest of the
// following evening, which leaves the small hours free; 01:00 is the line.
const MINUTES_PER_DAY = 1440;

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

const GUILD_DAY_START = /^\d{2}:\d{2}$/.test(GUILD_IDENTITY.dayStart || '')
  ? GUILD_IDENTITY.dayStart
  : '01:00';
const GUILD_DAY_START_MIN = minutesOf(GUILD_DAY_START);

// Normalizes whatever a caller has to the rollover in minutes. Accepts a guilds
// row ({ day_start }), a bare "HH:MM", or nothing (falls back to the template).
// Every helper below takes this rather than reading a module constant, because
// two guilds on one process can have different guild-night boundaries and a
// shared constant would silently apply one guild's night to the other's events.
function dayStartMinOf(guild) {
  const raw = typeof guild === 'string' ? guild : guild && guild.day_start;
  return /^\d{2}:\d{2}$/.test(raw || '') ? minutesOf(raw) : GUILD_DAY_START_MIN;
}

const tzOf = (guild) => (guild && guild.timezone) || DEFAULT_TZ;

// Where a wall-clock time falls within the guild night, as minutes from its
// start. Times before the rollover are pushed past the previous evening's, so
// 00:30 (1470) correctly compares and sorts later than 21:00 (1260) — plain
// "HH:MM" string comparison gets this exactly backwards.
function daySlot(hhmm, guild) {
  const startMin = dayStartMinOf(guild);
  const mins = minutesOf(hhmm);
  return mins < startMin ? mins + MINUTES_PER_DAY : mins;
}

// The day-of-week a scheduled event belongs to, from the calendar day and time
// it's stored under: a 00:30 event stored on Sunday is part of Saturday night.
function guildDayOfWeek(dow, eventTime, guild) {
  if (!eventTime || minutesOf(eventTime) >= dayStartMinOf(guild)) return dow;
  return (dow + 6) % 7;
}

// True when an event runs after midnight, so its calendar day is one ahead of
// the night it belongs to. Used to label it as such wherever it's listed.
const isAfterMidnight = (eventTime, guild) => Boolean(eventTime) && minutesOf(eventTime) < dayStartMinOf(guild);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

// Parses either a 24-hour "HH:MM" (what the website's <input type="time"> sends)
// or a freeform clock string like "9pm" / "9:00 PM" (what the Discord command
// takes, since slash commands have no time picker). Returns "HH:MM" or null.
function parseTimeOfDay(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const machine = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(s);
  if (machine) return `${machine[1]}:${machine[2]}`;
  const free = /^(\d{1,2})(?::([0-5]\d))?\s*([ap]\.?m\.?)?$/i.exec(s);
  if (!free) return null;
  let hour = parseInt(free[1], 10);
  const minute = free[2] ? parseInt(free[2], 10) : 0;
  const ampm = free[3] ? free[3][0].toLowerCase() : null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'p' && hour !== 12) hour += 12;
    if (ampm === 'a' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Validates and normalizes the optional start/end time pair shared by
// submitEvent and submitRecurring. `end` requires a `start` (an end alone,
// with no defined start, is ambiguous). An end earlier in the clock than the
// start is read as crossing midnight — "out 11pm to 1am" is a normal thing to
// say here, given the night runs past 12:30am — so only an end identical to
// the start is rejected, as that describes no window at all.
function parseTimeWindow(start, end) {
  const cleanStart = start ? parseTimeOfDay(start) : null;
  if (start && !cleanStart) throw httpError(400, 'Start time must be a valid time, e.g. 9:00 PM.');
  const cleanEnd = end ? parseTimeOfDay(end) : null;
  if (end && !cleanEnd) throw httpError(400, 'End time must be a valid time, e.g. 9:00 PM.');
  if (cleanEnd && !cleanStart) throw httpError(400, 'End time needs a start time too.');
  if (cleanEnd && cleanEnd === cleanStart) throw httpError(400, 'End time must be different from the start time.');
  return { cleanStart, cleanEnd };
}

// Does an event at `eventTime` fall inside this entry's absence window? No
// start_time means no restriction at all; a start with no end is an open-ended
// cutoff ("out from this time onward"); both means a bounded window they're
// back after (out 7-8pm, available again at 8). An event with no recorded time
// can't be compared, so it falls back to counting the member absent.
//
// Compared in guild-night slots, never as raw clock strings: "out from 9pm"
// has to cover the 12:30am event that same night, and '00:30' < '21:00' as
// text says the opposite.
function withinLoaWindow(entry, eventTime, guild) {
  if (!entry.start_time || !eventTime) return true;
  const at = daySlot(eventTime, guild);
  const from = daySlot(entry.start_time, guild);
  if (at < from) return false;
  if (!entry.end_time) return true;
  // An end that isn't after the start ran past the rollover ("out 11pm-1am"),
  // so it closes on the next slot round rather than the current one.
  let to = daySlot(entry.end_time, guild);
  if (to <= from) to += MINUTES_PER_DAY;
  return at < to;
}

// "Today" as a YYYY-MM-DD string in the guild's own timezone, not the server's.
// new Date().toISOString() reads the UTC calendar day, which silently rolls
// over to tomorrow from ~7-8pm ET onward — exactly when people are building
// rosters for that night's event — so callers needing "today" must use this
// instead of toISOString().slice(0, 10).
// Rolls over at GUILD_DAY_START rather than midnight, for the same reason it
// doesn't use UTC: at 12:30am an officer snapping attendance or building the
// roster for the event starting right now means last night, not today.
function todayInGuildTz(guild) {
  const shifted = new Date(Date.now() - dayStartMinOf(guild) * 60_000);
  return shifted.toLocaleDateString('en-CA', { timeZone: tzOf(guild) });
}

module.exports = function createLoa(supabase) {
  const isValidDate = (dateStr) => DATE_RE.test(dateStr || '');
  const requireReason = (reason) => {
    const trimmed = (reason || '').trim();
    if (!trimmed) throw httpError(400, 'Reason is required.');
    return trimmed;
  };

  return {
    isValidDate,
    parseTimeOfDay,

    // Events on the recurring schedule for a given guild night (0=Sunday..6=Saturday).
    // Not a plain day_of_week match: an after-midnight event is stored on the
    // calendar day it occurs, so Saturday night's list has to pull the Sunday
    // 00:30 row in and leave Sunday evening's rows out. Filtered in JS because
    // the schedule is a couple of dozen rows and the alternative is an or()
    // spanning two days. Ordered by slot so the small hours come last.
    async eventsForDay(guild, dow) {
      const { data, error } = await tenantDb(supabase, guild.id).from('event_schedule').select('*');
      if (error) { console.error('loa.eventsForDay error:', error.message); return []; }
      return (data || [])
        .filter((e) => guildDayOfWeek(e.day_of_week, e.event_time, guild) === dow)
        .sort((a, b) => (a.event_time ? daySlot(a.event_time, guild) : -1) - (b.event_time ? daySlot(b.event_time, guild) : -1)
          || String(a.name).localeCompare(String(b.name)));
    },

    // Same, but keyed off a calendar date instead of a raw day-of-week number.
    async eventsForDate(guild, dateStr) {
      if (!isValidDate(dateStr)) return [];
      return this.eventsForDay(guild, dayOfWeek(dateStr));
    },

    // Who's out on a date, optionally narrowed to one scheduled event. Lives
    // here, alongside the submit* methods, for the same reason they do: the
    // party builder and the attendance breakdown both ask "is this person out?"
    // and must get the same answer, which means one implementation, not two.
    //
    // `date` is a guild night, not a calendar day — so the night of Saturday
    // the 1st covers the 12:30am event that lands on Sunday the 2nd. Every
    // caller's default comes from todayInGuildTz(), which is already shifted.
    //
    // Each result carries the window and reason as well as the fact of the
    // absence, plus a `partial` flag marking one that could only be matched
    // loosely: a time-scoped entry checked against a known event time was
    // verified to collide, but with no event selected there's no time to
    // compare against, so it's a heads-up rather than a hard block — someone
    // out after 8pm is still available for the 6pm.
    async unavailableOn(guild, { date, eventScheduleId = null }) {
      if (!isValidDate(date)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      const db = tenantDb(supabase, guild.id);
      const dow = dayOfWeek(date);
      const [{ data, error }, eventRow] = await Promise.all([
        db.from('loa_entries').select(
          'discord_id, display_name, type, event_date, event_schedule_id, start_date, end_date, day_of_week, start_time, end_time, reason',
        ),
        eventScheduleId
          ? db.from('event_schedule').select('event_time').eq('id', eventScheduleId).single().then((r) => r.data)
          : Promise.resolve(null),
      ]);
      if (error) {
        console.error('loa.unavailableOn error:', error.message);
        throw httpError(500, 'Failed to load LOAs.');
      }
      const eventTime = eventRow?.event_time || null;
      const inScope = (e) => !e.event_schedule_id || !eventScheduleId || e.event_schedule_id === eventScheduleId;

      const out = new Map();
      (data || []).forEach((e) => {
        let matches = false;
        // Event: a one-off on this date, scoped to one event, a time window, or
        // both. Recurring is the same two knobs, applied every week on its
        // day-of-week instead of to a single date. A range covers whole days
        // and has no time scoping to check.
        if (e.type === 'event' && e.event_date === date) matches = inScope(e) && withinLoaWindow(e, eventTime, guild);
        if (e.type === 'range' && e.start_date <= date && e.end_date >= date) matches = true;
        if (e.type === 'recurring' && e.day_of_week === dow) matches = inScope(e) && withinLoaWindow(e, eventTime, guild);
        if (!matches) return;

        const entry = {
          discord_id: e.discord_id,
          display_name: e.display_name,
          type: e.type,
          start_time: e.start_time || null,
          end_time: e.end_time || null,
          reason: e.reason || null,
          partial: Boolean(e.start_time) && !eventTime,
        };
        // One member can match several entries (a vacation range plus a
        // standing night off, say). Keep whichever constrains them most, so a
        // whole-day absence isn't masked by a time-boxed one read after it.
        const prev = out.get(e.discord_id);
        if (!prev || (prev.partial && !entry.partial)) out.set(e.discord_id, entry);
      });
      return [...out.values()];
    },

    // `eventScheduleId` and `startTime` are each optional, but at least one is
    // required: pick an event to be out for just that one, a start time to be
    // out for everything on the date at or after that time (e.g. "I can make
    // the 6pm AB but nothing after"), or both to narrow to one event only if
    // it's at/after a given time. `endTime` is optional on top of `startTime`
    // and turns the open-ended cutoff into a window ("out from 7 to 8, back
    // after") — mirrors submitRecurring's same three knobs.
    async submitEvent(guild, { discordId, displayName, eventDate, eventScheduleId, startTime, endTime, reason }) {
      const db = tenantDb(supabase, guild.id);
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      const { cleanStart, cleanEnd } = parseTimeWindow(startTime, endTime);
      if (!eventScheduleId && !cleanStart) throw httpError(400, 'Pick an event or a start time.');
      const cleanReason = requireReason(reason);

      let eventName = null;
      if (eventScheduleId) {
        const { data: ev, error: evErr } = await db.from('event_schedule')
          .select('id, name, day_of_week, event_time').eq('id', eventScheduleId).single();
        if (evErr || !ev) throw httpError(400, 'Unknown event.');
        // Against the night it belongs to, not the calendar day it's stored on
        // — otherwise picking Saturday + the 12:30am event is rejected as a
        // mismatch, even though that's exactly Saturday night's last event.
        if (guildDayOfWeek(ev.day_of_week, ev.event_time, guild) !== dayOfWeek(eventDate)) {
          throw httpError(400, "That event isn't scheduled on that date.");
        }
        eventName = ev.name;
      }

      const { data: row, error } = await db.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'event',
        event_date: eventDate,
        event_schedule_id: eventScheduleId || null,
        start_date: null,
        end_date: null,
        start_time: cleanStart,
        end_time: cleanEnd,
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitEvent error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id, eventName };
    },

    async submitRange(guild, { discordId, displayName, startDate, endDate, reason }) {
      if (!isValidDate(startDate) || !isValidDate(endDate)) throw httpError(400, 'Dates must be in YYYY-MM-DD format.');
      if (new Date(endDate) < new Date(startDate)) throw httpError(400, 'End date must be after start date.');
      const cleanReason = requireReason(reason);

      const { data: row, error } = await tenantDb(supabase, guild.id).from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'range',
        event_date: null,
        event_schedule_id: null,
        start_date: startDate,
        end_date: endDate,
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitRange error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id };
    },

    // Recurs every week on `dayOfWeek` (0=Sunday..6=Saturday) until cancelled.
    // `eventScheduleId` is optional: set it to cover only that one recurring
    // event (e.g. "always out for Tuesday Wargame"), or leave it null to cover
    // the whole day regardless of what's scheduled. `startTime` is also optional:
    // set it to mean "absent from this time onward" rather than the whole day —
    // /loa/unavailable compares it against each event's own scheduled time.
    // `endTime` narrows that further into a window ("out 7-8, back after").
    async submitRecurring(guild, { discordId, displayName, dayOfWeek: dow, eventScheduleId, startTime, endTime, reason }) {
      const db = tenantDb(supabase, guild.id);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw httpError(400, 'Day of week must be between 0 and 6.');
      const cleanReason = requireReason(reason);
      const { cleanStart, cleanEnd } = parseTimeWindow(startTime, endTime);
      let eventName = null;
      if (eventScheduleId) {
        const { data: ev, error: evErr } = await db.from('event_schedule')
          .select('id, name, day_of_week, event_time').eq('id', eventScheduleId).single();
        if (evErr || !ev) throw httpError(400, 'Unknown event.');
        // The night it belongs to, as in submitEvent above.
        if (guildDayOfWeek(ev.day_of_week, ev.event_time, guild) !== dow) {
          throw httpError(400, "That event isn't scheduled on that day.");
        }
        eventName = ev.name;
      }

      const { data: row, error } = await db.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'recurring',
        event_date: null,
        event_schedule_id: eventScheduleId || null,
        start_date: null,
        end_date: null,
        day_of_week: dow,
        start_time: cleanStart,
        end_time: cleanEnd,
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitRecurring error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id, eventName };
    },

    // Best-effort — called after announceLoa() posts to Discord, to remember
    // which message to clean up if this entry is later cancelled. Not throwing
    // on failure here is deliberate: the LOA itself already succeeded by the
    // time this runs, and losing the message link just means cancel won't be
    // able to delete the announcement, not that anything is inconsistent.
    async setMessageId(guild, id, messageId) {
      const { error } = await tenantDb(supabase, guild.id)
        .from('loa_entries').update({ discord_message_id: messageId }).eq('id', id);
      if (error) console.error('loa.setMessageId error:', error.message);
    },

    async mine(guild, discordId) {
      const { data, error } = await tenantDb(supabase, guild.id).from('loa_entries').select('*')
        .eq('discord_id', discordId).order('created_at', { ascending: false });
      if (error) throw httpError(500, 'Failed to load LOAs.');
      return data || [];
    },

    async all(guild, isAdmin) {
      const { data, error } = await tenantDb(supabase, guild.id)
        .from('loa_entries').select('*').order('created_at', { ascending: false });
      if (error) throw httpError(500, 'Failed to load LOAs.');
      return (data || []).map((e) => {
        const out = { ...e };
        if (!isAdmin) delete out.reason;
        return out;
      });
    },

    async cancel(guild, id, discordId, isAdmin) {
      const db = tenantDb(supabase, guild.id);
      // Scoped read AND scoped delete: without the guild filter, an officer of
      // one guild could cancel another guild's LOA by id, and the ownership
      // check below would pass for whoever's discord_id happened to match.
      const { data: entry } = await db.from('loa_entries').select('discord_id, discord_message_id').eq('id', id).single();
      if (!entry) throw httpError(404, 'LOA not found.');
      if (entry.discord_id !== discordId && !isAdmin) throw httpError(403, 'You can only cancel your own LOA.');
      const { error } = await db.from('loa_entries').delete().eq('id', id);
      if (error) throw httpError(500, 'Failed to cancel LOA.');
      return { messageId: entry.discord_message_id || null };
    },
  };
};

module.exports.todayInGuildTz = todayInGuildTz;
module.exports.parseTimeOfDay = parseTimeOfDay;
module.exports.daySlot = daySlot;
module.exports.guildDayOfWeek = guildDayOfWeek;
module.exports.isAfterMidnight = isAfterMidnight;
module.exports.GUILD_DAY_START = GUILD_DAY_START;
