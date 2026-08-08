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

    async createEvent(guild, { title, eventDate, eventScheduleId, attendees }) {
      const db = tenantDb(supabase, guild.id);
      if (!title) throw httpError(400, 'Title is required.');
      if (!Array.isArray(attendees) || attendees.length === 0) {
        throw httpError(400, 'At least one attendee is required.');
      }

      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error: eErr } = await db.from('events').insert({
        id: eventId, title: String(title).slice(0, 200),
        event_date: eventDate || null,
        event_schedule_id: eventScheduleId || null,
        created_at: now,
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
