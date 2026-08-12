import { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import {
  RefreshCw, Camera, Trash2, ChevronDown, Users, CalendarDays, Loader2, ArrowUp, ArrowDown,
  BarChart3, Wand2, CalendarCheck, UserPlus, Clock, Swords, Check, X, Inbox,
} from 'lucide-react';
import { fmtTimeEst, fmtDatetime, guildDayOfWeek, isAfterMidnight } from '../timeUtils';
import RestrictedGate from '../components/ui/RestrictedGate';
import Tabs from '../components/ui/Tabs';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const LOA_TYPE_LABEL = { event: 'Out this event', range: 'Away (date range)', recurring: 'Out weekly' };

// The four windows the page can be looked at through. Server-side: the list and
// the rate sidebar have to agree about what "the last two weeks" means, and the
// only way to guarantee that is for one place to decide it.
//
// "All" is here so the pre-filter behaviour stays reachable — a filter that
// hides history with no way back is a filter that loses data as far as anyone
// using it is concerned.
const WINDOWS = [
  { key: '7', label: '1 week' },
  { key: '14', label: '2 weeks' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All' },
];
const WINDOW_LABEL = { 7: 'last 7 days', 14: 'last 14 days', 30: 'last 30 days', all: 'all time' };

// One row per member, one status each. The four are ordered by how much they
// demand of an officer reading them, not alphabetically.
const STATUS_META = {
  attended: { label: 'Attended', className: 'border-emerald-400/40 text-emerald-400' },
  noshow_signed: { label: "No-show (signed up)", className: 'border-oxblood/60 text-bone bg-oxblooddeep/20' },
  loa: { label: 'LOA', className: 'border-brass/40 text-brass' },
  unexcused: { label: 'Unexcused', className: 'border-line text-ash' },
};
const STATUS_ORDER = { attended: 0, noshow_signed: 1, loa: 2, unexcused: 3 };

// Tooltip text for an excused absence: the window if the LOA had one, otherwise
// what kind it was, plus the reason.
function loaReason(loa) {
  if (!loa) return undefined;
  const when = loa.start_time
    ? (loa.end_time
      ? `Out ${fmtTimeEst(loa.start_time)} – ${fmtTimeEst(loa.end_time)}`
      : `Out from ${fmtTimeEst(loa.start_time)} on`)
    : LOA_TYPE_LABEL[loa.type] || 'On leave of absence';
  return loa.reason ? `${when} — ${loa.reason}` : when;
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.unexcused;
  return (
    <span className={`inline-flex items-center text-[11px] font-medium border rounded-full px-2.5 py-0.5 whitespace-nowrap ${meta.className}`}>
      {meta.label}
    </span>
  );
}

// The facts that aren't a status but change how one reads: they came without
// signing up, or they were added after the fact. Small, next to the name,
// rather than as statuses of their own — a walk-in attended, full stop.
function Badge({ children, title, className }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[10px] eyebrow border rounded-full px-1.5 py-0.5 ${className}`}>
      {children}
    </span>
  );
}

// ── The per-event table ──────────────────────────────────────────────────────
// Rows arrive already bucketed from GET /api/admin/events/:id. Deriving the
// four-way split here from the attendees / absences / signup lists would mean
// two implementations of the same reconciliation, and they would disagree the
// first time one of them changed.
function AttendanceTable({ rows }) {
  // Alphabetical by default, because this is a roll and the question asked of
  // it most often is "what does it say about X". Sorting by status instead
  // groups all fourteen who turned up at the top and pushes the handful of
  // exceptions below the fold, where they are the only rows anyone needed.
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState('asc');

  const sorted = useMemo(() => {
    const mult = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort === 'name') return String(a.display_name || '').localeCompare(String(b.display_name || '')) * mult;
      if (sort === 'time') {
        // Nobody has a time unless they were there, so absentees sort to the
        // end either way rather than clustering at whichever end 0 lands on.
        if (!a.joined_at && !b.joined_at) return 0;
        if (!a.joined_at) return 1;
        if (!b.joined_at) return -1;
        return (new Date(a.joined_at) - new Date(b.joined_at)) * mult;
      }
      return ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)) * mult
        || String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });
  }, [rows, sort, dir]);

  const onSort = (key) => {
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir(key === 'name' || key === 'status' ? 'asc' : 'desc'); }
  };

  return (
    <Table maxHeight="max-h-[520px]" minWidth="min-w-[520px]">
      <Thead sticky>
        <SortableTh label="Name" sortKey="name" activeKey={sort} dir={dir} onSort={onSort} dense />
        <SortableTh label="Status" sortKey="status" activeKey={sort} dir={dir} onSort={onSort} dense />
        <SortableTh label="Attendance taken" sortKey="time" activeKey={sort} dir={dir} onSort={onSort} dense align="right" />
      </Thead>
      <tbody>
        {sorted.map((r) => (
          <Tr key={`${r.status}:${r.discord_id}`}>
            <td className="p-2.5">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-bone">{r.display_name}</span>
                {r.walk_in && (
                  <Badge title="Turned up without signing up" className="border-line text-ash">
                    <UserPlus className="w-2.5 h-2.5" /> Walk-in
                  </Badge>
                )}
                {r.late && (
                  <Badge title="Added afterwards by an approved late-attendance request" className="border-brass/40 text-brass">
                    <Clock className="w-2.5 h-2.5" /> Late
                  </Badge>
                )}
                {/* A member who signed up and THEN filed an LOA sits in the
                    no-show bucket, but the LOA is mitigation and travels with
                    the row rather than being dropped. */}
                {r.status === 'noshow_signed' && r.loa && (
                  <Badge title={loaReason(r.loa)} className="border-brass/40 text-brass">LOA</Badge>
                )}
              </span>
            </td>
            <td className="p-2.5">
              <span title={r.status === 'loa' ? loaReason(r.loa) : undefined}>
                <StatusPill status={r.status} />
              </span>
            </td>
            {/* Absentees have no timestamp, and an em dash says that more
                honestly than a blank cell or a borrowed event date. */}
            <td className="p-2.5 text-right whitespace-nowrap text-xs text-ash font-mono">
              {r.joined_at ? fmtDatetime(r.joined_at) : '—'}
            </td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

// ── The party the night ran with ─────────────────────────────────────────────
// A frozen copy stored on the event, not a live read of the saved roster — so
// this keeps showing what was actually fielded even after the roster is
// reshuffled for next week. Each name is checked against the attendance rows,
// which is the question worth asking: not who was meant to be in party 3, but
// how much of party 3 turned up.
function PartyBlock({ party }) {
  const total = party.parties.reduce((n, p) => n + p.members.length, 0);
  const showed = party.parties.reduce((n, p) => n + p.members.filter((m) => m.attended).length, 0);
  return (
    <div>
      <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
        <Swords className="w-3 h-3" />
        Party fielded{party.name ? ` — ${party.name}` : ''}
        <span className="text-ash normal-case tracking-normal">({showed} of {total} turned up)</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {party.parties.map((p, i) => (
          <div key={`${p.name}-${i}`} className="border border-line rounded-lg p-3">
            <div className="eyebrow text-[10px] text-ash mb-2">{p.name}</div>
            <ul className="space-y-1">
              {p.members.map((m) => (
                <li key={m.id || m.name}
                  className={`text-sm ${m.attended ? 'text-bone' : 'text-ash line-through decoration-oxblood/60'}`}
                  title={m.attended ? undefined : 'In the party, not in the attendance record'}>
                  {m.name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Attendance() {
  const { can } = useAuth();

  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [snapped, setSnapped] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [rosters, setRosters] = useState([]);
  const [rosterId, setRosterId] = useState('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const [window_, setWindow_] = useState('30');
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});

  const [stats, setStats] = useState({ totalEvents: 0, members: [] });
  const [loadingStats, setLoadingStats] = useState(true);
  const [statSort, setStatSort] = useState('rate'); // 'rate' | 'name' | 'attended'
  const [statDir, setStatDir] = useState('desc');
  const [backfilling, setBackfilling] = useState(false);

  const [lateRequests, setLateRequests] = useState([]);
  const [deciding, setDeciding] = useState('');

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const loadChannels = useCallback(() => {
    axios.get('/api/admin/voice-channels')
      .then((res) => setChannels(res.data.channels || []))
      .catch(() => setChannels([]));
  }, []);

  // The list and the rate sidebar are refetched together, always, and both are
  // handed the same window. Filtering one without the other is how a member
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
    // Preselect the guild's configured attendance channel. It is the same
    // channel every week for most guilds, and picking it by hand every time is
    // the single most repeated action on this page.
    axios.get('/api/admin/settings')
      .then((res) => {
        const id = res.data?.settings?.attendance_voice_channel_id;
        if (id) setSelectedChannel(id);
      })
      .catch(() => {}); // an officer without the 'settings' capability just picks manually
    loadChannels();
    loadLate();
  }, [loadChannels, loadLate]);

  useEffect(() => { loadEvents(); loadStats(); }, [loadEvents, loadStats]);

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

  const snap = () => {
    if (!selectedChannel) return;
    axios.get(`/api/admin/voice-channels/${selectedChannel}/members`)
      .then((res) => {
        const members = res.data.members || [];
        if (members.length === 0) { flash('No one is in that channel right now.', false); return; }
        setSnapped(members);
        flash(`Snapped ${members.length} member${members.length === 1 ? '' : 's'}.`);
      })
      .catch(() => flash('Could not read voice channel.', false));
  };

  const removeSnapped = (id) => setSnapped((prev) => prev.filter((m) => m.id !== id));

  const selectScheduleEvent = (id) => {
    setEventScheduleId(id);
    const ev = schedule.find((s) => s.id === id);
    if (ev) setTitle(ev.name);
  };

  const save = async () => {
    if (!title.trim()) { flash('Give this event a title.', false); return; }
    if (snapped.length === 0) { flash('Snap a voice channel first.', false); return; }
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
      if (expanded === id) { setExpanded(null); setDetail((d) => { const n = { ...d }; delete n[id]; return n; }); }
      flash('Event deleted.');
      loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Delete failed.', false);
    }
  };

  const loadDetail = async (id) => {
    const res = await axios.get(`/api/admin/events/${id}`);
    setDetail((d) => ({
      ...d,
      [id]: {
        // rows is the table; signup survives because the summary line below it
        // (how many declared, how many of those turned up) has no equivalent in
        // a per-member view.
        rows: res.data.rows || [],
        attendees: res.data.attendees || [],
        signup: res.data.signup || null,
        party: res.data.party || null,
        lateRequests: res.data.late_requests || [],
      },
    }));
  };

  const toggleEvent = async (id) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (detail[id]) return;
    try {
      await loadDetail(id);
    } catch {
      flash('Could not load attendees.', false);
      setExpanded(null);
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
      // An approval writes an attendance row, so anything already on screen
      // showing that event is now stale.
      if (status === 'approved') {
        loadEvents(); loadStats();
        if (expanded === req.event_id) await loadDetail(req.event_id).catch(() => {});
        else setDetail((d) => { const n = { ...d }; delete n[req.event_id]; return n; });
      }
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
        <p className="text-sm text-ash">Snap a voice channel to log who showed up. Set a title and date, then save.</p>
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

      {/* ── Snap section ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-14">
        <div className="lg:col-span-2">
          <div className="flex flex-wrap items-end gap-3 mb-5">
            <div className="flex-1 min-w-[180px]">
              <label className="eyebrow text-[10px] text-ash block mb-2">Voice channel</label>
              <div className="flex gap-2">
                <select
                  value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}
                  className="flex-1 bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
                >
                  <option value="">— select channel —</option>
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name} ({ch.memberCount} in channel)
                    </option>
                  ))}
                </select>
                <button onClick={loadChannels} className="p-2.5 text-ash hover:text-brass" title="Refresh channels">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>
            <button
              onClick={snap} disabled={!selectedChannel}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Camera className="w-4 h-4" /> Snap
            </button>
          </div>

          {snapped.length > 0 && (
            <div className="panel rounded-lg p-4">
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

        <div className="space-y-4">
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Scheduled event</label>
            <select
              value={eventScheduleId} onChange={(e) => selectScheduleEvent(e.target.value)}
              className="w-full bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
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
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Event title</label>
            <input
              value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Archboss — Morokai"
              className="w-full bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Event date</label>
            <input
              type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)}
              className="w-full bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Party fielded</label>
            <select
              value={rosterId} onChange={(e) => setRosterId(e.target.value)}
              className="w-full bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
            >
              <option value="auto">— match this night automatically —</option>
              <option value="">— no party —</option>
              {rosters.map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.event_date ? ` (${r.event_date})` : ''}</option>
              ))}
            </select>
            <p className="text-ash/50 text-xs mt-1">A copy is stored on the event, so editing the saved party later won't change this record.</p>
          </div>
          <button
            onClick={save} disabled={saving || snapped.length === 0}
            className="w-full px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : `Save event (${snapped.length} attendees)`}
          </button>
        </div>
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

      {/* ── Past events + Attendance sidebar ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Event list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-display text-2xl text-bone tracking-[0.08em]">Past Events</h2>
            <button onClick={() => { loadEvents(); loadStats(); }} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <div className="rule-fade mb-4" />

          <Tabs
            variant="flat" active={window_} onChange={setWindow_}
            items={WINDOWS.map((w) => ({
              // Only the active tab can carry a count — the others' totals
              // aren't loaded, and a guessed number is worse than none.
              key: w.key,
              label: w.key === window_ ? `${w.label} (${events.length})` : w.label,
            }))}
          />

          {loadingEvents ? (
            <div className="py-16 text-center text-ash">Reading the rolls…</div>
          ) : events.length === 0 ? (
            <div className="py-16 text-center text-ash">
              {window_ === 'all' ? 'No events logged yet.' : `Nothing logged in the ${WINDOW_LABEL[window_]}.`}
            </div>
          ) : (
            <div className="panel rounded-lg divide-y divide-line">
              {events.map((ev) => {
                const isOpen = expanded === ev.id;
                const info = detail[ev.id];
                return (
                  <div key={ev.id}>
                    <button
                      onClick={() => toggleEvent(ev.id)}
                      className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-panelup transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-bone truncate">{ev.title}</div>
                        <div className="flex items-center gap-3 text-xs text-ash mt-1">
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="w-3 h-3" />
                            {ev.event_date ? new Date(ev.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date'}
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
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteEvent(ev.id); }}
                        className="text-ash hover:text-oxblood shrink-0 p-1" title="Delete event"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <ChevronDown className={`w-4 h-4 text-ash shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="px-5 pb-5 space-y-4">
                        {!info ? (
                          <div className="py-4 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
                        ) : info.rows.length === 0 ? (
                          <div className="py-4 text-center text-ash">No attendance recorded.</div>
                        ) : (
                          <>
                            <AttendanceTable rows={info.rows} />

                            {info.signup && (
                              <div className="flex items-center gap-2 text-xs text-ash">
                                <CalendarCheck className="w-3.5 h-3.5 text-brass" />
                                <span>
                                  {info.signup.counts.going} signed up{info.signup.capacity ? ` of ${info.signup.capacity}` : ''}
                                  {' · '}{info.attendees.length - (info.signup.walkIns?.length || 0)} of them turned up
                                  {info.signup.walkIns?.length > 0 && ` · ${info.signup.walkIns.length} walk-in${info.signup.walkIns.length === 1 ? '' : 's'}`}
                                </span>
                              </div>
                            )}

                            {/* Decided requests, so an officer can see that
                                someone was turned down rather than only that
                                the queue is empty. */}
                            {info.lateRequests.filter((r) => r.status !== 'pending').length > 0 && (
                              <div className="text-xs text-ash space-y-0.5">
                                {info.lateRequests.filter((r) => r.status !== 'pending').map((r) => (
                                  <div key={r.id}>
                                    <span className={r.status === 'approved' ? 'text-emerald-400' : 'text-oxblood'}>
                                      {r.status === 'approved' ? 'Approved' : 'Denied'}
                                    </span>
                                    {' '}late attendance for <span className="text-bone">{r.display_name}</span>
                                    {r.decided_by && ` — ${r.decided_by}`}
                                  </div>
                                ))}
                              </div>
                            )}

                            {info.party && <PartyBlock party={info.party} />}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Attendance rate sidebar */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="panel rounded-lg p-4">
            <div className="eyebrow text-[10px] text-brass flex items-center gap-2 mb-1">
              <BarChart3 className="w-3.5 h-3.5" /> Attendance Rate
            </div>
            {/* The window is named here, not just in the tab above, because a
                percentage read out of context is assumed to be all-time. */}
            <div className="text-xs text-ash mb-4">
              {stats.totalEvents} event{stats.totalEvents === 1 ? '' : 's'} · {WINDOW_LABEL[window_]}
            </div>

            {loadingStats ? (
              <div className="py-8 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
            ) : sortedStats.length === 0 ? (
              <p className="text-ash text-sm py-4">No attendance in this window.</p>
            ) : (
              <>
                <div className="flex items-center gap-1 text-[10px] eyebrow text-ash mb-2 px-1">
                  <button onClick={() => toggleStatSort('name')} className="flex-1 text-left hover:text-bone flex items-center gap-1">
                    Member {statSort === 'name' && (statDir === 'asc' ? <ArrowUp className="w-2.5 h-2.5 text-brass" /> : <ArrowDown className="w-2.5 h-2.5 text-brass" />)}
                  </button>
                  <button onClick={() => toggleStatSort('attended')} className="w-10 text-right hover:text-bone flex items-center justify-end gap-0.5">
                    # {statSort === 'attended' && (statDir === 'asc' ? <ArrowUp className="w-2.5 h-2.5 text-brass" /> : <ArrowDown className="w-2.5 h-2.5 text-brass" />)}
                  </button>
                  <button onClick={() => toggleStatSort('rate')} className="w-12 text-right hover:text-bone flex items-center justify-end gap-0.5">
                    Rate {statSort === 'rate' && (statDir === 'asc' ? <ArrowUp className="w-2.5 h-2.5 text-brass" /> : <ArrowDown className="w-2.5 h-2.5 text-brass" />)}
                  </button>
                </div>
                <div className="space-y-1 max-h-[560px] overflow-auto pr-1">
                  {sortedStats.map((m) => (
                    <div key={m.discord_id} className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-panelup transition-colors">
                      <span className="text-sm text-bone truncate flex-1">{m.display_name}</span>
                      <span className="font-mono text-xs text-ash w-10 text-right shrink-0">{m.attended}/{stats.totalEvents}</span>
                      <span className={`font-mono text-xs w-12 text-right shrink-0 ${m.rate >= 75 ? 'text-emerald-400' : m.rate >= 40 ? 'text-brassbright' : 'text-oxblood'}`}>
                        {m.rate}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
