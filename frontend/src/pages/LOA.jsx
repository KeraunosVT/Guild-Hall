import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { CalendarOff, CalendarX2, Plus, Trash2, Settings, X, Repeat, ChevronDown, Pencil, Check } from 'lucide-react';

import { fmtTimeEst, fmtDatetime, todayInGuildTz, eventsForGuildDay, isAfterMidnight, guildDayOfWeek } from '../timeUtils';
import Tabs from '../components/ui/Tabs';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function LOA() {
  const { user, can } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [myEntries, setMyEntries] = useState([]);
  const [allEntries, setAllEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();

  const [tab, setTab] = useState('submit');
  const [loaType, setLoaType] = useState('event');
  const [eventDate, setEventDate] = useState('');
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [eventStartTime, setEventStartTime] = useState('');
  const [eventEndTime, setEventEndTime] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [recurDays, setRecurDays] = useState(() => new Set());
  const [recurEventScheduleId, setRecurEventScheduleId] = useState('');
  const [recurStartTime, setRecurStartTime] = useState('');
  const [recurEndTime, setRecurEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showScheduleAdmin, setShowScheduleAdmin] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newEventDay, setNewEventDay] = useState('');
  const [newEventTime, setNewEventTime] = useState('');

  const [editingEventId, setEditingEventId] = useState(null);
  const [editEventName, setEditEventName] = useState('');
  const [editEventDay, setEditEventDay] = useState('');
  const [editEventTime, setEditEventTime] = useState('');
  const [savingEvent, setSavingEvent] = useState(false);

  // Officers can submit an LOA on someone else's behalf; '' means "myself".
  // submitFor is the resolved member id (only ever set by picking a suggestion
  // or an exact-name match on blur); submitForQuery is just what's typed —
  // keeping them separate means free text can never be sent as a real target.
  const [adminMembers, setAdminMembers] = useState([]);
  const [submitFor, setSubmitFor] = useState('');
  const [submitForQuery, setSubmitForQuery] = useState('');
  const [submitForOpen, setSubmitForOpen] = useState(false);

  // Which members' rows are expanded in the Recurring weekly grid, to show
  // each day's detail (event/time-of-day scope, reason) instead of just a dot.
  const [expandedRecurring, setExpandedRecurring] = useState(() => new Set());
  const toggleRecurringExpanded = (discordId) => {
    setExpandedRecurring((prev) => {
      const next = new Set(prev);
      next.has(discordId) ? next.delete(discordId) : next.add(discordId);
      return next;
    });
  };

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/event-schedule'),
      axios.get('/api/loa'),
      axios.get('/api/loa/all'),
    ])
      .then(([sched, mine, all]) => {
        setSchedule(sched.data.schedule || []);
        setMyEntries(mine.data.entries || []);
        setAllEntries(all.data.entries || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!can('loa.admin')) return;
    axios.get('/api/admin/members').then((res) => setAdminMembers(res.data.members || [])).catch(() => {});
  }, [can]);

  const scheduleById = useMemo(() => {
    const m = {};
    schedule.forEach((s) => { m[s.id] = s; });
    return m;
  }, [schedule]);

  // The night, not the calendar day — Saturday's list includes the 12:30 AM
  // event stored on Sunday, and excludes Sunday's own evening events.
  const eventsOnDate = useMemo(() => {
    if (!eventDate) return [];
    return eventsForGuildDay(schedule, new Date(eventDate + 'T12:00:00').getDay());
  }, [eventDate, schedule]);

  // An event is tied to one specific weekday, so it can only scope a recurring
  // LOA when exactly one day is picked — with several days selected there's no
  // single event that applies to all of them, so it falls back to "whole day".
  const eventsOnRecurDay = useMemo(() => {
    if (recurDays.size !== 1) return [];
    const [dow] = recurDays;
    return eventsForGuildDay(schedule, dow);
  }, [recurDays, schedule]);

  const toggleRecurDay = (i) => {
    setRecurDays((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      if (next.size !== 1) setRecurEventScheduleId('');
      return next;
    });
  };

  const submitTarget = useMemo(() => adminMembers.find((m) => m.id === submitFor) || null, [adminMembers, submitFor]);

  const submitForSuggestions = useMemo(() => {
    const q = submitForQuery.trim().toLowerCase();
    if (!q || submitFor) return [];
    return adminMembers.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [submitForQuery, submitFor, adminMembers]);

  const pickSubmitFor = (m) => {
    setSubmitFor(m.id);
    setSubmitForQuery(m.name);
    setSubmitForOpen(false);
  };

  const clearSubmitFor = () => {
    setSubmitFor('');
    setSubmitForQuery('');
    setSubmitForOpen(false);
  };

  const onSubmitForChange = (e) => {
    setSubmitForQuery(e.target.value);
    setSubmitForOpen(true);
    if (submitFor) setSubmitFor(''); // typing again invalidates the previous pick
  };

  const onSubmitForBlur = () => {
    // Give a suggestion's onClick a chance to register before we close/validate.
    setTimeout(() => {
      setSubmitForOpen(false);
      if (submitFor) return;
      const q = submitForQuery.trim().toLowerCase();
      const exact = q && adminMembers.find((m) => m.name.toLowerCase() === q);
      if (exact) { setSubmitFor(exact.id); setSubmitForQuery(exact.name); }
      else setSubmitForQuery(''); // unresolved text can't be sent as a target — fall back to "myself"
    }, 150);
  };

  const onSubmitForKeyDown = (e) => {
    if (e.key === 'Enter' && submitForSuggestions.length > 0) {
      e.preventDefault();
      pickSubmitFor(submitForSuggestions[0]);
    } else if (e.key === 'Escape') {
      setSubmitForOpen(false);
    }
  };

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      if (loaType === 'event') {
        await axios.post('/api/loa', {
          type: 'event',
          event_date: eventDate,
          event_schedule_id: eventScheduleId || undefined,
          start_time: eventStartTime || undefined,
          end_time: eventEndTime || undefined,
          reason,
          discord_id: submitTarget?.id,
          display_name: submitTarget?.name,
        });
        flash(submitTarget ? `LOA submitted for ${submitTarget.name}.` : 'LOA submitted.');
      } else if (loaType === 'recurring') {
        // One row per selected day — the backend (and the /loa Discord command)
        // only ever submits a single day at a time, so multi-day just fans out
        // the same reason/time-window/event scope across each picked bubble.
        const days = [...recurDays];
        await Promise.all(days.map((day) => axios.post('/api/loa', {
          type: 'recurring',
          day_of_week: day,
          event_schedule_id: days.length === 1 ? (recurEventScheduleId || undefined) : undefined,
          start_time: recurStartTime || undefined,
          end_time: recurEndTime || undefined,
          reason,
          discord_id: submitTarget?.id,
          display_name: submitTarget?.name,
        })));
        flash(submitTarget
          ? `LOA submitted for ${submitTarget.name} — ${days.length} day${days.length === 1 ? '' : 's'}.`
          : `LOA submitted — ${days.length} day${days.length === 1 ? '' : 's'}.`);
      } else {
        await axios.post('/api/loa', {
          type: 'range',
          start_date: startDate,
          end_date: endDate,
          reason,
          discord_id: submitTarget?.id,
          display_name: submitTarget?.name,
        });
        flash(submitTarget ? `LOA submitted for ${submitTarget.name}.` : 'LOA submitted.');
      }
      setEventDate(''); setEventScheduleId(''); setEventStartTime(''); setEventEndTime(''); setStartDate(''); setEndDate('');
      setRecurDays(new Set()); setRecurEventScheduleId(''); setRecurStartTime(''); setRecurEndTime(''); setReason(''); setSubmitFor(''); setSubmitForQuery('');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to submit LOA.', false);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id) => {
    try {
      await axios.delete(`/api/loa/${id}`);
      flash('LOA cancelled.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to cancel.', false);
    }
  };

  const addScheduleEvent = async () => {
    if (!newEventName.trim() || newEventDay === '') return;
    try {
      await axios.post('/api/admin/event-schedule', { name: newEventName.trim(), day_of_week: parseInt(newEventDay, 10), event_time: newEventTime || null });
      setNewEventName(''); setNewEventDay(''); setNewEventTime('');
      load();
      flash('Event added to schedule.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to add event.', false);
    }
  };

  const deleteScheduleEvent = async (id) => {
    try {
      await axios.delete(`/api/admin/event-schedule/${id}`);
      load();
      flash('Event removed from schedule.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to delete.', false);
    }
  };

  const startEditEvent = (s) => {
    setEditingEventId(s.id);
    setEditEventName(s.name);
    setEditEventDay(String(s.day_of_week));
    setEditEventTime(s.event_time || '');
  };
  const cancelEditEvent = () => setEditingEventId(null);

  const saveScheduleEvent = async (id) => {
    if (!editEventName.trim() || editEventDay === '') return;
    setSavingEvent(true);
    try {
      await axios.put(`/api/admin/event-schedule/${id}`, {
        name: editEventName.trim(),
        day_of_week: parseInt(editEventDay, 10),
        event_time: editEventTime || null,
      });
      setEditingEventId(null);
      load();
      flash('Event updated.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to update event.', false);
    } finally {
      setSavingEvent(false);
    }
  };

  // A one-off "event" entry is scoped to a picked event, a start-time cutoff
  // ("out for everything from this time onward"), or both — mirrors how
  // formatRecurringOccurrence reads a recurring entry's same two knobs.
  const formatEventName = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    const window = entry.start_time
      ? (entry.end_time ? `${fmtTimeEst(entry.start_time)} – ${fmtTimeEst(entry.end_time)}` : `from ${fmtTimeEst(entry.start_time)}`)
      : '';
    if (ev) {
      const time = ev.event_time ? ` at ${fmtTimeEst(ev.event_time)}` : '';
      return `${ev.name}${time}${window ? ` (${window})` : ''}`;
    }
    if (!entry.start_time) return 'Event';
    return entry.end_time ? window : `From ${fmtTimeEst(entry.start_time)}`;
  };

  const formatEventLabel = (entry) =>
    `${formatEventName(entry)} — ${new Date(entry.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const formatRangeLabel = (entry) => {
    const fmt = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(entry.start_date)} – ${fmt(entry.end_date)}`;
  };

  const formatRecurringLabel = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    const scope = ev ? ` — ${ev.name}${ev.event_time ? ` at ${fmtTimeEst(ev.event_time)}` : ''}` : '';
    const window = entry.start_time
      ? (entry.end_time ? ` ${fmtTimeEst(entry.start_time)} – ${fmtTimeEst(entry.end_time)}` : ` from ${fmtTimeEst(entry.start_time)}`)
      : '';
    return `Every ${DAYS[entry.day_of_week]}${window}${scope}`;
  };

  // Same recurring entry, but as it reads on one specific occurrence in the
  // dated agenda rather than the standing-rule summary above.
  const formatRecurringOccurrence = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    if (ev) return `${ev.name}${ev.event_time ? ` at ${fmtTimeEst(ev.event_time)}` : ''}`;
    if (!entry.start_time) return 'All day';
    return entry.end_time ? `${fmtTimeEst(entry.start_time)} – ${fmtTimeEst(entry.end_time)}` : `From ${fmtTimeEst(entry.start_time)}`;
  };

  const formatDateHeader = (dateStr) =>
    new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  // Every YYYY-MM-DD from start to end inclusive. Built from UTC-based day math
  // rather than local Date/toISOString round-tripping, so it can't skip or repeat
  // a day around a timezone's DST boundary.
  const eachDate = (start, end) => {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const last = Date.UTC(ey, em - 1, ed);
    const out = [];
    for (let t = Date.UTC(sy, sm - 1, sd); t <= last; t += 86400000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  };

  const todayStr = todayInGuildTz();

  const upcomingAbsent = useMemo(() => {
    return allEntries.filter((e) => {
      if (e.type === 'event') return e.event_date >= todayStr;
      if (e.type === 'range') return e.end_date >= todayStr;
      return false; // recurring entries are projected onto the agenda separately below
    });
  }, [allEntries, todayStr]);

  // Recurring absences have no fixed date, so the board also lists them as a
  // standing summary in addition to projecting them onto the dated agenda below.
  const recurringEntries = useMemo(() => allEntries.filter((e) => e.type === 'recurring'), [allEntries]);

  // One row per day-of-week per member gets repetitive fast for anyone out
  // most of the week, so the standing summary groups by member instead and
  // shows their days as a weekly grid (one dot per day-of-week).
  const recurringByMember = useMemo(() => {
    const m = new Map();
    recurringEntries.forEach((e) => {
      if (!m.has(e.discord_id)) m.set(e.discord_id, { discord_id: e.discord_id, display_name: e.display_name, byDay: {} });
      m.get(e.discord_id).byDay[e.day_of_week] = e;
    });
    return [...m.values()].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [recurringEntries]);

  // ── Calendar ────────────────────────────────────────────────────────────────
  // Which month the calendar tab is showing, as YYYY-MM. Starts on the month
  // containing today's guild date, not the browser's — at 12:30am on the 1st
  // those are different months.
  const [calMonth, setCalMonth] = useState(() => todayInGuildTz().slice(0, 7));

  const shiftMonth = (delta) => {
    const [y, m] = calMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setCalMonth(d.toISOString().slice(0, 7));
  };

  // Every cell in the grid: the month padded out to whole Sunday–Saturday weeks,
  // so the first and last rows aren't ragged. Dates outside the month are kept
  // and dimmed rather than blanked — an absence spanning a month boundary should
  // still be visible where it falls.
  const calendarCells = useMemo(() => {
    const [y, m] = calMonth.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    const gridStart = new Date(first.getTime() - first.getUTCDay() * 86400000);
    const gridEnd = new Date(last.getTime() + (6 - last.getUTCDay()) * 86400000);
    const cells = [];
    for (let t = gridStart.getTime(); t <= gridEnd.getTime(); t += 86400000) {
      const iso = new Date(t).toISOString().slice(0, 10);
      cells.push({ date: iso, inMonth: iso.slice(0, 7) === calMonth });
    }
    return cells;
  }, [calMonth]);

  // Who's absent on each visible day. Same three projections the agenda uses —
  // a one-off on its date, a range across every day it covers, a recurring entry
  // on each matching day-of-week — but over the whole grid rather than a
  // forward-only window, so past months read correctly too.
  const calendarByDate = useMemo(() => {
    const inGrid = new Set(calendarCells.map((c) => c.date));
    const groups = {};
    const add = (d, e) => { if (inGrid.has(d)) (groups[d] = groups[d] || []).push(e); };

    allEntries.forEach((e) => {
      if (e.type === 'event' && e.event_date) add(e.event_date, e);
      else if (e.type === 'range' && e.start_date && e.end_date) {
        eachDate(e.start_date, e.end_date).forEach((d) => add(d, e));
      }
    });
    calendarCells.forEach(({ date }) => {
      const dow = new Date(date + 'T12:00:00').getDay();
      recurringEntries.filter((e) => e.day_of_week === dow).forEach((e) => add(date, e));
    });

    // Someone with both a range and a recurring entry covering the same day is
    // one person absent, not two — the calendar counts people, not rows.
    Object.keys(groups).forEach((d) => {
      const seen = new Map();
      groups[d].forEach((e) => { if (!seen.has(e.discord_id)) seen.set(e.discord_id, e); });
      groups[d] = [...seen.values()].sort((a, b) =>
        (a.display_name || '').localeCompare(b.display_name || ''));
    });
    return groups;
  }, [allEntries, recurringEntries, calendarCells]);

  const [calDay, setCalDay] = useState(null); // day whose full list is open

  // How far ahead to project recurring absences onto the agenda. Recurring
  // entries have no end date, so unlike event/range entries the agenda can't
  // just span "however far out the data goes" — it needs an explicit cutoff.
  const AGENDA_LOOKAHEAD_DAYS = 14;

  // Calendar dates from today through the lookahead window, built from
  // UTC-based day math (see eachDate below) so it can't skip or repeat a day
  // around a timezone's DST boundary.
  const lookaheadDates = useMemo(() => {
    const [y, m, d] = todayStr.split('-').map(Number);
    const start = Date.UTC(y, m - 1, d);
    return Array.from({ length: AGENDA_LOOKAHEAD_DAYS }, (_, i) =>
      new Date(start + i * 86400000).toISOString().slice(0, 10));
  }, [todayStr]);

  // Agenda: the same upcoming absences, grouped under a date header and sorted
  // chronologically. A range entry appears under every day it covers (clamped to
  // today onward) rather than just its start date, so "who's out today" is accurate.
  // Recurring entries are projected onto every matching day-of-week within the
  // lookahead window, so a standing Tuesday absence shows up under each Tuesday.
  const agendaGroups = useMemo(() => {
    const groups = {};
    upcomingAbsent.forEach((e) => {
      if (e.type === 'range') {
        eachDate(e.start_date, e.end_date)
          .filter((d) => d >= todayStr)
          .forEach((d) => { (groups[d] = groups[d] || []).push(e); });
      } else {
        (groups[e.event_date] = groups[e.event_date] || []).push(e);
      }
    });
    lookaheadDates.forEach((d) => {
      const dow = new Date(d + 'T12:00:00').getDay();
      recurringEntries
        .filter((e) => e.day_of_week === dow)
        .forEach((e) => { (groups[d] = groups[d] || []).push(e); });
    });
    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({
        date,
        // Earliest to latest within the day; no-start-time ("all day") entries
        // are treated as starting at midnight so they sort first.
        entries: [...entries].sort((a, b) => (a.start_time || '00:00').localeCompare(b.start_time || '00:00')),
      }));
  }, [upcomingAbsent, todayStr, lookaheadDates, recurringEntries]);

  const canSubmitEvent = loaType === 'event' && eventDate && (eventScheduleId || eventStartTime) && reason.trim();
  const canSubmitRange = loaType === 'range' && startDate && endDate && reason.trim();
  const canSubmitRecurring = loaType === 'recurring' && recurDays.size > 0 && reason.trim();

  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <p className="text-sm text-ash">Let officers know when you'll be missing events.</p>
        {can('schedule') && (
          <button
            onClick={() => setShowScheduleAdmin((v) => !v)}
            className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors shrink-0"
          >
            <Settings className="w-4 h-4" /> {showScheduleAdmin ? 'Close schedule' : 'Manage schedule'}
          </button>
        )}
      </div>

      <Toast msg={msg} />

      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {/* Admin: event schedule config */}
      {showScheduleAdmin && (
        <div className="mb-8 panel rounded-lg p-6">
          <div className="eyebrow text-brass text-[10px] mb-4">Event Schedule</div>
          <div className="flex gap-2 mb-4">
            <input value={newEventName} onChange={(e) => setNewEventName(e.target.value)} placeholder="Event name"
              className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
            <select value={newEventDay} onChange={(e) => setNewEventDay(e.target.value)}
              className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
              <option value="">— day —</option>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
            <div className="flex items-center gap-1">
              <input type="time" value={newEventTime} onChange={(e) => setNewEventTime(e.target.value)}
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                title="Event time in ET (optional)" />
              <span className="text-ash text-xs shrink-0">ET</span>
            </div>
            <button onClick={addScheduleEvent} disabled={!newEventName.trim() || newEventDay === ''}
              className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2">
            {schedule.length === 0 ? (
              <p className="text-ash text-sm">No events scheduled. Add your recurring events above.</p>
            ) : schedule.map((s) => (
              editingEventId === s.id ? (
                <div key={s.id} className="flex gap-2 bg-hall border border-brass/50 rounded-lg px-3 py-2">
                  <input value={editEventName} onChange={(e) => setEditEventName(e.target.value)} placeholder="Event name"
                    className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
                  <select value={editEventDay} onChange={(e) => setEditEventDay(e.target.value)}
                    className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
                    {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                  <div className="flex items-center gap-1">
                    <input type="time" value={editEventTime} onChange={(e) => setEditEventTime(e.target.value)}
                      className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                      title="Event time in ET (optional)" />
                    <span className="text-ash text-xs shrink-0">ET</span>
                  </div>
                  <button onClick={() => saveScheduleEvent(s.id)} disabled={savingEvent || !editEventName.trim()}
                    className="px-3 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={cancelEditEvent} disabled={savingEvent} className="px-3 py-2 text-ash hover:text-bone transition-colors disabled:opacity-40">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div key={s.id} className="flex items-center justify-between bg-hall border border-line rounded-lg px-3 py-2">
                  {/* Day shown is the calendar day the event is stored under,
                      which is what the edit form expects. For an after-midnight
                      event that isn't the night it belongs to, so spell that
                      out rather than leave "Sunday at 12:30 AM" to be misread. */}
                  <span className="text-bone text-sm">{s.name} <span className="text-ash">— {DAYS[s.day_of_week]}{s.event_time ? ` at ${fmtTimeEst(s.event_time)}` : ''}</span>
                    {isAfterMidnight(s.event_time) && (
                      <span className="text-brass"> · {DAYS[guildDayOfWeek(s.day_of_week, s.event_time)]} night</span>
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEditEvent(s)} className="text-ash hover:text-brass p-0.5"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => deleteScheduleEvent(s.id)} className="text-ash hover:text-oxblood p-0.5"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-ash">Loading…</div>
      ) : (
        <>
          {/* Tabs */}
          <Tabs
            variant="flat"
            items={[
              { key: 'submit', label: 'Submit LOA' },
              { key: 'mine', label: 'My LOAs' },
              { key: 'board', label: 'LOA Board' },
              { key: 'calendar', label: 'Calendar' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {/* Submit */}
          {tab === 'submit' && (
            <div className="panel rounded-lg p-6 space-y-5">
              {can('loa.admin') && (
                <div className="relative w-full md:w-64">
                  <label className="eyebrow text-[10px] text-ash block mb-2">Submit for</label>
                  <div className="relative">
                    <input
                      type="text" value={submitForQuery} onChange={onSubmitForChange}
                      onFocus={() => setSubmitForOpen(true)} onBlur={onSubmitForBlur} onKeyDown={onSubmitForKeyDown}
                      placeholder="Myself" autoComplete="off"
                      className="w-full bg-hall border border-line rounded-lg pl-4 pr-9 py-2.5 text-bone focus:outline-none focus:border-brass"
                    />
                    {submitFor && (
                      <button type="button" onClick={clearSubmitFor} title="Clear — submit for myself"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ash hover:text-oxblood">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {submitForOpen && submitForSuggestions.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-hall border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
                        {submitForSuggestions.map((m) => (
                          <button
                            key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickSubmitFor(m)}
                            className="w-full text-left px-4 py-2 text-sm text-bone hover:bg-panelup transition-colors"
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setLoaType('event')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${loaType === 'event' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarX2 className="w-4 h-4" /> Single event
                </button>
                <button onClick={() => setLoaType('range')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${loaType === 'range' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarOff className="w-4 h-4" /> Date range
                </button>
                <button onClick={() => setLoaType('recurring')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${loaType === 'recurring' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <Repeat className="w-4 h-4" /> Recurring
                </button>
              </div>

              {loaType === 'event' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Date</label>
                    <input type="date" value={eventDate} onChange={(e) => { setEventDate(e.target.value); setEventScheduleId(''); }}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Event <span className="text-ash/50">(optional — leave blank to use a start time instead)</span></label>
                    {eventsOnDate.length === 0 && eventDate ? (
                      <p className="text-ash text-sm py-2.5">No events scheduled for {DAYS[new Date(eventDate + 'T12:00:00').getDay()]}.</p>
                    ) : (
                      <select value={eventScheduleId} onChange={(e) => setEventScheduleId(e.target.value)}
                        className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                        <option value="">— select event —</option>
                        {eventsOnDate.map((s) => <option key={s.id} value={s.id}>{s.name}{s.event_time ? ` (${fmtTimeEst(s.event_time)})` : ''}</option>)}

                      </select>
                    )}
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Start time <span className="text-ash/50">(optional — "I'm out after this time")</span></label>
                    <input type="time" value={eventStartTime}
                      onChange={(e) => { setEventStartTime(e.target.value); if (!e.target.value) setEventEndTime(''); }}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                    <p className="text-ash/50 text-xs mt-1">e.g. you can make the 6pm AB but nothing scheduled after — leave Event blank and set 6:00 PM here.</p>
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">End time <span className="text-ash/50">(optional — "but I'll be back after this")</span></label>
                    <input type="time" value={eventEndTime} onChange={(e) => setEventEndTime(e.target.value)} disabled={!eventStartTime}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass disabled:opacity-40" />
                    <p className="text-ash/50 text-xs mt-1">e.g. out 7–8pm, back for anything after — set a start time first.</p>
                  </div>
                </div>
              )}

              {loaType === 'range' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Start date</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">End date</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                </div>
              )}

              {loaType === 'recurring' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Day{recurDays.size > 1 ? 's' : ''} <span className="text-ash/50">(click to select more than one)</span></label>
                    <div className="flex flex-wrap gap-1.5">
                      {DAYS.map((d, i) => (
                        <button
                          key={i} type="button" onClick={() => toggleRecurDay(i)}
                          className={`px-3 py-2 rounded-full text-xs font-semibold border transition-colors ${
                            recurDays.has(i) ? 'border-brass bg-brass text-ink' : 'border-line text-ash hover:text-bone'
                          }`}
                        >
                          {d.slice(0, 3)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Event <span className="text-ash/50">(optional — blank means the whole day)</span></label>
                    <select value={recurEventScheduleId} onChange={(e) => setRecurEventScheduleId(e.target.value)} disabled={recurDays.size !== 1}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass disabled:opacity-40">
                      <option value="">Whole day</option>
                      {eventsOnRecurDay.map((s) => <option key={s.id} value={s.id}>{s.name}{s.event_time ? ` (${fmtTimeEst(s.event_time)})` : ''}</option>)}
                    </select>
                    {recurDays.size > 1 && <p className="text-ash/50 text-xs mt-1">Pick a single day to scope this to one event — multiple days always covers the whole day.</p>}
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Start time <span className="text-ash/50">(optional — blank means absent all day)</span></label>
                    <input type="time" value={recurStartTime}
                      onChange={(e) => { setRecurStartTime(e.target.value); if (!e.target.value) setRecurEndTime(''); }}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                    <p className="text-ash/50 text-xs mt-1">Only events at or after this time will count you absent.</p>
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">End time <span className="text-ash/50">(optional — "but I'll be back after this")</span></label>
                    <input type="time" value={recurEndTime} onChange={(e) => setRecurEndTime(e.target.value)} disabled={!recurStartTime}
                      className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass disabled:opacity-40" />
                    <p className="text-ash/50 text-xs mt-1">Leave blank to stay out for the rest of the day — set a start time first.</p>
                  </div>
                </div>
              )}

              <div>
                <label className="eyebrow text-[10px] text-ash block mb-2">Reason <span className="text-ash/50">(visible to officers only)</span></label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. vacation, work trip"
                  className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              </div>

              <button onClick={submit} disabled={submitting || !(canSubmitEvent || canSubmitRange || canSubmitRecurring)}
                className="px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
                {submitting ? 'Submitting…' : 'Submit LOA'}
              </button>
            </div>
          )}

          {/* My LOAs */}
          {tab === 'mine' && (
            <div>
              {myEntries.length === 0 ? (
                <div className="panel rounded-lg p-10 text-center text-ash">You have no LOAs on file.</div>
              ) : (
                <div className="panel rounded-lg divide-y divide-line">
                  {myEntries.map((e) => (
                    <div key={e.id} className="flex items-center gap-4 px-5 py-3">
                      <div className="flex items-center gap-2 shrink-0">
                        {e.type === 'event' && <CalendarX2 className="w-4 h-4 text-brass" />}
                        {e.type === 'range' && <CalendarOff className="w-4 h-4 text-brass" />}
                        {e.type === 'recurring' && <Repeat className="w-4 h-4 text-brass" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-bone text-sm">
                          {e.type === 'event' && formatEventLabel(e)}
                          {e.type === 'range' && formatRangeLabel(e)}
                          {e.type === 'recurring' && formatRecurringLabel(e)}
                        </div>
                        {e.reason && <div className="text-xs text-ash mt-0.5">{e.reason}</div>}
                      </div>
                      <div className="text-xs text-ash/60 shrink-0 text-right" title="When this LOA was submitted">Filed {fmtDatetime(e.created_at)}</div>
                      <button onClick={() => cancel(e.id)} className="text-ash hover:text-oxblood shrink-0" title="Cancel LOA">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* LOA Board — recurring absences, then the dated agenda, chronological */}
          {tab === 'board' && (
            <div className="space-y-8">
              {recurringByMember.length > 0 && (
                <div>
                  <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
                    <Repeat className="w-3.5 h-3.5" /> Recurring
                  </div>
                  <div className="panel rounded-lg divide-y divide-line">
                    {recurringByMember.map((m) => {
                      const canCancel = can('loa.admin') || m.discord_id === user?.id;
                      const isOpen = expandedRecurring.has(m.discord_id);
                      const activeDays = DAYS.map((d, i) => ({ d, i, entry: m.byDay[i] })).filter((x) => x.entry);
                      return (
                        <div key={m.discord_id}>
                          <div className="flex items-center gap-4 px-5 py-3">
                            <button
                              onClick={() => toggleRecurringExpanded(m.discord_id)}
                              className="flex items-center gap-2 min-w-0 flex-1 text-left group"
                            >
                              <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-ash transition-transform group-hover:text-brass ${isOpen ? 'rotate-180' : ''}`} />
                              <span className="text-bone text-sm font-medium truncate">{m.display_name || 'Member'}</span>
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              {DAYS.map((d, i) => {
                                const entry = m.byDay[i];
                                const active = !!entry;
                                const title = active
                                  ? `${d} — ${formatRecurringOccurrence(entry)}${can('loa.admin') && entry.reason ? ` · ${entry.reason}` : ''}${canCancel ? ' (click to cancel)' : ''}`
                                  : d;
                                return (
                                  <button
                                    key={d}
                                    onClick={() => active && canCancel && cancel(entry.id)}
                                    disabled={!active || !canCancel}
                                    title={title}
                                    className={`w-6 h-6 rounded-full text-[10px] font-semibold border transition-colors ${
                                      active
                                        ? `bg-brass text-ink border-transparent ${canCancel ? 'hover:bg-oxblood hover:text-bone cursor-pointer' : ''}`
                                        : 'border-line text-ash/30'
                                    }`}
                                  >
                                    {d[0]}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {isOpen && (
                            <div className="pl-11 pr-5 pb-3 -mt-1 space-y-1.5">
                              {activeDays.map(({ d, i, entry }) => (
                                <div key={i} className="flex items-center gap-2 text-xs">
                                  <span className="text-brass w-24 shrink-0">{d}</span>
                                  <span className="text-ash truncate">{formatRecurringOccurrence(entry)}</span>
                                  {can('loa.admin') && entry.reason && <span className="text-ash/60 truncate">· {entry.reason}</span>}
                                  {canCancel && (
                                    <button onClick={() => cancel(entry.id)} className="ml-auto text-ash hover:text-oxblood shrink-0" title="Cancel this day">
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {agendaGroups.length === 0 ? (
                recurringEntries.length === 0 && (
                  <div className="panel rounded-lg p-10 text-center text-ash">No upcoming absences on file.</div>
                )
              ) : (
                <div className="space-y-6">
                  {agendaGroups.map(({ date, entries }) => (
                    <div key={date}>
                      <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
                        {formatDateHeader(date)}
                        {date === todayStr && <span className="text-oxblood">· Today</span>}
                      </div>
                      <div className="panel rounded-lg divide-y divide-line">
                        {entries.map((e) => (
                          <div key={e.id} className="flex items-center gap-4 px-5 py-3">
                            <div className="flex items-center gap-2 shrink-0">
                              {e.type === 'event' && <CalendarX2 className="w-4 h-4 text-brass" />}
                              {e.type === 'range' && <CalendarOff className="w-4 h-4 text-brass" />}
                              {e.type === 'recurring' && <Repeat className="w-4 h-4 text-brass" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-bone text-sm font-medium">{e.display_name || 'Member'}</div>
                              <div className="text-xs text-ash">
                                {e.type === 'event' && formatEventName(e)}
                                {e.type === 'range' && formatRangeLabel(e)}
                                {e.type === 'recurring' && formatRecurringOccurrence(e)}
                              </div>
                              {can('loa.admin') && e.reason && <div className="text-xs text-brass/70 mt-0.5">{e.reason}</div>}
                            </div>
                            <div className="text-xs text-ash/60 shrink-0 text-right" title="When this LOA was submitted">Filed {fmtDatetime(e.created_at)}</div>
                            {(can('loa.admin') || e.discord_id === user?.id) && (
                              <button onClick={() => cancel(e.id)} className="text-ash hover:text-oxblood shrink-0" title="Cancel LOA">
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Calendar */}
          {tab === 'calendar' && (
            <div className="panel rounded-lg p-4">
              <div className="flex items-center justify-between gap-3 mb-4">
                <button onClick={() => shiftMonth(-1)}
                  className="p-1.5 rounded-md text-ash hover:text-bone hover:bg-hall transition-colors" title="Previous month">
                  <ChevronDown className="w-4 h-4 rotate-90" />
                </button>
                <div className="flex items-center gap-3">
                  <h3 className="font-display text-lg text-bone tracking-[0.06em]">
                    {new Date(`${calMonth}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </h3>
                  {calMonth !== todayStr.slice(0, 7) && (
                    <button onClick={() => setCalMonth(todayStr.slice(0, 7))}
                      className="text-xs text-brass hover:text-brassbright transition-colors">Today</button>
                  )}
                </div>
                <button onClick={() => shiftMonth(1)}
                  className="p-1.5 rounded-md text-ash hover:text-bone hover:bg-hall transition-colors" title="Next month">
                  <ChevronDown className="w-4 h-4 -rotate-90" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 mb-1">
                {DAYS.map((d) => (
                  <div key={d} className="eyebrow text-[10px] text-ash text-center py-1">{d.slice(0, 3)}</div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {calendarCells.map(({ date, inMonth }) => {
                  const out = calendarByDate[date] || [];
                  const isToday = date === todayStr;
                  return (
                    <button
                      key={date}
                      onClick={() => out.length && setCalDay(calDay === date ? null : date)}
                      className={`min-h-[76px] rounded-lg border p-1.5 text-left align-top transition-colors ${
                        calDay === date ? 'border-brass bg-hall'
                          : isToday ? 'border-brass/50 bg-hall/40'
                            : 'border-line bg-hall/20'
                      } ${inMonth ? '' : 'opacity-40'} ${out.length ? 'hover:border-brass/60 cursor-pointer' : 'cursor-default'}`}
                    >
                      <div className="flex items-baseline justify-between mb-1">
                        <span className={`text-xs font-mono ${isToday ? 'text-brassbright' : inMonth ? 'text-bone' : 'text-ash'}`}>
                          {Number(date.slice(8, 10))}
                        </span>
                        {out.length > 0 && (
                          <span className="text-[10px] font-mono text-oxblood">{out.length}</span>
                        )}
                      </div>
                      {/* Two names, then a count — a cell is a glance, not a list.
                          Clicking opens the full roster for the day below. */}
                      <div className="space-y-0.5">
                        {out.slice(0, 2).map((e) => (
                          <div key={e.id} className="text-[10px] text-ash truncate leading-tight">
                            {e.display_name || 'Member'}
                          </div>
                        ))}
                        {out.length > 2 && (
                          <div className="text-[10px] text-ash/60 leading-tight">+{out.length - 2} more</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {calDay && (
                <div className="mt-4 border-t border-line pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-bone text-sm font-medium">{formatDateHeader(calDay)}</h4>
                    <button onClick={() => setCalDay(null)} className="text-ash hover:text-bone" title="Close">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {(calendarByDate[calDay] || []).map((e) => (
                      <div key={e.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                        <span className="text-bone w-40 shrink-0 truncate">{e.display_name || 'Member'}</span>
                        <span className="text-ash text-xs flex-1 truncate">
                          {e.type === 'recurring' ? formatRecurringOccurrence(e)
                            : e.type === 'range' ? `Away ${formatRangeLabel(e)}`
                              : formatEventName(e)}
                        </span>
                        {can('loa.admin') && e.reason && (
                          <span className="text-brass/70 text-xs truncate max-w-[220px]" title={e.reason}>{e.reason}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(calendarByDate).length === 0 && (
                <p className="text-ash text-sm text-center py-6">Nobody is marked absent this month.</p>
              )}
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
