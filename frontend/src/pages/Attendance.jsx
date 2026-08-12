import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import {
  RefreshCw, Camera, Trash2, Users, CalendarDays, Loader2,
  BarChart3, Wand2, Swords, Check, X, Inbox, Volume2, AlertTriangle,
} from 'lucide-react';
import { fmtTimeEst, fmtDatetime, guildDayOfWeek, isAfterMidnight } from '../timeUtils';
import RestrictedGate from '../components/ui/RestrictedGate';
import Tabs from '../components/ui/Tabs';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The four windows this page can be looked at through. Server-side: the rate
// table and the event list sit side by side, and the only way to guarantee they
// agree about what "the last two weeks" means is for one place to decide it.
//
// "All" is here so the pre-filter behaviour stays reachable — a filter that
// hides history with no way back loses data as far as anyone using it can tell.
const WINDOWS = [
  { key: '7', label: '1 week' },
  { key: '14', label: '2 weeks' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All' },
];
const WINDOW_LABEL = { 7: 'last 7 days', 14: 'last 14 days', 30: 'last 30 days', all: 'all time' };

export default function Attendance() {
  const { can } = useAuth();

  const [channels, setChannels] = useState([]);
  const [configuredId, setConfiguredId] = useState(null);
  const [snapped, setSnapped] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [rosters, setRosters] = useState([]);
  const [rosterId, setRosterId] = useState('auto');
  const [snapping, setSnapping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const [window_, setWindow_] = useState('30');
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);

  const [stats, setStats] = useState({ totalEvents: 0, members: [] });
  const [loadingStats, setLoadingStats] = useState(true);
  const [statSort, setStatSort] = useState('rate'); // 'rate' | 'name' | 'attended'
  const [statDir, setStatDir] = useState('desc');
  const [backfilling, setBackfilling] = useState(false);

  const [lateRequests, setLateRequests] = useState([]);
  const [deciding, setDeciding] = useState('');

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  // One call answers both questions: which channel is configured, and what it
  // is called. The id alone would put a snowflake on screen where a name
  // belongs, and /api/admin/settings is closed to attendance-only officers.
  const loadChannels = useCallback(() => {
    axios.get('/api/admin/voice-channels')
      .then((res) => {
        setChannels(res.data.channels || []);
        setConfiguredId(res.data.configured_id || null);
      })
      .catch(() => { setChannels([]); setConfiguredId(null); });
  }, []);

  // The rate table and the event list are refetched together, always, and both
  // are handed the same window. Filtering one without the other is how a member
  // ends up with a rate above 100%.
  const loadEvents = useCallback(() => {
    setLoadingEvents(true);
    axios.get('/api/admin/events', { params: { window: window_ } })
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load events.'))
      .finally(() => setLoadingEvents(false));
  }, [window_]);

  const loadStats = useCallback(() => {
    setLoadingStats(true);
    axios.get('/api/admin/attendance-stats', { params: { window: window_ } })
      .then((res) => setStats(res.data || { totalEvents: 0, members: [] }))
      .catch(() => {})
      .finally(() => setLoadingStats(false));
  }, [window_]);

  const loadLate = useCallback(() => {
    axios.get('/api/admin/attendance/late-requests', { params: { status: 'pending' } })
      .then((res) => setLateRequests(res.data.requests || []))
      .catch(() => setLateRequests([]));
  }, []);

  useEffect(() => {
    axios.get('/api/event-schedule').then((res) => setSchedule(res.data.schedule || [])).catch(() => setSchedule([]));
    axios.get('/api/admin/rosters').then((res) => setRosters(res.data.rosters || [])).catch(() => setRosters([]));
    loadChannels();
    loadLate();
  }, [loadChannels, loadLate]);

  useEffect(() => { loadEvents(); loadStats(); }, [loadEvents, loadStats]);

  const channel = useMemo(
    () => channels.find((c) => c.id === configuredId) || null,
    [channels, configuredId],
  );

  const sortedStats = useMemo(() => {
    const dir = statDir === 'asc' ? 1 : -1;
    return [...stats.members].sort((a, b) => {
      if (statSort === 'name') return a.display_name.localeCompare(b.display_name) * dir;
      return ((a[statSort] || 0) - (b[statSort] || 0)) * dir;
    });
  }, [stats.members, statSort, statDir]);

  // Every hook is above this line on purpose. It used to sit higher up, which
  // made the hook count depend on a capability check — legal only for as long
  // as nobody's permissions changed mid-session.
  if (!can('attendance')) return <RestrictedGate />;

  const backfillNames = async () => {
    setBackfilling(true);
    try {
      const res = await axios.post('/api/admin/attendance/backfill-names');
      flash(`Checked ${res.data.checked} record${res.data.checked === 1 ? '' : 's'} — updated ${res.data.updated}.`);
      loadEvents(); loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Backfill failed.', false);
    } finally {
      setBackfilling(false);
    }
  };

  const snap = async () => {
    if (!configuredId) return;
    setSnapping(true);
    try {
      const res = await axios.get(`/api/admin/voice-channels/${configuredId}/members`);
      const members = res.data.members || [];
      if (members.length === 0) { flash('No one is in that channel right now.', false); return; }
      setSnapped(members);
      flash(`Snapped ${members.length} member${members.length === 1 ? '' : 's'}.`);
    } catch {
      flash('Could not read that voice channel.', false);
    } finally {
      setSnapping(false);
    }
  };

  const removeSnapped = (id) => setSnapped((prev) => prev.filter((m) => m.id !== id));

  const selectScheduleEvent = (id) => {
    setEventScheduleId(id);
    const ev = schedule.find((s) => s.id === id);
    if (ev) setTitle(ev.name);
  };

  const save = async () => {
    if (!title.trim()) { flash('Give this event a title.', false); return; }
    if (snapped.length === 0) { flash('Snap the voice channel first.', false); return; }
    setSaving(true); setError('');
    try {
      const res = await axios.post('/api/admin/events', {
        title, event_date: eventDate || null, event_schedule_id: eventScheduleId || null, attendees: snapped,
        // 'auto' means omit the field entirely, which is what tells the server
        // to look for the roster built for this night. Sending null instead
        // would read as "deliberately no party".
        ...(rosterId === 'auto' ? {} : { roster_id: rosterId || null }),
      });
      flash(`Saved — ${res.data.attendees} attendees logged.`);
      setSnapped([]); setTitle(''); setEventDate(''); setEventScheduleId(''); setRosterId('auto');
      loadEvents(); loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not save event.', false);
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async (id) => {
    if (!window.confirm('Delete this event and its attendance records?')) return;
    try {
      await axios.delete(`/api/admin/events/${id}`);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      flash('Event deleted.');
      loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Delete failed.', false);
    }
  };

  const decide = async (req, status) => {
    setDeciding(req.id);
    try {
      await axios.patch(`/api/admin/attendance/late-requests/${req.id}`, { status });
      flash(status === 'approved'
        ? `${req.display_name} added to ${req.event?.title || 'that event'}.`
        : `Declined ${req.display_name}'s request.`);
      setLateRequests((prev) => prev.filter((r) => r.id !== req.id));
      // An approval writes an attendance row, so the counts on screen are stale.
      if (status === 'approved') { loadEvents(); loadStats(); }
    } catch (err) {
      flash(err.response?.data?.error || 'Could not record that decision.', false);
      // A 409 means someone else decided it — refetch rather than leave a
      // button that will keep failing.
      if (err.response?.status === 409) loadLate();
    } finally {
      setDeciding('');
    }
  };

  const toggleStatSort = (key) => {
    if (statSort === key) setStatDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setStatSort(key); setStatDir(key === 'name' ? 'asc' : 'desc'); }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <p className="text-sm text-ash">Snap the attendance channel to log who showed up. Set a title and date, then save.</p>
        <button
          onClick={backfillNames} disabled={backfilling}
          title="Re-check past attendance records against mapped display names"
          className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors disabled:opacity-40 shrink-0"
        >
          <Wand2 className="w-4 h-4" /> {backfilling ? 'Fixing…' : 'Fix past names'}
        </button>
      </div>

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-lg border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {/* ── Capture ───────────────────────────────────────────────────
          One row across the top. Logging a night is the only thing on this
          page that is a *task* rather than a reading, and it is the same four
          fields every week — a row keeps it to one glance and leaves the whole
          page below it for the record. */}
      <div className="panel rounded-lg p-4 mb-12">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[190px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Scheduled event</label>
            <select
              value={eventScheduleId} onChange={(e) => selectScheduleEvent(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            >
              <option value="">— custom / none —</option>
              {/* Labelled by the night it belongs to: an after-midnight event
                  is stored on the next calendar day, so its raw day_of_week
                  would name the wrong night to whoever is logging it. */}
              {schedule.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {DAYS[guildDayOfWeek(s.day_of_week, s.event_time)]}
                  {isAfterMidnight(s.event_time) ? ' night' : ''}
                  {s.event_time ? ` at ${fmtTimeEst(s.event_time)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[190px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Event title</label>
            <input
              value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Archboss — Morokai"
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div className="w-[150px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Date</label>
            <input
              type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Party fielded</label>
            <select
              value={rosterId} onChange={(e) => setRosterId(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            >
              <option value="auto">— match this night —</option>
              <option value="">— no party —</option>
              {rosters.map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.event_date ? ` (${r.event_date})` : ''}</option>
              ))}
            </select>
          </div>
          <button
            onClick={snap} disabled={!configuredId || snapping}
            className="inline-flex items-center gap-2 px-5 py-2.5 border border-brass/50 text-brass hover:bg-panelup rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {snapping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} Snap
          </button>
          <button
            onClick={save} disabled={saving || snapped.length === 0}
            className="px-5 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : `Save${snapped.length ? ` (${snapped.length})` : ''}`}
          </button>
        </div>

        {/* Which channel Snap will read, and — when it can't — what to do about
            it. The picker moved to Guild Settings, so a blank here is a config
            problem with a fix, not a dropdown someone forgot to touch. */}
        <div className="mt-3 text-xs">
          {!configuredId ? (
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              No attendance voice channel set —{' '}
              <Link to="/admin/settings" className="underline hover:text-brass">choose one in Guild Settings</Link>.
            </span>
          ) : channel ? (
            <span className="inline-flex items-center gap-1.5 text-ash">
              <Volume2 className="w-3.5 h-3.5 text-brass" />
              Snapping <span className="text-bone">{channel.name}</span> · {channel.memberCount} in channel now
              <span className="text-ash/50">·</span>
              <Link to="/admin/settings" className="hover:text-brass">change</Link>
            </span>
          ) : channels.length === 0 ? (
            // No voice channels at all is a different fault from one missing
            // one, and it has a different fix — the bot is offline or can't
            // see the category. Naming the right one saves an officer editing
            // a setting that was never wrong.
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              The bot can’t see any voice channels — check it’s online and has permission to view them.
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              The configured channel isn’t one the bot can see —{' '}
              <Link to="/admin/settings" className="underline hover:text-brass">pick another in Guild Settings</Link>.
            </span>
          )}
          <span className="text-ash/50 block mt-1">
            A copy of the party is stored on the event, so editing the saved party later won’t change this record.
          </span>
        </div>

        {snapped.length > 0 && (
          <div className="mt-4 pt-4 border-t border-line">
            <div className="eyebrow text-[10px] text-brass mb-3 flex items-center gap-2">
              <Users className="w-3.5 h-3.5" /> Snapped ({snapped.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {snapped.map((m) => (
                <div key={m.id} className="inline-flex items-center gap-2 bg-hall border border-line rounded-full pl-1.5 pr-2.5 py-1">
                  {m.avatar
                    ? <img src={m.avatar} alt="" className="w-5 h-5 rounded-full border border-line" />
                    : <span className="w-5 h-5 rounded-full bg-panelup border border-line flex items-center justify-center text-[9px] text-brass">{(m.name || '?')[0].toUpperCase()}</span>}
                  <span className="text-sm text-bone">{m.name}</span>
                  <button onClick={() => removeSnapped(m.id)} className="text-ash hover:text-oxblood" title="Remove">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Late attendance queue ─────────────────────────────────── */}
      {/* Hidden entirely when empty. A permanent "0 pending" panel above the
          part of the page officers actually use is a cost paid on every visit
          for information that matters on a few of them. */}
      {lateRequests.length > 0 && (
        <div className="mb-12">
          <h2 className="font-display text-2xl text-bone tracking-[0.08em] flex items-center gap-3">
            <Inbox className="w-5 h-5 text-brass" />
            Late attendance
            <span className="text-sm font-sans text-brass">{lateRequests.length} waiting</span>
          </h2>
          <div className="rule-fade mb-6" />
          <div className="panel rounded-lg divide-y divide-line">
            {lateRequests.map((r) => (
              <div key={r.id} className="flex items-center gap-4 px-5 py-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-bone">
                    <span className="font-medium">{r.display_name}</span>
                    <span className="text-ash"> — {r.event?.title || 'an event that no longer exists'}</span>
                    {r.event?.event_date && <span className="text-ash text-xs"> · {r.event.event_date}</span>}
                  </div>
                  {r.reason && <div className="text-sm text-ash mt-0.5 italic">“{r.reason}”</div>}
                  <div className="text-xs text-ash/60 mt-0.5">Asked {fmtDatetime(r.requested_at)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => decide(r, 'approved')} disabled={deciding === r.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-emerald-400/40 text-emerald-400 hover:bg-panelup transition-colors disabled:opacity-40"
                  >
                    {deciding === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                  </button>
                  <button
                    onClick={() => decide(r, 'denied')} disabled={deciding === r.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line text-ash hover:text-oxblood transition-colors disabled:opacity-40"
                  >
                    <X className="w-3.5 h-3.5" /> Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The record ────────────────────────────────────────────── */}
      {/* One set of window tabs above both panels, because one window governs
          both: the rate is "attended / events in this window", and the list
          beside it is those same events. Two filters would let the denominator
          disagree with the list explaining it. */}
      <div className="flex items-center justify-between gap-4 mb-2">
        <h2 className="font-display text-2xl text-bone tracking-[0.08em]">Roster Attendance</h2>
        <button onClick={() => { loadEvents(); loadStats(); }} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <div className="rule-fade mb-4" />

      <Tabs
        variant="flat" active={window_} onChange={setWindow_}
        items={WINDOWS.map((w) => ({
          // Only the active tab can carry a count — the others' totals aren't
          // loaded, and a guessed number is worse than none.
          key: w.key,
          label: w.key === window_ ? `${w.label} (${events.length})` : w.label,
        }))}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Rate per player */}
        <div>
          <div className="flex items-center gap-2 text-xs text-ash mb-3">
            <BarChart3 className="w-3.5 h-3.5 text-brass" />
            {/* The window is named here, not only in the tab, because a
                percentage read out of context is assumed to be all-time. */}
            {stats.totalEvents} event{stats.totalEvents === 1 ? '' : 's'} · {WINDOW_LABEL[window_]}
          </div>

          {loadingStats ? (
            <div className="py-16 text-center text-ash"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
          ) : sortedStats.length === 0 ? (
            <div className="py-16 text-center text-ash">No attendance in this window.</div>
          ) : (
            <Table maxHeight="max-h-[720px]" minWidth="min-w-[420px]">
              <Thead sticky>
                <th className="p-4 font-normal w-10 text-right">#</th>
                <SortableTh label="Member" sortKey="name" activeKey={statSort} dir={statDir} onSort={toggleStatSort} />
                <SortableTh label="Attended" sortKey="attended" activeKey={statSort} dir={statDir} onSort={toggleStatSort} align="right" />
                <th className="p-4 font-normal w-[34%]">Rate</th>
                <SortableTh label="%" sortKey="rate" activeKey={statSort} dir={statDir} onSort={toggleStatSort} align="right" />
              </Thead>
              <tbody>
                {sortedStats.map((m, i) => (
                  <Tr key={m.discord_id}>
                    <td className="p-4 text-right font-mono text-xs text-ash/60">{i + 1}</td>
                    <td className="p-4 text-bone">{m.display_name}</td>
                    <td className="p-4 text-right font-mono text-xs text-ash whitespace-nowrap">
                      {m.attended}<span className="text-ash/40">/{stats.totalEvents}</span>
                    </td>
                    {/* The bar is the reason this table earns the width the
                        old sidebar didn't have: sixty rows of numbers hide the
                        shape of the guild, and a bar shows the drop-off. */}
                    <td className="p-4">
                      <div className="h-1.5 rounded-full bg-hall overflow-hidden">
                        <div
                          className={`h-full rounded-full ${m.rate >= 75 ? 'bg-emerald-400/70' : m.rate >= 40 ? 'bg-brass' : 'bg-oxblood'}`}
                          style={{ width: `${Math.min(100, m.rate)}%` }}
                        />
                      </div>
                    </td>
                    <td className={`p-4 text-right font-mono text-xs ${m.rate >= 75 ? 'text-emerald-400' : m.rate >= 40 ? 'text-brassbright' : 'text-oxblood'}`}>
                      {m.rate}%
                    </td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Past events */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="eyebrow text-[10px] text-brass flex items-center gap-2 mb-3">
            <CalendarDays className="w-3.5 h-3.5" /> Past Events
          </div>

          {loadingEvents ? (
            <div className="py-8 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
          ) : events.length === 0 ? (
            <p className="text-ash text-sm py-4">
              {window_ === 'all' ? 'No events logged yet.' : `Nothing logged in the ${WINDOW_LABEL[window_]}.`}
            </p>
          ) : (
            <div className="panel rounded-lg divide-y divide-line max-h-[720px] overflow-auto">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 px-4 py-3 hover:bg-panelup transition-colors">
                  {/* Straight to the night's own page. This used to expand in
                      place; a logged night is a page's worth of table, party
                      and detail, and it was never going to fit under a row. */}
                  <Link to={`/attendance/${ev.id}`} className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-bone truncate hover:text-brass transition-colors">{ev.title}</div>
                    <div className="flex items-center gap-3 text-xs text-ash mt-1">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {ev.event_date ? new Date(ev.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3 h-3" /> {ev.attendees}
                      </span>
                      {ev.has_party && (
                        <span className="inline-flex items-center gap-1 text-brass/70" title="A party was recorded for this night">
                          <Swords className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </Link>
                  <button
                    onClick={() => deleteEvent(ev.id)}
                    className="text-ash hover:text-oxblood shrink-0 p-1" title="Delete event"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
