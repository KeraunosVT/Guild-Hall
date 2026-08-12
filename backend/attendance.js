// backend/attendance.js — event creation + event-schedule lookups, shared
// between the website's /api/admin/events route and the /attendance Discord
// command so both write through the same validation instead of maintaining
// it twice (same pattern as loa.js).
const crypto = require('crypto');
const { guildDayOfWeek, daySlot } = require('./loa');
const { tenantDb } = require('./tenantDb');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Built once at boot and shared by the website and the /attendance slash
// command, so it carries no guild of its own — every method takes the resolved
// guilds ROW first, not just its id: listSchedule sorts by guild-night, which
// needs day_start as well as the id to scope by. HTTP callers pass req.guild;
// the bot passes interaction.guildHall (see guildRegistry).
//
// Convention across the converted modules: take the row when the module needs
// per-guild config (loa, attendance), take the bare id when it only scopes
// queries (gearIlvl, eliteTimers).
module.exports = function createAttendance(supabase) {
  // The party a night ran with, frozen onto the event.
  //
  // `rosterId` undefined means "find the one built for this night"; null means
  // an officer deliberately chose none. The auto-match is on
  // (event_date, event_schedule_id) — already the join key that lines LOA,
  // signups and the party builder up on the same night, so a roster found this
  // way is the roster this event is about.
  //
  // What gets stored is a COPY of layout, not the roster's id alone. Rosters
  // are living documents; a link would let editing next week's parties rewrite
  // what last week's event says it fielded, and nobody would ever see it
  // happen.
  async function freezeParty(db, { rosterId, eventDate, eventScheduleId }) {
    let row = null;
    if (rosterId) {
      // Scoped read: an id from another tenant comes back empty rather than
      // stamping their roster onto this guild's event.
      const { data } = await db.from('rosters').select('id, name, layout').eq('id', rosterId).maybeSingle();
      if (!data) throw httpError(404, 'That saved party no longer exists.');
      row = data;
    } else if (rosterId === undefined && eventDate) {
      let q = db.from('rosters').select('id, name, layout')
        .eq('event_date', eventDate)
        .order('updated_at', { ascending: false }).limit(1);
      // Narrowed to the occurrence when there is one, so two events on the
      // same night don't both claim the first roster found.
      if (eventScheduleId) q = q.eq('event_schedule_id', eventScheduleId);
      const { data } = await q;
      row = (data && data[0]) || null;
    }
    if (!row) return { roster_id: null, party_layout: null };
    return {
      roster_id: row.id,
      // The roster's name lives inside the frozen copy too — the breadcrumb can
      // be nulled by a delete, and "which party was this" should survive.
      party_layout: { ...(row.layout || {}), name: row.name || null },
    };
  }

  return {
    // Every scheduled event, for populating a dropdown/autocomplete. Ordered by
    // the night each belongs to and its position in that night, so the 12:30am
    // event sits at the end of its own evening rather than at the top of the
    // following morning — matching how these lists are labelled.
    async listSchedule(guild) {
      const { data, error } = await tenantDb(supabase, guild.id).from('event_schedule').select('*');
      if (error) { console.error('attendance.listSchedule error:', error.message); return []; }
      return (data || []).sort((a, b) =>
        guildDayOfWeek(a.day_of_week, a.event_time, guild) - guildDayOfWeek(b.day_of_week, b.event_time, guild)
        || (a.event_time ? daySlot(a.event_time, guild) : -1) - (b.event_time ? daySlot(b.event_time, guild) : -1)
        || String(a.name).localeCompare(String(b.name)));
    },

    // Scoped even though `id` is a uuid PK: an unscoped lookup would happily
    // return another guild's schedule row to anyone who learned its id, which
    // is the cross-guild IDOR the plan's Phase 4 audit tests for.
    async getScheduleEvent(guild, id) {
      if (!id) return null;
      const { data, error } = await tenantDb(supabase, guild.id)
        .from('event_schedule').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    async createEvent(guild, { title, eventDate, eventScheduleId, attendees, rosterId }) {
      const db = tenantDb(supabase, guild.id);
      if (!title) throw httpError(400, 'Title is required.');
      if (!Array.isArray(attendees) || attendees.length === 0) {
        throw httpError(400, 'At least one attendee is required.');
      }

      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();
      // Resolved before the insert: a bad roster id should fail the save, not
      // leave an event behind with no party and no explanation.
      const party = await freezeParty(db, { rosterId, eventDate, eventScheduleId });

      const { error: eErr } = await db.from('events').insert({
        id: eventId, title: String(title).slice(0, 200),
        event_date: eventDate || null,
        event_schedule_id: eventScheduleId || null,
        created_at: now,
        ...party,
      });
      if (eErr) { console.error('Event insert error:', eErr.message); throw httpError(500, 'Failed to create event.'); }

      const rows = attendees.map((a) => ({
        id: crypto.randomUUID(), event_id: eventId,
        discord_id: String(a.id), display_name: String(a.name || '').slice(0, 120),
        joined_at: now,
      }));
      const { error: aErr } = await db.from('event_attendance').insert(rows);
      if (aErr) {
        console.error('Attendance insert error:', aErr.message);
        // Scoped rollback: deleting by event id alone would let a guild_id
        // mix-up remove another guild's event.
        await db.from('events').delete().eq('id', eventId);
        throw httpError(500, 'Failed to save attendees — event rolled back.');
      }

      return { id: eventId, attendees: rows.length };
    },
  };
};
