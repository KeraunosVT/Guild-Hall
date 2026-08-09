// Timezone and guild-night rollover, delivered at runtime by GET /api/guild.
//
// These used to be compiled in from shared/guild.json. On a deployment serving
// one guild that was fine; serving many it is not, because the bundle is shared
// and whichever guild was built in would define the rollover for everyone —
// two guilds with different day_start values disagreeing, silently, about which
// night an 00:30 event belongs to.
//
// So the values are module state configured once at boot by configureGuildTime()
// and again on a guild switch. Every function below reads them live rather than
// closing over them, which is what makes reconfiguration take effect.
//
// The defaults exist only to keep these functions total if something calls them
// before configuration; GuildProvider blocks rendering until the real values
// have landed, so nothing user-facing should ever see them.
let guildTz = 'America/New_York';
let dayStart = '01:00';

export function configureGuildTime({ timezone, dayStart: start } = {}) {
  if (timezone) guildTz = timezone;
  if (/^\d{2}:\d{2}$/.test(start || '')) dayStart = start;
}

// Accessors, not constants. `export const GUILD_TZ = guildTz` would freeze the
// first guild's value into the bundle at import time — the exact bug this
// replaces — so nothing here is ever captured, only read through a call.
export const guildTimezone = () => guildTz;

// Mirror of the guild-night model in backend/loa.js — keep the two in step.
// A guild night doesn't end at midnight: the 12:30am Guild Field Boss is the
// tail of the previous evening's block, not the start of a new day. The
// schedule stores each event on the calendar day it actually occurs (Sunday
// 00:30), and these map it back to the night it belongs to (Saturday).
const MINUTES_PER_DAY = 1440;

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

export const guildDayStart = () => dayStart;
const dayStartMin = () => minutesOf(dayStart);

// Where a wall-clock time falls within the guild night, as minutes from its
// start — so 00:30 (1470) sorts after 21:00 (1260) instead of before it, which
// is what comparing "HH:MM" as text would give you.
export function daySlot(hhmm) {
  const mins = minutesOf(hhmm);
  return mins < dayStartMin() ? mins + MINUTES_PER_DAY : mins;
}

// The day-of-week a scheduled event belongs to, from the calendar day and time
// it's stored under: a 00:30 event stored on Sunday is part of Saturday night.
export function guildDayOfWeek(dow, eventTime) {
  if (!eventTime || minutesOf(eventTime) >= dayStartMin()) return dow;
  return (dow + 6) % 7;
}

// True when an event runs after midnight, so its calendar day is a day ahead
// of the night it belongs to — worth labelling wherever it's listed.
export const isAfterMidnight = (eventTime) => Boolean(eventTime) && minutesOf(eventTime) < dayStartMin();

// Events for one guild night, newest-last. Not a plain day_of_week filter:
// Saturday night's list has to pull in the Sunday 00:30 row and leave Sunday
// evening's rows out.
export function eventsForGuildDay(schedule, dow) {
  return (schedule || [])
    .filter((s) => guildDayOfWeek(s.day_of_week, s.event_time) === dow)
    .sort((a, b) => (a.event_time ? daySlot(a.event_time) : -1) - (b.event_time ? daySlot(b.event_time) : -1)
      || String(a.name).localeCompare(String(b.name)));
}

// "Today" as YYYY-MM-DD in the guild's own timezone, not the browser's. Plain
// new Date().toISOString().slice(0, 10) reads the UTC calendar day, which
// rolls over to tomorrow from ~7-8pm ET onward — right when officers are
// building rosters for that night's event — so date defaults/comparisons
// against LOA entries need this instead. Rolls at GUILD_DAY_START rather than
// midnight for the same reason: at 12:30am the night in progress is still
// last night's.
export function todayInGuildTz() {
  const shifted = new Date(Date.now() - dayStartMin() * 60_000);
  return shifted.toLocaleDateString('en-CA', { timeZone: guildTz });
}

export function fmtTimeEst(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm} ET`;
}

// Per-member display preference for how full timestamps (created_at,
// awarded_at, etc.) are shown — defaults to guild time until a member
// explicitly picks something else in Settings. Bare recurring times
// (fmtTimeEst above — event schedules, LOA windows) are NOT affected by this
// and stay in ET regardless: they have no attached date, so there's no safe
// way to resolve DST when converting them to an arbitrary zone.
const DISPLAY_TZ_KEY = 'displayTimezone';

export function getDisplayTimezone() {
  return localStorage.getItem(DISPLAY_TZ_KEY) || guildTz;
}

export function setDisplayTimezone(tz) {
  localStorage.setItem(DISPLAY_TZ_KEY, tz);
}

// Curated list for the Settings picker — not every IANA zone, just enough to
// cover where members are likely to be.
export const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central Europe (CET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AET)' },
];

export function fmtDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const tz = getDisplayTimezone();
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: tz,
  }) + (zoneName ? ` ${zoneName}` : '');
}
