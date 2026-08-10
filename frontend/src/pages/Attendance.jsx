import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, Camera, Trash2, ChevronDown, Users, CalendarDays, Loader2, ArrowUp, ArrowDown, BarChart3, Wand2, CalendarCheck, UserPlus } from 'lucide-react';
import { fmtTimeEst, guildDayOfWeek, isAfterMidnight } from '../timeUtils';
import RestrictedGate from '../components/ui/RestrictedGate';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const LOA_TYPE_LABEL = { event: 'Out this event', range: 'Away (date range)', recurring: 'Out weekly' };

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

function NameGroup({ label, tone, children }) {
  return (
    <div>
      <div className={`eyebrow text-[10px] mb-2 ${tone}`}>{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function NameChip({ children, className = '', title }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1.5 text-sm bg-hall border rounded-full px-3 py-1 ${className || 'border-line text-ash'}`}>
      {children}
    </span>
  );
}

export default function Attendance() {
  const { user, can } = useAuth();

  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [snapped, setSnapped] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});

  const [stats, setStats] = useState({ totalEvents: 0, members: [] });
  const [loadingStats, setLoadingStats] = useState(true);
  const [statSort, setStatSort] = useState('rate'); // 'rate' | 'name' | 'attended'
  const [statDir, setStatDir] = useState('desc');
  const [backfilling, setBackfilling] = useState(false);

  const loadChannels = () => {
    axios.get('/api/admin/voice-channels')
      .then((res) => setChannels(res.data.channels || []))
      .catch(() => setChannels([]));
  };

  const loadEvents = () => {
    setLoadingEvents(true);
    axios.get('/api/admin/events')
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load events.'))
      .finally(() => setLoadingEvents(false));
  };

  const loadStats = () => {
    setLoadingStats(true);
    axios.get('/api/admin/attendance-stats')
      .then((res) => setStats(res.data || { totalEvents: 0, members: [] }))
      .catch(() => {})
      .finally(() => setLoadingStats(false));
  };

  const loadSchedule = () => {
    axios.get('/api/event-schedule')
      .then((res) => setSchedule(res.data.schedule || []))
      .catch(() => setSchedule([]));
  };

  useEffect(() => { loadChannels(); loadEvents(); loadStats(); loadSchedule(); }, []);

  if (!can('attendance')) {
    return <RestrictedGate />;
  }

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

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
      });
      flash(`Saved — ${res.data.attendees} attendees logged.`);
      setSnapped([]); setTitle(''); setEventDate(''); setEventScheduleId('');
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

  const toggleEvent = async (id) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (detail[id]) return;
    try {
      const res = await axios.get(`/api/admin/events/${id}`);
      // absences is best-effort server-side (needs a dated event and Discord),
      // so it may be null even when attendees loaded fine. `signup` is null
      // whenever nobody opened signups for that occurrence, which is most of
      // the historical log — the section simply doesn't render.
      setDetail((d) => ({
        ...d,
        [id]: {
          attendees: res.data.attendees || [],
          absences: res.data.absences || null,
          signup: res.data.signup || null,
        },
      }));
    } catch {
      flash('Could not load attendees.', false);
      setExpanded(null);
    }
  };

  const sortedStats = useMemo(() => {
    const dir = statDir === 'asc' ? 1 : -1;
    return [...stats.members].sort((a, b) => {
      if (statSort === 'name') return a.display_name.localeCompare(b.display_name) * dir;
      return ((a[statSort] || 0) - (b[statSort] || 0)) * dir;
    });
  }, [stats.members, statSort, statDir]);

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
          <button
            onClick={save} disabled={saving || snapped.length === 0}
            className="w-full px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : `Save event (${snapped.length} attendees)`}
          </button>
        </div>
      </div>

      {/* ── Past events + Attendance sidebar ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Event list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-display text-2xl text-bone tracking-[0.08em]">Past Events</h2>
            <button onClick={loadEvents} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <div className="rule-fade mb-6" />

          {loadingEvents ? (
            <div className="py-16 text-center text-ash">Reading the rolls…</div>
          ) : events.length === 0 ? (
            <div className="py-16 text-center text-ash">No events logged yet.</div>
          ) : (
            <div className="panel rounded-lg divide-y divide-line">
              {events.map((ev) => {
                const isOpen = expanded === ev.id;
                const info = detail[ev.id];
                const attendees = info?.attendees;
                const absences = info?.absences;
                const signup = info?.signup;
                // Turned up without signing up. Marked on the attendee chip
                // rather than pulled into a group of its own — they came, which
                // is the thing that matters; the marker only shows how much of
                // the turnout the signup list actually predicted.
                const walkIns = new Set(signup?.walkIns || []);
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
                      <div className="px-5 pb-4 space-y-4">
                        {!attendees ? (
                          <div className="py-4 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
                        ) : (
                          <>
                            {attendees.length === 0 ? (
                              <div className="py-4 text-center text-ash">No attendees recorded.</div>
                            ) : (
                              <NameGroup label={`Attended (${attendees.length})`} tone="text-ash">
                                {attendees.map((a) => (
                                  <NameChip key={a.id}
                                    title={walkIns.has(a.discord_id) ? 'Walk-in — turned up without signing up' : undefined}
                                    className={walkIns.has(a.discord_id) ? 'border-line text-ash' : ''}>
                                    {a.display_name}
                                    {walkIns.has(a.discord_id) && <UserPlus className="w-3 h-3 text-brass/70" />}
                                  </NameChip>
                                ))}
                              </NameGroup>
                            )}

                            {/* Ranked above the generic no-LOA group below,
                                because it's a stronger signal: someone who never
                                answered may not have seen the post, where
                                someone who clicked "I'm in" made a commitment.
                                This is the whole payoff of keeping signups and
                                attendance as two records that get joined rather
                                than one that gets overwritten. */}
                            {signup?.signedUpNoShow?.length > 0 && (
                              <NameGroup
                                label={`Signed up, didn't show (${signup.signedUpNoShow.length})`}
                                tone="text-oxblood"
                              >
                                {signup.signedUpNoShow.map((m) => (
                                  <NameChip key={m.discord_id} className="border-oxblood/60 text-bone"
                                    title={m.loa ? `Filed an LOA after signing up — ${loaReason(m.loa)}` : 'Declared attendance but was not in the channel'}>
                                    {m.display_name}
                                    {m.loa && <span className="text-brass text-[10px]">LOA</span>}
                                  </NameChip>
                                ))}
                              </NameGroup>
                            )}

                            {signup && (
                              <div className="flex items-center gap-2 text-xs text-ash">
                                <CalendarCheck className="w-3.5 h-3.5 text-brass" />
                                <span>
                                  {signup.counts.going} signed up{signup.capacity ? ` of ${signup.capacity}` : ''}
                                  {' · '}{attendees.length - walkIns.size} of them turned up
                                  {walkIns.size > 0 && ` · ${walkIns.size} walk-in${walkIns.size === 1 ? '' : 's'}`}
                                </span>
                              </div>
                            )}

                            {/* Absences are only computable for a dated event,
                                and only worth showing when someone is missing. */}
                            {absences?.excused.length > 0 && (
                              <NameGroup label={`Excused — LOA on file (${absences.excused.length})`} tone="text-brass">
                                {absences.excused.map((m) => (
                                  <NameChip key={m.discord_id} title={loaReason(m.loa)} className="border-brass/30 text-brass">
                                    {m.display_name}
                                  </NameChip>
                                ))}
                              </NameGroup>
                            )}
                            {absences?.unexcused.length > 0 && (
                              <NameGroup label={`No-show — no LOA filed (${absences.unexcused.length})`} tone="text-oxblood">
                                {absences.unexcused.map((m) => (
                                  <NameChip key={m.discord_id} className="border-oxblood/40 text-bone">
                                    {m.display_name}
                                  </NameChip>
                                ))}
                              </NameGroup>
                            )}
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
            <div className="text-xs text-ash mb-4">
              {stats.totalEvents} event{stats.totalEvents === 1 ? '' : 's'} tracked
            </div>

            {loadingStats ? (
              <div className="py-8 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
            ) : sortedStats.length === 0 ? (
              <p className="text-ash text-sm py-4">No attendance data yet.</p>
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
