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

      // One transaction via the save_event function (migrations/012), the same
      // pattern save_match uses. This was two inserts with a compensating delete
      // if the second failed — a hand-rolled rollback whose own failure path
      // (delete fails too) leaves an event with zero attendees and nothing
      // explaining it. A function body either commits whole or not at all.
      const { data: inserted, error } = await supabase.rpc('save_event', {
        p_id: eventId,
        p_title: String(title).slice(0, 200),
        p_event_date: eventDate || null,
        p_event_schedule_id: eventScheduleId || null,
        p_attendees: attendees.map((a) => ({ id: String(a.id), name: String(a.name || '') })),
      });
      if (error) {
        console.error('save_event error:', error.message);
        throw httpError(500, 'Failed to create event.');
      }

      return { id: eventId, attendees: inserted ?? attendees.length };
    },
  };
};
