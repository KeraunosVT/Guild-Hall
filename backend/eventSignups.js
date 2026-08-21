// backend/eventSignups.js — opt-in attendance signups for a dated occurrence of
// a scheduled event. Shared by the website's /api/signups routes and the
// Discord buttons, so both write through the same validation and the same
// concurrency rules instead of maintaining two copies (same pattern as loa.js
// and attendance.js).
//
// ── WHAT A ROW MEANS ────────────────────────────────────────────────────────
// "I am coming." That is the entire vocabulary. There is no row for "I'm not",
// and the database refuses to store one — see the check constraint in
// migrations/saas_002_event_signups.sql. Declaring absence stays the LOA
// system's job, which already models the three shapes an absence takes and is
// what officers already read. Two records that can disagree about the same
// member on the same night is a worse problem than one record with a gap in it.
//
// So there are exactly three states a member can be in for an occurrence:
//   entry with status 'going'    — coming, holds a slot
//   entry with status 'waitlist' — coming, queued behind the cap
//   no entry                     — UNDECIDED, not declined
// and the only thing that can distinguish "undecided" from "not coming" is an
// LOA on file. Every surface in this feature reads it that way, most visibly
// the reminder sweep, which DMs precisely the people with neither.
//
// ── WHY THE WRITES GO THROUGH RPCs ──────────────────────────────────────────
// join / withdraw / capacity are Postgres functions that take `select … for
// update` on the parent event_signups row. Two members clicking the last slot
// at the same instant both read "5 of 6 taken" from application code and both
// insert; the lock is what makes one of them wait and see 6. The lock is on one
// occurrence, not the table, so a busy night's several open signups don't queue
// behind one another.
const crypto = require('crypto');
const { tenantDb } = require('./tenantDb');
const { guildTimeOn } = require('./eliteTimers');
const { listMembers } = require('./discord');
const createLoa = require('./loa');

const { guildDayOfWeek, isAfterMidnight, todayInGuildTz } = createLoa;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SNOWFLAKE = /^\d{17,20}$/;

// What an auto-opened occurrence records as its creator, in created_by and in
// the audit line. A name rather than a blank, because "who opened this?" is
// asked most often about the one nobody remembers opening.
const AUTO_ACTOR = 'Recurring schedule';

// How far ahead a MEMBER may bring an occurrence into existence by signing up
// for it (openForSchedule). Deliberately the same ceiling the recurring sweep
// is capped at — signup_open_days_ahead is constrained to 1..30 in
// saas_005_recurring_signups.sql — because it answers the same question: how
// far out is a list still the list people remember answering? Officers have no
// such limit; they are opening a night on purpose.
const MEMBER_OPEN_HORIZON_DAYS = 30;

// Calendar arithmetic on a YYYY-MM-DD string, done in UTC so a server in any
// timezone lands on the same day. The result is a guild-NIGHT date, which is a
// label rather than an instant — turning it into one is startsAtFor's job.
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Which role the announcement pings, resolved ONCE at create time and then
// stored on the occurrence.
//
// The three states are deliberately distinct, and the difference between two of
// them is the whole reason this isn't a one-liner:
//   undefined  — the caller said nothing, so the guild's default applies
//   null / ''  — the caller explicitly said "ping nobody" for this one
//   a snowflake— that role
// Collapsing the first two would make "no ping" impossible to express for any
// guild that has a default set, which is the more common of the two requests.
//
// Not checked against the guild's live role list: the @everyone role's id is
// the Discord guild id and never appears in that list, Discord can be down when
// an officer opens a raid call, and the failure mode of a wrong id is a mention
// that renders dead — visible, and harmless.
function resolveMentionRole(guild, supplied) {
  if (supplied === undefined) return guild.signup_mention_role_id || null;
  const id = String(supplied ?? '').trim();
  if (!id) return null;
  if (!SNOWFLAKE.test(id)) throw httpError(400, `Not a Discord role id — ${id}`);
  return id;
}

// Roles come from member_roles, never from the member at signup time. Two
// reasons: it is one fewer question in a Discord flow that should be a single
// click, and it keeps the composition numbers on this page identical to the
// pools the party builder seeds from — a signup that said "Healer" while the
// builder had them as DPS would make the two screens argue.
//
// PvP is the primary role for signups (raids and sieges are what people sign up
// for); the PvE role is the fallback so a PvE-only member still counts as
// something rather than dropping into the unknown bucket.
const ROLES = ['Tank', 'DPS', 'Healer'];
const roleOf = (row) => {
  const pvp = row && row.pvp_role;
  const pve = row && row.pve_role;
  if (ROLES.includes(pvp)) return pvp;
  if (ROLES.includes(pve)) return pve;
  return null;
};

// Tank / DPS / Healer counts plus, separately, how many have no role on file.
// The last number is the one worth surfacing: those are the people who would
// silently vanish from a party seed, and a composition line that folded them
// into "DPS" would hide exactly the problem an officer needs to see.
function composeCounts(entries, roleById) {
  const out = { Tank: 0, DPS: 0, Healer: 0, unknown: 0, total: 0 };
  entries.forEach((e) => {
    if (e.status !== 'going') return;
    out.total += 1;
    const role = roleById.get(String(e.discord_id)) || null;
    if (role) out[role] += 1;
    else out.unknown += 1;
  });
  return out;
}

// `identities` is optional, exactly as in loa.js: it only ever improves the
// name shown and must never be able to sink a signup.
module.exports = function createEventSignups(supabase, identities = null) {
  const dbFor = (guild) => tenantDb(supabase, guild.id);
  // Built here rather than passed in: "is this member out that night?" has to
  // be answered by the same code the party builder and the attendance
  // breakdown use, or the reminder sweep would chase people the LOA board
  // already shows as away. One implementation, reached three ways.
  const loa = createLoa(supabase, identities);

  // Names are re-resolved on READ, not trusted from the stored snapshot: the
  // display_name on an entry is only what the member was called the moment they
  // clicked, so an alias changed afterwards would keep showing the old name on
  // the Discord embed, the web list and the party badges all at once.
  async function withNames(guild, rows) {
    if (!identities || !rows || !rows.length) return rows || [];
    try {
      const ids = await identities.load(guild.id);
      return rows.map((r) => ({ ...r, display_name: ids.displayNameFor(r.discord_id, r.display_name) }));
    } catch (err) {
      console.warn('signups: identity lookup failed, showing stored names:', err.message);
      return rows;
    }
  }

  async function resolveDisplayName(guild, discordId, fallback) {
    if (!identities || !discordId) return fallback;
    try {
      const ids = await identities.load(guild.id);
      return ids.displayNameFor(discordId, fallback) || fallback;
    } catch (err) {
      console.warn('signups: identity lookup failed, using the supplied name:', err.message);
      return fallback;
    }
  }

  // The occurrence for one (recurring event, night) pair, or null. Keyed on the
  // same two columns as the partial unique index in saas_002, so "is this night
  // already open?" is answered by the thing that enforces it rather than by a
  // second rule that could disagree with it.
  async function findOccurrence(db, eventScheduleId, eventDate) {
    const { data, error } = await db.from('event_signups')
      .select('id').eq('event_schedule_id', eventScheduleId).eq('event_date', eventDate).maybeSingle();
    if (error) {
      console.error('signups.findOccurrence error:', error.message);
      throw httpError(500, 'Failed to load signups.');
    }
    return data || null;
  }

  // discord_id -> 'Tank' | 'DPS' | 'Healer', for whoever has one on file.
  async function rolesFor(guild) {
    const { data, error } = await dbFor(guild).from('member_roles').select('discord_id, pvp_role, pve_role');
    if (error) { console.error('signups.rolesFor error:', error.message); return new Map(); }
    const map = new Map();
    (data || []).forEach((r) => {
      const role = roleOf(r);
      if (role) map.set(String(r.discord_id), role);
    });
    return map;
  }

  // Every signup write lands in the audit log tagged "Attendance", whichever
  // surface it came from. The admin router's audit middleware only covers
  // /api/admin, and a Discord button is not an HTTP request at all — so the
  // record is written here, at the one point all three paths pass through, and
  // reads the same feature label the attendance routes already use.
  //
  // Best-effort by construction: a failed audit insert is logged and swallowed.
  // Losing an audit line is a nuisance; an unhandled rejection in this process
  // takes the whole server down with it.
  async function audit(guild, actor, action, body) {
    try {
      const { error } = await dbFor(guild).from('audit_log').insert({
        actor_id: actor?.id || null,
        actor_name: actor?.name || null,
        action,
        method: 'POST',
        path: '/signups',
        feature: 'Attendance',
        body: body || {},
        status_code: 200,
      });
      if (error) console.error('signups audit insert failed:', error.message);
    } catch (err) {
      console.error('signups audit insert skipped:', err.message);
    }
  }

  // The UTC instant an occurrence begins, from the guild night it belongs to
  // plus a wall-clock time. An after-midnight event is stored on the schedule
  // under the NEXT calendar day (Sunday 00:30 is Saturday night's last event),
  // so the date has to be advanced by one before it becomes a real instant —
  // otherwise Saturday's 12:30am field boss resolves to a moment 24 hours
  // before it happens, and both the auto-close and the reminder fire against
  // an event that hasn't occurred.
  function startsAtFor(guild, eventDate, time) {
    const [y, m, d] = eventDate.split('-').map(Number);
    const calendarDate = isAfterMidnight(time, guild)
      ? new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
      : eventDate;
    const [hh, mm] = time.split(':').map(Number);
    return guildTimeOn(calendarDate, hh, mm, guild.timezone);
  }

  return {
    ROLES,
    composeCounts,

    // ── READS ───────────────────────────────────────────────────────────────

    // One occurrence with its attendee list, composition, and (for officers)
    // the two things only they should see: who has an LOA on file despite
    // signing up, and the undecided split into "on LOA" vs "no response".
    async detail(guild, id, { viewerId = null, officer = false } = {}) {
      const db = dbFor(guild);
      const { data: signup, error } = await db.from('event_signups').select('*').eq('id', id).maybeSingle();
      if (error) { console.error('signups.detail error:', error.message); throw httpError(500, 'Failed to load the signup.'); }
      if (!signup) throw httpError(404, 'Signup not found.');
      return this.hydrate(guild, signup, { viewerId, officer });
    },

    // Turn a bare signup row into everything a surface needs to render it. Split
    // out from detail() because the list endpoint, the Discord embed and the
    // party-builder feed all need the same shape, and computing it three ways is
    // how three screens end up disagreeing about who is coming.
    async hydrate(guild, signup, { viewerId = null, officer = false } = {}) {
      const db = dbFor(guild);
      const [{ data: rawEntries, error }, roleById] = await Promise.all([
        db.from('event_signup_entries')
          .select('id, discord_id, display_name, status, seq, joined_at, added_by')
          .eq('signup_id', signup.id).order('seq'),
        rolesFor(guild),
      ]);
      if (error) { console.error('signups.hydrate error:', error.message); throw httpError(500, 'Failed to load signups.'); }

      const entries = (await withNames(guild, rawEntries || [])).map((e) => ({
        ...e,
        role: roleById.get(String(e.discord_id)) || null,
      }));
      const going = entries.filter((e) => e.status === 'going');
      const waitlist = entries.filter((e) => e.status === 'waitlist');
      // Position is derived from the already-ordered waitlist rather than
      // re-queried per member: the rows came back ordered by `seq`, which is
      // the same FIFO the promotion functions use, so the number shown is the
      // number that will actually be honoured.
      waitlist.forEach((e, i) => { e.position = i + 1; });

      const mine = viewerId ? entries.find((e) => String(e.discord_id) === String(viewerId)) || null : null;

      const out = {
        ...signup,
        entries: [...going, ...waitlist],
        going,
        waitlist,
        counts: { going: going.length, waitlist: waitlist.length },
        composition: composeCounts(entries, roleById),
        mine: mine ? { status: mine.status, position: mine.position || 0 } : null,
      };

      if (officer) Object.assign(out, await this.officerView(guild, signup, entries));
      return out;
    },

    // The officer-only half: who hasn't answered, split by whether an LOA
    // explains it, and anyone who signed up while also having an LOA on file.
    //
    // The conflict list is SURFACED, never resolved. Both records are real
    // statements the member made, and the sensible readings differ ("I filed
    // for the 6pm but I'm here for the 9pm", "I forgot to cancel my LOA") — an
    // officer picking between them is the correct outcome, silently deleting
    // one is not.
    async officerView(guild, signup, entries) {
      let roster = [];
      let unavailable = [];
      try {
        [roster, unavailable] = await Promise.all([
          listMembers(guild),
          loa.unavailableOn(guild, { date: signup.event_date, eventScheduleId: signup.event_schedule_id || null }),
        ]);
      } catch (err) {
        // Needs Discord for the member list. Not worth failing the attendee
        // list over — the caller renders what it has and omits this section.
        console.warn('signups officer view unavailable:', err.message);
        return { unknown: null, conflicts: null };
      }

      const signedUp = new Set(entries.map((e) => String(e.discord_id)));
      const excusedBy = new Map(unavailable.map((u) => [String(u.discord_id), u]));

      const missing = roster
        .filter((m) => !signedUp.has(String(m.id)))
        .map((m) => ({ discord_id: m.id, display_name: m.name, loa: excusedBy.get(String(m.id)) || null }))
        .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

      return {
        unknown: {
          onLoa: missing.filter((m) => m.loa),
          noResponse: missing.filter((m) => !m.loa),
        },
        conflicts: entries
          .filter((e) => excusedBy.has(String(e.discord_id)))
          .map((e) => ({
            discord_id: e.discord_id,
            display_name: e.display_name,
            status: e.status,
            loa: excusedBy.get(String(e.discord_id)),
          })),
      };
    },

    // Upcoming occurrences (and, for the officer view, recently finished ones so
    // a just-closed signup doesn't vanish off the page mid-conversation).
    async list(guild, { viewerId = null, officer = false, pastHours = 12 } = {}) {
      const since = new Date(Date.now() - pastHours * 3600_000).toISOString();
      const { data, error } = await dbFor(guild).from('event_signups')
        .select('*').gte('starts_at', since).order('starts_at');
      if (error) { console.error('signups.list error:', error.message); throw httpError(500, 'Failed to load signups.'); }
      // Hydrated in parallel: each is a couple of small indexed reads, and the
      // page shows composition counts per row, so a lazy shape would just move
      // the same queries to N follow-up requests.
      return Promise.all((data || []).map((s) => this.hydrate(guild, s, { viewerId, officer })));
    },

    // Every occurrence this member is in, upcoming first. Powers the "Mine" tab
    // without pulling the whole guild's attendee lists down with it.
    async mine(guild, discordId) {
      const db = dbFor(guild);
      const { data: rows, error } = await db.from('event_signup_entries')
        .select('signup_id, status, seq').eq('discord_id', String(discordId));
      if (error) { console.error('signups.mine error:', error.message); throw httpError(500, 'Failed to load your signups.'); }
      const ids = (rows || []).map((r) => r.signup_id);
      if (!ids.length) return [];
      const { data: signups, error: sErr } = await db.from('event_signups')
        .select('*').in('id', ids).order('starts_at');
      if (sErr) { console.error('signups.mine error:', sErr.message); throw httpError(500, 'Failed to load your signups.'); }
      return Promise.all((signups || []).map((s) => this.hydrate(guild, s, { viewerId: discordId })));
    },

    // The party builder's read-only feed: who is coming to the occasion the
    // board is currently set to. Matched on the same (date, event) pair the LOA
    // feed uses, so the two line up on the same night by construction.
    //
    // With no event picked, "all events that night" has no single answer — the
    // earliest occurrence on the date is the one a roster is almost always
    // being built for, so that is what comes back rather than an arbitrary
    // merge of several attendee lists.
    async forOccasion(guild, { date, eventScheduleId = null }) {
      if (!DATE_RE.test(date || '')) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      let q = dbFor(guild).from('event_signups').select('*').eq('event_date', date);
      if (eventScheduleId) q = q.eq('event_schedule_id', eventScheduleId);
      const { data, error } = await q.order('starts_at').limit(1);
      if (error) { console.error('signups.forOccasion error:', error.message); throw httpError(500, 'Failed to load signups.'); }
      if (!data || !data.length) return null;
      return this.hydrate(guild, data[0]);
    },

    // ── WRITES ──────────────────────────────────────────────────────────────

    // Open signups for one occurrence. `eventDate` is the guild NIGHT, and
    // `startTime` defaults to the scheduled event's own time — an officer
    // opening signups for Saturday's field boss shouldn't have to restate when
    // it is, and a hand-typed time that disagrees with the schedule is a
    // reconciliation bug waiting to happen.
    async create(guild, { eventScheduleId, eventDate, startTime, title, capacity, reminderLeadMinutes, mentionRoleId, createdBy }) {
      const db = dbFor(guild);
      if (!DATE_RE.test(eventDate || '')) throw httpError(400, 'Date must be in YYYY-MM-DD format.');

      let scheduled = null;
      if (eventScheduleId) {
        const { data } = await db.from('event_schedule').select('*').eq('id', eventScheduleId).maybeSingle();
        if (!data) throw httpError(400, 'Unknown event.');
        // Against the night it belongs to, not the calendar day it's stored on
        // — the same check submitEvent() makes in loa.js, and for the same
        // reason: Saturday + the 12:30am event is a valid pairing.
        const dow = new Date(`${eventDate}T12:00:00`).getDay();
        if (guildDayOfWeek(data.day_of_week, data.event_time, guild) !== dow) {
          throw httpError(400, "That event isn't scheduled on that date.");
        }
        scheduled = data;
      }

      const time = startTime || scheduled?.event_time || null;
      if (!TIME_RE.test(time || '')) throw httpError(400, 'A start time is required (HH:MM).');
      const startsAt = startsAtFor(guild, eventDate, time);
      if (!startsAt) throw httpError(400, 'Could not resolve that date and time.');

      const cleanTitle = String(title || scheduled?.name || '').trim();
      if (!cleanTitle) throw httpError(400, 'Give this signup a title.');

      const cap = capacity === null || capacity === undefined || capacity === '' ? null : parseInt(capacity, 10);
      if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw httpError(400, 'Capacity must be a positive number.');
      const lead = reminderLeadMinutes === null || reminderLeadMinutes === undefined || reminderLeadMinutes === ''
        ? null : parseInt(reminderLeadMinutes, 10);
      if (lead !== null && (!Number.isFinite(lead) || lead <= 0)) throw httpError(400, 'Reminder lead time must be a positive number of minutes.');

      const mention = resolveMentionRole(guild, mentionRoleId);

      const id = crypto.randomUUID();
      const { error } = await db.from('event_signups').insert({
        id,
        event_schedule_id: eventScheduleId || null,
        title: cleanTitle.slice(0, 200),
        starts_at: startsAt.toISOString(),
        event_date: eventDate,
        capacity: cap,
        reminder_lead_minutes: lead,
        mention_role_id: mention,
        created_by: createdBy || null,
      });
      if (error) {
        // The partial unique index on (guild_id, event_schedule_id, event_date).
        // Reported as a conflict rather than a 500 because it names a real,
        // fixable situation: signups for this occurrence already exist.
        if (error.code === '23505') throw httpError(409, 'Signups are already open for that event on that date.');
        console.error('signups.create error:', error.message);
        throw httpError(500, 'Failed to open signups.');
      }
      await audit(guild, { id: createdBy, name: createdBy }, `signup opened: ${cleanTitle}`, { id, event_date: eventDate, capacity: cap });
      return this.detail(guild, id, { officer: false });
    },

    // Bring the occurrence a member is trying to sign up for into existence, if
    // nobody has opened it yet. Returns the occurrence id either way.
    //
    // ── WHY THIS EXISTS ─────────────────────────────────────────────────────
    // The Event Calendar lists every recurring event on the nights it falls on,
    // including the nights nobody has opened signups for. Without this, most of
    // that list is unanswerable: a member looks at Saturday's field boss, wants
    // to say they're coming, and the only honest thing the page can tell them
    // is "wait for an officer". The schedule already says the night is
    // happening — that is what a schedule IS — so signing up for it needs no
    // second act of permission.
    //
    // ── WHY IT IS QUIET ─────────────────────────────────────────────────────
    // No Discord post, and mentionRoleId is forced to null regardless of what
    // the recurrence's ping role says. One member tapping a row three weeks out
    // is answering a question, not calling a raid, and forty phones buzzing
    // because of it is how a guild learns to mute the bot. The occurrence shows
    // up on the Signups page like any other, and an officer's Repost button is
    // the one click that announces it.
    //
    // That leaves it in exactly the position of an occurrence an officer opened
    // with post:false — which is also why the auto-open sweep will now skip
    // that night (autoOpen's 23505 branch treats any already-open night as
    // done; see test 16 in test/signupSemantics.js). The trade is deliberate:
    // an unannounced night somebody is already signed up for beats a night
    // nobody could answer at all.
    //
    // ── WHY IT IS IDEMPOTENT ────────────────────────────────────────────────
    // Two members tapping the same night at the same instant must end up in one
    // attendee list, not two occurrences with half of it each. The read below
    // catches the ordinary case and the unique index catches the race; both
    // return the occurrence that won rather than an error, because from the
    // caller's side "it already exists" is success.
    async openForSchedule(guild, { eventScheduleId, eventDate, openedBy }) {
      const db = dbFor(guild);
      if (!eventScheduleId) throw httpError(400, 'Pick an event.');
      if (!DATE_RE.test(eventDate || '')) throw httpError(400, 'Date must be in YYYY-MM-DD format.');

      const existing = await findOccurrence(db, eventScheduleId, eventDate);
      if (existing) return { id: existing.id, opened: false };

      const { data: scheduled } = await db.from('event_schedule').select('*').eq('id', eventScheduleId).maybeSingle();
      if (!scheduled) throw httpError(400, 'Unknown event.');
      if (!TIME_RE.test(scheduled.event_time || '')) {
        throw httpError(400, `"${scheduled.name}" has no start time on the schedule, so signups can't be opened for it.`);
      }
      // The night it belongs to, not the calendar day it is stored on — the
      // same check create() makes, done here too so the errors below are about
      // the right occurrence.
      const dow = new Date(`${eventDate}T12:00:00`).getDay();
      if (guildDayOfWeek(scheduled.day_of_week, scheduled.event_time, guild) !== dow) {
        throw httpError(400, "That event isn't scheduled on that date.");
      }

      const startsAt = startsAtFor(guild, eventDate, scheduled.event_time);
      if (!startsAt) throw httpError(400, 'Could not resolve that date and time.');
      // A night that has already begun is attendance's business, not signups'.
      if (startsAt.getTime() <= Date.now()) throw httpError(409, 'That event has already started.');
      if (startsAt.getTime() - Date.now() > MEMBER_OPEN_HORIZON_DAYS * 86_400_000) {
        throw httpError(400, `Signups can only be opened up to ${MEMBER_OPEN_HORIZON_DAYS} days ahead.`);
      }

      try {
        const signup = await this.create(guild, {
          eventScheduleId,
          eventDate,
          startTime: scheduled.event_time,
          title: scheduled.name,
          // The recurrence's own settings, so a night opened this way is the
          // same night the sweep would have opened — minus the announcement.
          capacity: scheduled.signup_capacity,
          reminderLeadMinutes: scheduled.signup_reminder_lead_minutes,
          // Explicitly null, never undefined: undefined means "apply the guild
          // default ping", which is the one thing this path must never do.
          mentionRoleId: null,
          createdBy: openedBy || null,
        });
        return { id: signup.id, opened: true };
      } catch (err) {
        // Somebody won the race between the read above and this insert. Their
        // occurrence is as good as the one this call would have made.
        if (err.status === 409) {
          const won = await findOccurrence(db, eventScheduleId, eventDate);
          if (won) return { id: won.id, opened: false };
        }
        throw err;
      }
    },

    // ── RECURRENCE ──────────────────────────────────────────────────────────

    // Open whatever occurrences of one recurring event are now due, and return
    // the ones THIS call created so the caller can announce them.
    //
    // Every line here is shaped by the fact that it runs every few minutes, in
    // every process, forever. It has to open each night exactly once, must not
    // re-open a night an officer deliberately deleted, and must be safe to run
    // twice at the same instant. The claim ledger buys all three — the
    // reasoning is in the header of migrations/saas_005_recurring_signups.sql.
    //
    // The date arithmetic stays in JavaScript rather than moving into SQL
    // because the guild-night rollover already lives in loa.js: a 12:30am event
    // belongs to the previous night, and re-deriving that rule in a second
    // language is how the sweep and the LOA board would come to disagree about
    // which night Saturday is.
    async autoOpen(guild, schedule) {
      const db = dbFor(guild);
      const time = schedule.event_time;
      // Both conditions are already enforced by a check constraint and by the
      // settings route. Checked again because this one runs unattended, and
      // create() throwing inside a sweep is a log line nobody reads.
      if (!schedule.signup_auto_open || !TIME_RE.test(time || '')) return [];

      const daysAhead = Math.min(30, Math.max(1, parseInt(schedule.signup_open_days_ahead, 10) || 7));
      const nightDow = guildDayOfWeek(schedule.day_of_week, time, guild);
      const today = todayInGuildTz(guild);

      // Every night this recurrence falls on between today and the horizon.
      // Usually one; two when the horizon is wider than the gap between
      // occurrences, which is a legitimate setting rather than a special case.
      const candidates = [];
      for (let i = 0; i <= daysAhead; i++) {
        const date = addDays(today, i);
        // Deliberately the same expression create() validates with. A date this
        // agrees on and create() then rejects would claim the night and open
        // nothing, which is the one failure mode with no visible symptom.
        if (new Date(`${date}T12:00:00`).getDay() !== nightDow) continue;
        const startsAt = startsAtFor(guild, date, time);
        // Tonight's raid, an hour after it started, is not something to open
        // signups for. A process that was down all day comes back and catches
        // up on the future only.
        if (!startsAt || startsAt.getTime() <= Date.now()) continue;
        candidates.push(date);
      }
      if (!candidates.length) return [];

      const { data: claimed, error } = await db.from('signup_auto_opens')
        .select('event_date').eq('event_schedule_id', schedule.id).in('event_date', candidates);
      if (error) {
        console.error('signups.autoOpen ledger read failed:', error.message);
        return [];
      }
      const done = new Set((claimed || []).map((r) => r.event_date));

      const opened = [];
      for (const date of candidates) {
        if (done.has(date)) continue;

        // Claim first, create second. The other order lets two sweeps both
        // decide the night is unopened before either has written anything.
        const { error: claimErr } = await db.from('signup_auto_opens')
          .insert({ event_schedule_id: schedule.id, event_date: date });
        if (claimErr) {
          // 23505 is another process winning the race — the mechanism working,
          // not a fault, and it happens on every pass in a two-instance deploy.
          if (claimErr.code !== '23505') console.error('signups.autoOpen claim failed:', claimErr.message);
          continue;
        }

        try {
          const signup = await this.create(guild, {
            eventScheduleId: schedule.id,
            eventDate: date,
            startTime: time,
            title: schedule.name,
            capacity: schedule.signup_capacity,
            reminderLeadMinutes: schedule.signup_reminder_lead_minutes,
            // Explicitly null, never undefined: undefined means "apply the
            // guild default", and a recurrence that pings nobody has to stay
            // expressible for a guild that has one set (saas_003's rule, one
            // level up).
            mentionRoleId: schedule.signup_mention_role_id || null,
            createdBy: AUTO_ACTOR,
          });
          await db.from('signup_auto_opens').update({ signup_id: signup.id })
            .eq('event_schedule_id', schedule.id).eq('event_date', date);
          opened.push(signup);
        } catch (err) {
          // 409: an officer already opened this night by hand. The claim STAYS
          // — there is nothing left to do for that night, and releasing it
          // would have this retry every five minutes until the event passed.
          if (err.status === 409) continue;
          // Anything else is transient. Release the claim so the next pass
          // tries again; holding it would drop the night permanently and
          // silently, which is the exact failure this feature exists to stop.
          await db.from('signup_auto_opens').delete()
            .eq('event_schedule_id', schedule.id).eq('event_date', date);
          console.error(`signups.autoOpen failed for "${schedule.name}" on ${date}:`, err.message);
        }
      }
      return opened;
    },

    // Declare attendance. `addedBy` is set only when an officer is acting on
    // someone's behalf, which is also what the entry stores — so the list can
    // later say "added by an officer" rather than implying the member clicked.
    async join(guild, id, { discordId, displayName, addedBy = null }) {
      const name = await resolveDisplayName(guild, discordId, displayName);
      // Through tenantDb's rpc helper, not the bare client: it appends
      // p_guild_id after the caller's params, so the scope can neither be
      // forgotten here nor overridden by anything passed in.
      const { data, error } = await dbFor(guild).rpc('signup_join', {
        p_signup_id: id,
        p_discord_id: String(discordId),
        p_display_name: (name || '').slice(0, 120),
        p_added_by: addedBy,
      });
      if (error) {
        if (/function .*signup_join.* does not exist/i.test(error.message)) {
          throw httpError(500, 'signup_join() is missing — run migrations/saas_002_event_signups.sql in Supabase.');
        }
        console.error('signups.join error:', error.message);
        throw httpError(500, 'Could not record that signup.');
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.result === 'not_found') throw httpError(404, 'Signup not found.');
      if (row.result === 'closed') throw httpError(409, 'Signups for this event are closed.');
      if (row.result === 'ok') {
        await audit(guild, { id: addedBy || discordId, name: addedBy || name }, `signup join: ${name}`, { signup_id: id, discord_id: String(discordId), status: row.entry_status, on_behalf: Boolean(addedBy) });
      }
      return { status: row.entry_status, position: row.waitlist_position || 0, already: row.result === 'already' };
    },

    // Back to UNDECIDED — never to "declined". The button that calls this is
    // labelled "Withdraw" for exactly that reason; "Can't make it" would read
    // as filing an absence, which is the LOA system's job and is not what this
    // records.
    async withdraw(guild, id, { discordId, removedBy = null }) {
      const { data, error } = await dbFor(guild).rpc('signup_withdraw', {
        p_signup_id: id,
        p_discord_id: String(discordId),
      });
      if (error) {
        console.error('signups.withdraw error:', error.message);
        throw httpError(500, 'Could not withdraw that signup.');
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.result === 'not_found') throw httpError(404, 'Signup not found.');
      if (row.result === 'absent') return { removed: false, promoted: null };
      await audit(guild, { id: removedBy || discordId, name: removedBy || null }, 'signup withdraw', { signup_id: id, discord_id: String(discordId), was: row.was_status, on_behalf: Boolean(removedBy) });
      return {
        removed: true,
        promoted: row.promoted_discord_id
          ? { discord_id: row.promoted_discord_id, display_name: row.promoted_display_name }
          : null,
      };
    },

    // Raising the cap promotes from the front of the queue; lowering it never
    // demotes anyone who already holds a slot (see the SQL for why).
    async setCapacity(guild, id, capacity, actor) {
      const cap = capacity === null || capacity === undefined || capacity === '' ? null : parseInt(capacity, 10);
      if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw httpError(400, 'Capacity must be a positive number.');
      const { data, error } = await dbFor(guild).rpc('signup_set_capacity', {
        p_signup_id: id, p_capacity: cap,
      });
      if (error) { console.error('signups.setCapacity error:', error.message); throw httpError(500, 'Could not update capacity.'); }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.result === 'not_found') throw httpError(404, 'Signup not found.');
      await audit(guild, actor, 'signup capacity changed', { signup_id: id, capacity: cap, promoted: row.promoted });
      return { promoted: row.promoted || 0 };
    },

    // Reminder lead time, and nothing else — capacity has its own function
    // because it has to promote under a lock, and folding the two together
    // would put a plain column edit behind that lock for no reason.
    async setReminder(guild, id, minutes, actor) {
      const lead = minutes === null || minutes === undefined || minutes === '' ? null : parseInt(minutes, 10);
      if (lead !== null && (!Number.isFinite(lead) || lead <= 0)) throw httpError(400, 'Reminder lead time must be a positive number of minutes.');
      const { error } = await dbFor(guild).from('event_signups')
        .update({ reminder_lead_minutes: lead, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) { console.error('signups.setReminder error:', error.message); throw httpError(500, 'Could not update the reminder.'); }
      await audit(guild, actor, 'signup reminder changed', { signup_id: id, reminder_lead_minutes: lead });
      return { ok: true };
    },

    // Which role the NEXT post for this occurrence pings. Editing it does not
    // re-ping anything — the announcement already out there is edited in place
    // with mentions suppressed (see discordGateway.editSignupMessage), so this
    // only takes effect on a repost. That is the honest behaviour: an officer
    // fixing the ping role at 8pm should not make forty phones buzz a second
    // time for an event they were already told about.
    //
    // Unlike create(), an omitted value never means "use the guild default"
    // here: this is a targeted edit of one field, so a caller reaching it has
    // by definition said something.
    async setMentionRole(guild, id, roleId, actor) {
      const mention = resolveMentionRole(guild, roleId === undefined ? null : roleId);
      const { error } = await dbFor(guild).from('event_signups')
        .update({ mention_role_id: mention, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) { console.error('signups.setMentionRole error:', error.message); throw httpError(500, 'Could not update the ping role.'); }
      await audit(guild, actor, 'signup ping role changed', { signup_id: id, mention_role_id: mention });
      return { mention_role_id: mention };
    },

    async close(guild, id, actor) {
      const { error } = await dbFor(guild).from('event_signups')
        .update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', id);
      if (error) { console.error('signups.close error:', error.message); throw httpError(500, 'Could not close signups.'); }
      await audit(guild, actor, 'signup closed', { signup_id: id });
      return { ok: true };
    },

    async remove(guild, id, actor) {
      // Entries follow via ON DELETE CASCADE; the message is the caller's to
      // clean up, since only the gateway can reach Discord.
      const { data: signup } = await dbFor(guild).from('event_signups')
        .select('channel_id, message_id, title').eq('id', id).maybeSingle();
      const { error } = await dbFor(guild).from('event_signups').delete().eq('id', id);
      if (error) { console.error('signups.remove error:', error.message); throw httpError(500, 'Could not delete that signup.'); }
      await audit(guild, actor, `signup deleted: ${signup?.title || id}`, { signup_id: id });
      return { channelId: signup?.channel_id || null, messageId: signup?.message_id || null };
    },

    // Remember where the announcement landed. Best-effort, exactly like
    // loa.setMessageId: the signup itself already exists by the time this runs,
    // and losing the link only costs the ability to edit that message in place.
    async setMessage(guild, id, channelId, messageId) {
      const { error } = await dbFor(guild).from('event_signups')
        .update({ channel_id: channelId || null, message_id: messageId || null, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) console.error('signups.setMessage error:', error.message);
    },

    // ── REMINDERS ───────────────────────────────────────────────────────────

    // Win the right to send this occurrence's reminder, or find out someone
    // else already has. The claim is a conditional update inside Postgres, so
    // the 60-second sweep, a second process instance, and an officer mashing
    // the manual "Remind" button all contend for the same field and exactly one
    // of them comes away with it.
    async claimReminder(guild, id) {
      const { data, error } = await dbFor(guild).rpc('signup_claim_reminder', { p_signup_id: id });
      if (error) { console.error('signups.claimReminder error:', error.message); return false; }
      return data === true;
    },

    // Who a reminder actually goes to: guild members with NO entry and NO LOA.
    //
    // The LOA half is not a nicety. Without it this DMs everyone who hasn't
    // clicked, which includes every member who already told officers they're
    // away — and being chased about an event you formally excused yourself from
    // is precisely how a guild learns to mute the bot. An LOA on file is the
    // only signal that separates "decided not to come" from "hasn't opened
    // Discord today", because signups deliberately don't record the former.
    async reminderRecipients(guild, signup) {
      const [{ data: entries }, roster, unavailable] = await Promise.all([
        dbFor(guild).from('event_signup_entries').select('discord_id').eq('signup_id', signup.id),
        listMembers(guild),
        loa.unavailableOn(guild, { date: signup.event_date, eventScheduleId: signup.event_schedule_id || null }),
      ]);
      const answered = new Set((entries || []).map((e) => String(e.discord_id)));
      const excused = new Set(unavailable.map((u) => String(u.discord_id)));
      return roster.filter((m) => !answered.has(String(m.id)) && !excused.has(String(m.id)));
    },
  };
};

// ── CROSS-GUILD SWEEP HELPERS ───────────────────────────────────────────────
// These two are deliberately NOT guild-scoped and deliberately not methods on
// the factory: the sweep runs once per process for every tenant at once, so it
// has no single guild to be scoped to. Each returned row carries its own
// guild_id, and the caller MUST resolve and scope by that — never by a default.
// Both are single UPDATE … RETURNING statements, which is what makes claiming
// and selecting one atomic step rather than two racing ones.

async function claimDueReminders(supabase) {
  const { data, error } = await supabase.rpc('signup_claim_due_reminders');
  if (error) {
    if (/function .*signup_claim_due_reminders.* does not exist/i.test(error.message)) {
      console.warn('Signup sweep idle — run migrations/saas_002_event_signups.sql in Supabase.');
      return [];
    }
    console.error('signup reminder sweep failed:', error.message);
    return [];
  }
  return data || [];
}

async function closeFinished(supabase) {
  const { data, error } = await supabase.rpc('signup_close_finished');
  if (error) {
    if (/function .*signup_close_finished.* does not exist/i.test(error.message)) return [];
    console.error('signup close sweep failed:', error.message);
    return [];
  }
  return data || [];
}

// Every recurrence, in every guild, that has asked to open its own signups.
//
// Unscoped on purpose, and allow-listed in test/leakAudit.js for it: a schedule
// row is a guild's own recurrence rule and carries its own guild_id, and every
// write it leads to goes back through tenantDb scoped by THAT id (see autoOpen
// above, and the guildFor() resolution in discordGateway's sweep). One query
// for every tenant beats one query per tenant on a loop that runs forever.
//
// This one is a plain select rather than an UPDATE … RETURNING like its two
// neighbours, because the claim it leads to cannot be expressed in SQL — which
// night is due depends on the guild's timezone and its night-rollover hour. The
// atomic step happens one level down, on signup_auto_opens' primary key.
async function autoOpenSchedules(supabase) {
  const { data, error } = await supabase.from('event_schedule')
    .select('*').eq('signup_auto_open', true);
  if (error) {
    // The migration hasn't been run yet. Idle rather than noisy: the rest of
    // the sweep is unaffected and still has reminders to send.
    if (/signup_auto_open|schema cache/i.test(error.message)) {
      console.warn('Recurring signups idle — run migrations/saas_005_recurring_signups.sql in Supabase.');
      return [];
    }
    console.error('recurring signup scan failed:', error.message);
    return [];
  }
  return data || [];
}

module.exports.claimDueReminders = claimDueReminders;
module.exports.closeFinished = closeFinished;
module.exports.autoOpenSchedules = autoOpenSchedules;
module.exports.composeCounts = composeCounts;
module.exports.roleOf = roleOf;
module.exports.ROLES = ROLES;
module.exports.MEMBER_OPEN_HORIZON_DAYS = MEMBER_OPEN_HORIZON_DAYS;
