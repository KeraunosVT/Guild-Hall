// backend/attendance.js — event creation + event-schedule lookups, shared
// between the website's /api/admin/events route and the /attendance Discord
// command so both write through the same validation instead of maintaining
// it twice (same pattern as loa.js).
const crypto = require('crypto');
const { guildDayOfWeek, daySlot } = require('./loa');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = function createAttendance(supabase) {
  return {
    // Every scheduled event, for populating a dropdown/autocomplete. Ordered by
    // the night each belongs to and its position in that night, so the 12:30am
    // event sits at the end of its own evening rather than at the top of the
    // following morning — matching how these lists are labelled.
    async listSchedule() {
      const { data, error } = await supabase.from('event_schedule').select('*');
      if (error) { console.error('attendance.listSchedule error:', error.message); return []; }
      return (data || []).sort((a, b) =>
        guildDayOfWeek(a.day_of_week, a.event_time) - guildDayOfWeek(b.day_of_week, b.event_time)
        || (a.event_time ? daySlot(a.event_time) : -1) - (b.event_time ? daySlot(b.event_time) : -1)
        || String(a.name).localeCompare(String(b.name)));
    },

    async getScheduleEvent(id) {
      if (!id) return null;
      const { data, error } = await supabase.from('event_schedule').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    async createEvent({ title, eventDate, eventScheduleId, attendees }) {
      if (!title) throw httpError(400, 'Title is required.');
      if (!Array.isArray(attendees) || attendees.length === 0) {
        throw httpError(400, 'At least one attendee is required.');
      }

      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error: eErr } = await supabase.from('events').insert({
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
      const { error: aErr } = await supabase.from('event_attendance').insert(rows);
      if (aErr) {
        console.error('Attendance insert error:', aErr.message);
        await supabase.from('events').delete().eq('id', eventId);
        throw httpError(500, 'Failed to save attendees — event rolled back.');
      }

      return { id: eventId, attendees: rows.length };
    },
  };
};
