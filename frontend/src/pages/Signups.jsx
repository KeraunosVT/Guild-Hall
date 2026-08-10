import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import {
  CalendarCheck, Check, X, Users, Clock, Send, Trash2, Bell, Plus, Settings,
  ChevronDown, AlertTriangle, Loader2, Shield, Swords, Heart, HelpCircle,
} from 'lucide-react';
import { useAuth } from '../auth';
import { PageShell } from '../components/ui/PageShell';
import Tabs from '../components/ui/Tabs';
import Button from '../components/ui/Button';
import Toast from '../components/ui/Toast';
import EmptyState from '../components/ui/EmptyState';
import { useFlash } from '../components/ui/useFlash';
import { fmtDatetime, fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight } from '../timeUtils';

// ── THE ONE THING TO KNOW ABOUT THIS PAGE ───────────────────────────────────
// Nothing here says "declined", and nothing here can. A signup row means "I'm
// coming"; the absence of one means UNDECIDED, not "not coming". Saying no is
// the LOA page's job, and it is linked from every place a member might want to.
//
// So the vocabulary is deliberately one-directional: "I'm in" / "Withdraw", and
// the group of people with no entry is called "No response", never "Not coming".
// If a future edit is tempted to add a decline button here, the database will
// refuse the write — see the check constraint in the signups migration.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ROLE_META = [
  { key: 'Tank', icon: Shield, tone: 'text-sky-400' },
  { key: 'DPS', icon: Swords, tone: 'text-oxblood' },
  { key: 'Healer', icon: Heart, tone: 'text-emerald-400' },
];

function Chip({ children, className = '', title, onRemove }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1.5 text-sm bg-hall border rounded-full px-3 py-1 ${className || 'border-line text-ash'}`}>
      {children}
      {onRemove && (
        <button onClick={onRemove} className="text-ash hover:text-oxblood" title="Remove from this signup">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// Tank / DPS / Healer, plus the group that has no role on file. The last one is
// shown even when the others are empty and is never folded into DPS: those are
// exactly the members a party seed would drop, and the count is the prompt to go
// and set their role.
function Composition({ composition, className = '' }) {
  const c = composition || { Tank: 0, DPS: 0, Healer: 0, unknown: 0 };
  return (
    <div className={`flex items-center gap-3 text-xs ${className}`}>
      {ROLE_META.map(({ key, icon: Icon, tone }) => (
        <span key={key} className={`inline-flex items-center gap-1 ${tone}`} title={key}>
          <Icon className="w-3.5 h-3.5" /> {c[key] || 0}
        </span>
      ))}
      <span
        className={`inline-flex items-center gap-1 ${c.unknown ? 'text-brass' : 'text-ash/40'}`}
        title="Signed up with no role on file — a party seed would skip these"
      >
        <HelpCircle className="w-3.5 h-3.5" /> {c.unknown || 0}
      </span>
    </div>
  );
}

function RoleGroups({ going, canRemove, onRemove }) {
  const noRole = going.filter((e) => !e.role);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {ROLE_META.map(({ key, icon: Icon, tone }) => {
        const list = going.filter((e) => e.role === key);
        return (
          <div key={key}>
            <div className={`eyebrow text-[10px] mb-2 flex items-center gap-1.5 ${tone}`}>
              <Icon className="w-3.5 h-3.5" /> {key} ({list.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {list.length === 0
                ? <span className="text-ash/40 text-xs">—</span>
                : list.map((e) => (
                  <Chip key={e.id}
                    title={e.added_by ? `Added by ${e.added_by}` : undefined}
                    onRemove={canRemove ? () => onRemove(e.discord_id) : undefined}>
                    {e.display_name}
                  </Chip>
                ))}
            </div>
          </div>
        );
      })}
      {noRole.length > 0 && (
        <div className="sm:col-span-3">
          <div className="eyebrow text-[10px] mb-2 text-brass flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5" /> No role on file ({noRole.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {noRole.map((e) => (
              <Chip key={e.id} className="border-brass/30 text-brass"
                onRemove={canRemove ? () => onRemove(e.discord_id) : undefined}>
                {e.display_name}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Signups() {
  const { user, can } = useAuth();
  const officer = can('attendance');

  const [signups, setSignups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [tab, setTab] = useState('upcoming');
  const [expanded, setExpanded] = useState(() => new Set());
  const [busyId, setBusyId] = useState(null);

  // Officer: the "open signups" form, and the member list the on-behalf picker
  // resolves against.
  const [showOpen, setShowOpen] = useState(false);
  const [schedule, setSchedule] = useState([]);
  const [members, setMembers] = useState([]);
  const [newDate, setNewDate] = useState(todayInGuildTz);
  const [newEventId, setNewEventId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newCapacity, setNewCapacity] = useState('');
  const [newReminder, setNewReminder] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/signups')
      .then((res) => setSignups(res.data.signups || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load signups.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    axios.get('/api/event-schedule').then((res) => setSchedule(res.data.schedule || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!officer) return;
    axios.get('/api/admin/members').then((res) => setMembers(res.data.members || [])).catch(() => {});
  }, [officer]);

  const eventsOnDate = useMemo(() => {
    if (!newDate) return [];
    return eventsForGuildDay(schedule, new Date(`${newDate}T12:00:00`).getDay());
  }, [newDate, schedule]);

  const mine = useMemo(() => signups.filter((s) => s.mine), [signups]);
  const shown = tab === 'mine' ? mine : signups;

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Every mutation re-loads rather than patching state in place. The server is
  // the authority on waitlist order and promotions — a withdrawal can move
  // somebody else up — and reproducing that arithmetic here is how the page
  // starts disagreeing with the Discord post about who actually has a slot.
  const act = async (id, fn, okText) => {
    setBusyId(id);
    try {
      const res = await fn();
      if (okText) flash(typeof okText === 'function' ? okText(res?.data) : okText);
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'That didn\'t work.', false);
    } finally {
      setBusyId(null);
    }
  };

  const join = (s) => act(s.id, () => axios.post(`/api/signups/${s.id}/join`), (d) =>
    d?.status === 'waitlist' ? `You're on the waitlist — #${d.position}.` : "You're in.");

  const withdraw = (s) => act(s.id, () => axios.delete(`/api/signups/${s.id}/join`),
    'Withdrawn — you\'re back to undecided.');

  const removeEntry = (s, discordId) => act(s.id,
    () => axios.delete(`/api/signups/${s.id}/entries/${discordId}`), 'Removed.');

  const addMember = (s, m) => act(s.id,
    () => axios.post(`/api/signups/${s.id}/join`, { discord_id: m.id, display_name: m.name }),
    `Added ${m.name}.`);

  const setCapacity = (s, value) => act(s.id,
    () => axios.patch(`/api/signups/${s.id}`, { capacity: value === '' ? null : Number(value) }),
    (d) => (d?.promoted ? `Capacity updated — ${d.promoted} promoted from the waitlist.` : 'Capacity updated.'));

  const setReminder = (s, value) => act(s.id,
    () => axios.patch(`/api/signups/${s.id}`, { reminder_lead_minutes: value === '' ? null : Number(value) }),
    'Reminder updated.');

  const close = (s) => act(s.id, () => axios.post(`/api/signups/${s.id}/close`), 'Signups closed.');
  const repost = (s) => act(s.id, () => axios.post(`/api/signups/${s.id}/post`), 'Posted to Discord.');
  const remind = (s) => act(s.id, () => axios.post(`/api/signups/${s.id}/remind`),
    (d) => `Reminding ${d?.sending ?? 0} member${d?.sending === 1 ? '' : 's'} with no answer and no LOA.`);

  const del = (s) => {
    if (!window.confirm(`Delete signups for "${s.title}"? Everyone's answers go with it.`)) return;
    act(s.id, () => axios.delete(`/api/signups/${s.id}`), 'Signup deleted.');
  };

  const pickEvent = (id) => {
    setNewEventId(id);
    const ev = schedule.find((s) => s.id === id);
    if (ev) { setNewTitle(ev.name); setNewTime(''); }
  };

  const create = async () => {
    if (!newDate || (!newEventId && (!newTitle.trim() || !newTime))) {
      flash('Pick a scheduled event, or give a title and a start time.', false);
      return;
    }
    setCreating(true);
    try {
      await axios.post('/api/signups', {
        event_schedule_id: newEventId || null,
        event_date: newDate,
        start_time: newTime || null,
        title: newTitle.trim() || undefined,
        capacity: newCapacity === '' ? null : Number(newCapacity),
        reminder_lead_minutes: newReminder === '' ? null : Number(newReminder),
      });
      flash('Signups opened and posted to Discord.');
      setNewEventId(''); setNewTitle(''); setNewTime(''); setNewCapacity(''); setNewReminder('');
      setShowOpen(false);
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not open signups.', false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <PageShell maxWidth="max-w-5xl">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <p className="text-sm text-ash">
          Say you're coming. Not signing up isn't the same as saying no —{' '}
          <a href="/loa" className="text-brass hover:text-brassbright">file an LOA</a> if you can't make it.
        </p>
        {officer && (
          <button onClick={() => setShowOpen((v) => !v)}
            className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors shrink-0">
            <Settings className="w-4 h-4" /> {showOpen ? 'Close' : 'Open signups'}
          </button>
        )}
      </div>

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {officer && showOpen && (
        <div className="mb-8 panel rounded-lg p-6">
          <div className="eyebrow text-brass text-[10px] mb-4">Open signups for an occurrence</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">Date</label>
              <input type="date" value={newDate} onChange={(e) => { setNewDate(e.target.value); setNewEventId(''); }}
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              <p className="text-ash/50 text-xs mt-1">The guild night — an after-midnight event belongs to the evening before it.</p>
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">Scheduled event</label>
              <select value={newEventId} onChange={(e) => pickEvent(e.target.value)}
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                <option value="">— one-off / custom —</option>
                {eventsOnDate.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.event_time ? ` — ${fmtTimeEst(s.event_time)}` : ''}
                    {isAfterMidnight(s.event_time) ? ` (${DAYS[s.day_of_week].slice(0, 3)})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">Title</label>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Archboss — Morokai"
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">
                Start time <span className="text-ash/50">{newEventId ? '(optional — defaults to the schedule)' : '(required)'}</span>
              </label>
              <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)}
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">Capacity <span className="text-ash/50">(optional)</span></label>
              <input type="number" min="1" value={newCapacity} onChange={(e) => setNewCapacity(e.target.value)} placeholder="No cap"
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              <p className="text-ash/50 text-xs mt-1">Over the cap goes to a waitlist that promotes itself when someone withdraws.</p>
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-2">Remind <span className="text-ash/50">(minutes before, optional)</span></label>
              <input type="number" min="1" value={newReminder} onChange={(e) => setNewReminder(e.target.value)} placeholder="No reminder"
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              <p className="text-ash/50 text-xs mt-1">DMs only members with no answer and no LOA on file.</p>
            </div>
          </div>
          <button onClick={create} disabled={creating}
            className="mt-5 inline-flex items-center gap-2 px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
            <Plus className="w-4 h-4" /> {creating ? 'Opening…' : 'Open and post'}
          </button>
        </div>
      )}

      <Tabs variant="flat" active={tab} onChange={setTab}
        items={[{ key: 'upcoming', label: `Upcoming (${signups.length})` }, { key: 'mine', label: `Mine (${mine.length})` }]} />

      {loading ? (
        <EmptyState>Reading the rolls…</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState>{tab === 'mine' ? "You haven't signed up for anything yet." : 'No signups are open right now.'}</EmptyState>
      ) : (
        <div className="space-y-4">
          {shown.map((s) => (
            <SignupCard
              key={s.id} signup={s} officer={officer} members={members}
              open={expanded.has(s.id)} onToggle={() => toggle(s.id)}
              busy={busyId === s.id}
              onJoin={() => join(s)} onWithdraw={() => withdraw(s)}
              onRemoveEntry={(id) => removeEntry(s, id)} onAddMember={(m) => addMember(s, m)}
              onCapacity={(v) => setCapacity(s, v)} onReminder={(v) => setReminder(s, v)}
              onClose={() => close(s)} onRepost={() => repost(s)} onRemind={() => remind(s)} onDelete={() => del(s)}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function SignupCard({
  signup: s, officer, members, open, onToggle, busy,
  onJoin, onWithdraw, onRemoveEntry, onAddMember,
  onCapacity, onReminder, onClose, onRepost, onRemind, onDelete,
}) {
  const [capacityDraft, setCapacityDraft] = useState(s.capacity ?? '');
  const [reminderDraft, setReminderDraft] = useState(s.reminder_lead_minutes ?? '');
  const [addQuery, setAddQuery] = useState('');

  useEffect(() => { setCapacityDraft(s.capacity ?? ''); }, [s.capacity]);
  useEffect(() => { setReminderDraft(s.reminder_lead_minutes ?? ''); }, [s.reminder_lead_minutes]);

  const closed = s.status !== 'open';
  const full = s.capacity !== null && s.counts.going >= s.capacity;

  const addSuggestions = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    if (!q) return [];
    const already = new Set(s.entries.map((e) => String(e.discord_id)));
    return members.filter((m) => !already.has(String(m.id)) && m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [addQuery, members, s.entries]);

  return (
    <div className="panel rounded-lg overflow-hidden">
      <div className="flex items-start gap-4 px-5 py-4 flex-wrap">
        <button onClick={onToggle} className="min-w-0 flex-1 text-left group">
          <div className="flex items-center gap-2">
            <ChevronDown className={`w-4 h-4 shrink-0 text-ash transition-transform group-hover:text-brass ${open ? 'rotate-180' : ''}`} />
            <span className="font-medium text-bone truncate">{s.title}</span>
            {closed && <span className="eyebrow text-[10px] text-ash border border-line rounded-full px-2 py-0.5 shrink-0">Closed</span>}
          </div>
          <div className="flex items-center gap-3 text-xs text-ash mt-1 ml-6 flex-wrap">
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDatetime(s.starts_at)}</span>
            <span className="inline-flex items-center gap-1">
              <Users className="w-3 h-3" /> {s.counts.going}{s.capacity ? `/${s.capacity}` : ''} in
            </span>
            {s.counts.waitlist > 0 && <span className="text-brass">{s.counts.waitlist} waitlisted</span>}
            <Composition composition={s.composition} />
          </div>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          {s.mine ? (
            <>
              <span className={`text-xs ${s.mine.status === 'waitlist' ? 'text-brass' : 'text-emerald-400'}`}>
                {s.mine.status === 'waitlist' ? `Waitlist #${s.mine.position}` : "You're in"}
              </span>
              <Button variant="neutral" size="none" className="px-3 py-1.5 text-xs border border-line rounded-lg"
                onClick={onWithdraw} disabled={busy} title="Back to undecided — this does not file an absence">
                Withdraw
              </Button>
            </>
          ) : (
            <Button size="none" className="px-4 py-1.5 text-sm" onClick={onJoin} disabled={busy || closed}
              title={closed ? 'Signups are closed' : full ? 'Full — you\'ll join the waitlist' : undefined}>
              <Check className="w-3.5 h-3.5" /> {full ? 'Join waitlist' : "I'm in"}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-line pt-4">
          {s.going.length === 0 ? (
            <p className="text-ash text-sm">Nobody has signed up yet.</p>
          ) : (
            <RoleGroups going={s.going} canRemove={officer} onRemove={onRemoveEntry} />
          )}

          {s.waitlist.length > 0 && (
            <div>
              <div className="eyebrow text-[10px] text-brass mb-2">Waitlist ({s.waitlist.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {s.waitlist.map((e) => (
                  <Chip key={e.id} className="border-brass/30 text-brass"
                    onRemove={officer ? () => onRemoveEntry(e.discord_id) : undefined}>
                    <span className="font-mono text-[10px] text-ash">#{e.position}</span> {e.display_name}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {/* ── Officer-only ───────────────────────────────────────────── */}
          {officer && (
            <div className="space-y-4 border-t border-line pt-4">
              {/* Signed up AND has an LOA on file. Surfaced, never auto-resolved:
                  both are real statements the member made, and which one wins
                  ("I filed for the 6pm but I'm here for the 9pm" vs "I forgot to
                  cancel") is a judgement call, not a rule. */}
              {s.conflicts?.length > 0 && (
                <div className="flex items-start gap-2 text-sm text-bone px-4 py-2.5 rounded-lg border border-brass/40 bg-panel">
                  <AlertTriangle className="w-4 h-4 text-brass shrink-0 mt-0.5" />
                  <span>
                    <span className="font-semibold">{s.conflicts.map((c) => c.display_name).join(', ')}</span>
                    {s.conflicts.length === 1 ? ' is' : ' are'} signed up but also{' '}
                    {s.conflicts.length === 1 ? 'has' : 'have'} an LOA on file for this occasion.
                  </span>
                </div>
              )}

              {s.unknown && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="eyebrow text-[10px] text-ash mb-2">
                      No response ({s.unknown.noResponse.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto">
                      {s.unknown.noResponse.length === 0
                        ? <span className="text-ash/40 text-xs">Everyone has answered.</span>
                        : s.unknown.noResponse.map((m) => <Chip key={m.discord_id}>{m.display_name}</Chip>)}
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow text-[10px] text-brass mb-2">
                      On LOA ({s.unknown.onLoa.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto">
                      {s.unknown.onLoa.length === 0
                        ? <span className="text-ash/40 text-xs">—</span>
                        : s.unknown.onLoa.map((m) => (
                          <Chip key={m.discord_id} className="border-brass/30 text-brass" title={m.loa?.reason || undefined}>
                            {m.display_name}
                          </Chip>
                        ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Add on someone's behalf — for the member who says it in voice
                  chat rather than clicking. Resolved against the roster, so free
                  text can never be submitted as a target. */}
              <div className="relative max-w-sm">
                <label className="eyebrow text-[10px] text-ash block mb-2">Add someone</label>
                <input value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="Search members…"
                  autoComplete="off"
                  className="w-full bg-hall border border-line rounded-lg px-4 py-2 text-sm text-bone focus:outline-none focus:border-brass" />
                {addSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-hall border border-line rounded-lg shadow-lg max-h-48 overflow-auto">
                    {addSuggestions.map((m) => (
                      <button key={m.id} type="button"
                        onClick={() => { onAddMember(m); setAddQuery(''); }}
                        className="w-full text-left px-4 py-2 text-sm text-bone hover:bg-panelup transition-colors">
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="eyebrow text-[10px] text-ash block mb-1.5">Capacity</label>
                  <div className="flex gap-1.5">
                    <input type="number" min="1" value={capacityDraft} onChange={(e) => setCapacityDraft(e.target.value)}
                      placeholder="No cap"
                      className="w-24 bg-hall border border-line rounded-lg px-3 py-1.5 text-sm text-bone focus:outline-none focus:border-brass" />
                    <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs" disabled={busy}
                      onClick={() => onCapacity(capacityDraft)}
                      title="Raising it promotes from the waitlist; lowering it never removes anyone who already has a slot">
                      Set
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="eyebrow text-[10px] text-ash block mb-1.5">Remind (min before)</label>
                  <div className="flex gap-1.5">
                    <input type="number" min="1" value={reminderDraft} onChange={(e) => setReminderDraft(e.target.value)}
                      placeholder="Off"
                      className="w-24 bg-hall border border-line rounded-lg px-3 py-1.5 text-sm text-bone focus:outline-none focus:border-brass" />
                    <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs" disabled={busy}
                      onClick={() => onReminder(reminderDraft)}>Set</Button>
                  </div>
                </div>
                <div className="flex-1" />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs" disabled={busy} onClick={onRemind}
                    title="DM everyone with no answer and no LOA. Only ever sends once per event, however many times this is pressed.">
                    <Bell className="w-3.5 h-3.5" /> Remind
                  </Button>
                  <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs" disabled={busy} onClick={onRepost}
                    title={s.message_id ? 'Post a fresh message (use if the old one was deleted)' : 'Not posted to Discord yet'}>
                    <Send className="w-3.5 h-3.5" /> {s.message_id ? 'Repost' : 'Post'}
                  </Button>
                  {!closed && (
                    <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs" disabled={busy} onClick={onClose}>
                      <CalendarCheck className="w-3.5 h-3.5" /> Close
                    </Button>
                  )}
                  <Button variant="destructive" size="none" className="px-3 py-1.5 text-xs" disabled={busy} onClick={onDelete}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                  {busy && <Loader2 className="w-4 h-4 animate-spin text-ash" />}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
