import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { CalendarDays, Check, Clock, Loader2, Hourglass, X, ThumbsDown } from 'lucide-react';
import { fmtDatetime } from '../timeUtils';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import Button from '../components/ui/Button';

// ── WHAT THIS PAGE IS ───────────────────────────────────────────────────────
// A member's own attendance, and the one thing they can do about it: ask to be
// added to a night the snapshot missed.
//
// Not under /admin, and it sits beside Signups and LOA in the sidebar on
// purpose — those three are the whole of "will you be there / were you there"
// from a member's side. Officers decide these requests on /admin/attendance;
// nothing on this page writes an attendance record.
//
// The 24-hour window is enforced server-side and merely DISPLAYED here. The
// button disappearing is a courtesy, not the check.

// "3h left" / "45m left". Rounded down: a window shown as an hour that closes
// in fifty minutes is worse than the reverse.
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'closing now';
  const mins = Math.floor(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h left` : `${mins}m left`;
}

function StatusLine({ ev }) {
  if (ev.attended) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
        <Check className="w-3.5 h-3.5" />
        Attended
        {ev.late && <span className="text-brass text-xs">(added late)</span>}
        <span className="text-ash text-xs">· {fmtDatetime(ev.joined_at)}</span>
      </span>
    );
  }
  const req = ev.request;
  if (req?.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-brass">
        <Hourglass className="w-3.5 h-3.5" /> Waiting on an officer
      </span>
    );
  }
  if (req?.status === 'denied') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-oxblood">
        <ThumbsDown className="w-3.5 h-3.5" /> Request declined
      </span>
    );
  }
  return <span className="text-sm text-ash">Not on the list</span>;
}

export default function MyAttendance() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [asking, setAsking] = useState(null); // event id the reason box is open for
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    axios.get('/api/attendance/mine')
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your attendance.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const fileRequest = async (ev) => {
    setBusy(ev.id);
    try {
      await axios.post('/api/attendance/late', { event_id: ev.id, reason: reason.trim() || null });
      flash('Asked. An officer will approve or deny it — you\'ll get a DM either way.');
      setAsking(null); setReason('');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not file that request.', false);
      // The window may have closed, or an officer may have added you already —
      // either way what's on screen is out of date.
      if (err.response?.status === 409 || err.response?.status === 400) load();
    } finally {
      setBusy('');
    }
  };

  const withdraw = async (ev) => {
    setBusy(ev.id);
    try {
      await axios.delete(`/api/attendance/late/${ev.request.id}`);
      flash('Withdrawn.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not withdraw that request.', false);
      load();
    } finally {
      setBusy('');
    }
  };

  return (
    <PageShell maxWidth="max-w-3xl">
      <h1 className="font-display text-3xl text-bone tracking-[0.08em]">My Attendance</h1>
      <p className="text-sm text-ash mt-2">
        Every night attendance was taken in the last 30 days. If you were there but aren't on the list,
        you can ask an officer to add you — for 24 hours after attendance was taken.
      </p>
      <div className="rule-fade my-6" />

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading ? (
        <EmptyState>Reading the rolls…</EmptyState>
      ) : events.length === 0 ? (
        <EmptyState>No attendance has been taken in the last 30 days.</EmptyState>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {events.map((ev) => (
            <div key={ev.id} className="px-5 py-4">
              <div className="flex items-start gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  {/* Straight through to the full roll for that night — this
                      list answers "was I counted", the event page answers
                      "who else was". */}
                  <Link to={`/attendance/${ev.id}`} className="font-medium text-bone hover:text-brass transition-colors">
                    {ev.title}
                  </Link>
                  <div className="flex items-center gap-3 text-xs text-ash mt-1">
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="w-3 h-3" />
                      {ev.event_date
                        ? new Date(`${ev.event_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : 'No date'}
                    </span>
                  </div>
                  <div className="mt-2"><StatusLine ev={ev} /></div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {ev.can_request && (
                    <div className="text-right">
                      {asking !== ev.id && (
                        <Button size="sm" variant="secondary" onClick={() => { setAsking(ev.id); setReason(''); }}>
                          Request late attendance
                        </Button>
                      )}
                      {/* The deadline, stated where the decision is made.
                          "24 hours" in the blurb above is a rule; this is the
                          number that tells someone whether to act now — so it
                          stays on screen while the reason box is open, which is
                          exactly when someone is deciding whether to bother. */}
                      <div className="text-[10px] text-ash mt-1 flex items-center justify-end gap-1">
                        <Clock className="w-2.5 h-2.5" /> {timeLeft(ev.window_closes_at)}
                      </div>
                    </div>
                  )}
                  {ev.request?.status === 'pending' && (
                    <Button size="sm" variant="neutral" disabled={busy === ev.id}
                      onClick={() => withdraw(ev)} icon={<X className="w-3.5 h-3.5" />}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </div>

              {asking === ev.id && (
                <div className="mt-4 border-t border-line pt-4 space-y-3">
                  <label className="eyebrow text-[10px] text-ash block">Anything that helps an officer decide (optional)</label>
                  <input
                    value={reason} onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                    placeholder="e.g. joined comms at 9:05, Discord dropped me mid-fight"
                    className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
                  />
                  <div className="flex items-center gap-3">
                    <Button size="sm" onClick={() => fileRequest(ev)} disabled={busy === ev.id}
                      icon={busy === ev.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}>
                      Send request
                    </Button>
                    <Button size="sm" variant="neutral" onClick={() => { setAsking(null); setReason(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
