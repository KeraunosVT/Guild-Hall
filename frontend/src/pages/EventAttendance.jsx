import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import {
  ClipboardList, Info, Users, FileText, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Loader2, Check, X, Clock, UserPlus, Swords, ArrowLeft,
} from 'lucide-react';
import { useAuth } from '../auth';
import { fmtDatetime, fmtTimeEst } from '../timeUtils';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import EmptyState from '../components/ui/EmptyState';

// ── ONE NIGHT, IN FULL ──────────────────────────────────────────────────────
// Every member gets a row and exactly one status. Anyone who never answered at
// all drops into the "No Reply" table underneath rather than sitting in the
// main list as a wall of blanks — they are a different question ("did the post
// reach them") from the people who did respond.
//
// Member-visible with officer controls inline, same siting as Signups: reading
// the record is not an officer action, and the member's own "I was there" is on
// this page precisely because it is where they notice they are missing from it.

const STATUS_META = {
  attended: { label: 'Attended', className: 'border-emerald-400/40 text-emerald-400 bg-emerald-400/10' },
  pending: { label: 'Pending Approval', className: 'border-amber-400/50 text-amber-300 bg-amber-400/10' },
  noshow_signed: { label: "No-show (signed up)", className: 'border-oxblood/60 text-bone bg-oxblooddeep/30' },
  loa: { label: 'LOA', className: 'border-brass/40 text-brass bg-brass/10' },
  denied: { label: 'Request denied', className: 'border-line text-ash' },
  no_reply: { label: 'No Reply', className: 'border-oxblood/60 text-bone bg-oxblooddeep/40' },
};

// Same three colours the party builder uses (Parties.jsx ROLE_COLOR), so a
// Tank is the same blue wherever anyone sees one.
const ROLE_CLASS = { Tank: 'text-sky-400', DPS: 'text-oxblood', Healer: 'text-emerald-400' };

const PAGE_SIZES = [25, 50, 100];

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.no_reply;
  return (
    <span className={`inline-flex items-center text-[11px] font-medium border rounded-full px-2.5 py-0.5 whitespace-nowrap ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function RoleCell({ role, className }) {
  if (!role && !className) return <span className="text-ash/40">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className={ROLE_CLASS[role] || 'text-ash'}>{role || 'No role'}</span>
      {className && <span className="text-ash"> · {className}</span>}
    </span>
  );
}

function Avatar({ src, name }) {
  if (src) return <img src={src} alt="" className="w-6 h-6 rounded-full border border-line shrink-0" />;
  return (
    <span className="w-6 h-6 rounded-full bg-panelup border border-line flex items-center justify-center text-[10px] text-brass shrink-0">
      {(name || '?')[0].toUpperCase()}
    </span>
  );
}

function SortHead({ label, k, sort, dir, onSort, align = 'left' }) {
  const active = sort === k;
  return (
    <th
      onClick={() => onSort(k)}
      className={`p-3 font-normal cursor-pointer select-none hover:text-bone ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={active ? 'text-brass' : 'text-ash/30'}>{active && dir === 'desc' ? '↓' : '↑'}</span>
      </span>
    </th>
  );
}

export default function EventAttendance() {
  const { id } = useParams();
  const { can } = useAuth();
  const officer = can('attendance');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [tab, setTab] = useState('attendance');

  const [sort, setSort] = useState('username');
  const [dir, setDir] = useState('asc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    axios.get(`/api/attendance/events/${id}`)
      .then((res) => { setData(res.data); setSelected(new Set()); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load that event.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const list = [...((data && data.rows) || [])];
    const mult = dir === 'asc' ? 1 : -1;
    const byName = (a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''));
    // Timestamps sort with the empty ones pinned last in both directions —
    // absentees have no time, and letting null land wherever 0 falls buries the
    // rows that do have one.
    const byTime = (key) => (a, b) => {
      if (!a[key] && !b[key]) return 0;
      if (!a[key]) return 1;
      if (!b[key]) return -1;
      return (new Date(a[key]) - new Date(b[key])) * mult;
    };
    if (sort === 'username') list.sort((a, b) => byName(a, b) * mult);
    else if (sort === 'role') list.sort((a, b) => String(a.role || 'zz').localeCompare(String(b.role || 'zz')) * mult || byName(a, b));
    else if (sort === 'status') list.sort((a, b) => String(a.status).localeCompare(String(b.status)) * mult || byName(a, b));
    else if (sort === 'signed_up_at') list.sort(byTime('signed_up_at'));
    else if (sort === 'last_updated') list.sort(byTime('last_updated'));
    return list;
  }, [data, sort, dir]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageRows = useMemo(
    () => rows.slice(page * pageSize, page * pageSize + pageSize),
    [rows, page, pageSize],
  );

  // Clamp rather than reset: changing the page size while on page 4 of 4 should
  // land somewhere real, not throw the reader back to the top.
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [page, pageCount]);

  const onSort = (k) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir('asc'); }
  };

  const toggleRow = (discordId) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(discordId)) next.delete(discordId); else next.add(discordId);
    return next;
  });

  // Selects the page in view, not the whole table — a header checkbox that
  // silently selects four hundred rows you cannot see is how bulk mistakes are
  // made.
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.discord_id));
  const toggleAllOnPage = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allOnPage) pageRows.forEach((r) => next.delete(r.discord_id));
    else pageRows.forEach((r) => next.add(r.discord_id));
    return next;
  });

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.discord_id)),
    [rows, selected],
  );
  const pendingSelected = selectedRows.filter((r) => r.request_id);
  const absentSelected = selectedRows.filter((r) => r.status !== 'attended');
  const attendedSelected = selectedRows.filter((r) => r.status === 'attended');

  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); flash(done); load(); }
    catch (err) { flash(err.response?.data?.error || 'That did not work.', false); load(); }
    finally { setBusy(false); }
  };

  const decideSelected = (status) => run(
    () => Promise.all(pendingSelected.map((r) =>
      axios.patch(`/api/admin/attendance/late-requests/${r.request_id}`, { status }))),
    `${pendingSelected.length} request${pendingSelected.length === 1 ? '' : 's'} ${status}.`,
  );

  const markAttended = () => run(
    () => axios.post(`/api/admin/events/${id}/attendees`, { discord_ids: absentSelected.map((r) => r.discord_id) }),
    `${absentSelected.length} added to this night.`,
  );

  const removeAttended = () => run(
    () => Promise.all(attendedSelected.map((r) =>
      axios.delete(`/api/admin/events/${id}/attendees/${r.discord_id}`))),
    `${attendedSelected.length} removed from this night.`,
  );

  const fileRequest = () => run(
    () => axios.post('/api/attendance/late', { event_id: id, reason: reason.trim() || null })
      .then(() => { setAsking(false); setReason(''); }),
    "Asked. An officer will approve or deny it — you'll get a DM either way.",
  );

  if (loading) return <PageShell maxWidth="max-w-[1400px]"><EmptyState>Reading the roll…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-[1400px]">
        <div className="px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>
        <Link to="/attendance" className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright mt-4">
          <ArrowLeft className="w-4 h-4" /> Back to attendance
        </Link>
      </PageShell>
    );
  }

  const { event, no_reply: noReply, party, viewer, counts, signup } = data;
  const dateText = event.event_date
    ? new Date(`${event.event_date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'No date';

  const TABS = [
    { key: 'attendance', label: 'Attendance', icon: ClipboardList },
    { key: 'details', label: 'Details', icon: Info },
    { key: 'parties', label: 'Parties', icon: Users, hidden: !party },
  ].filter((t) => !t.hidden);

  return (
    <PageShell maxWidth="max-w-[1400px]">
      <Link to="/attendance" className="inline-flex items-center gap-1.5 text-xs text-ash hover:text-brass mb-4">
        <ArrowLeft className="w-3 h-3" /> Attendance
      </Link>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h1 className="font-display text-2xl text-bone tracking-[0.06em]">{event.title}</h1>
        <div className="text-sm text-ash whitespace-nowrap">
          {dateText}
          {event.event_time && <span> · {fmtTimeEst(event.event_time)}</span>}
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-line mt-4 mb-6 -mx-1 overflow-x-auto">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key} onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-brass text-bone' : 'border-transparent text-ash hover:text-bone'}`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      <Toast msg={msg} />

      {tab === 'attendance' && (
        <>
          {/* The member's own action, at the top where the mockup puts it. It
              only renders inside the 24h window — the deadline sits under it
              because "24 hours" is a rule and "3h left" is a decision. */}
          {viewer?.can_request && !asking && (
            <div className="mb-6">
              <Button onClick={() => setAsking(true)}>Request Late Attendance</Button>
              <div className="text-[10px] text-ash mt-1.5 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" /> closes {fmtDatetime(viewer.window_closes_at)}
              </div>
            </div>
          )}
          {asking && (
            <div className="mb-6 panel rounded-lg p-4 space-y-3 max-w-2xl">
              <label className="eyebrow text-[10px] text-ash block">Anything that helps an officer decide (optional)</label>
              <input
                value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
                placeholder="e.g. joined comms at 9:05, Discord dropped me mid-fight"
                className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
              />
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={fileRequest} disabled={busy}
                  icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}>Send request</Button>
                <Button size="sm" variant="neutral" onClick={() => { setAsking(false); setReason(''); }}>Cancel</Button>
              </div>
            </div>
          )}
          {viewer?.request?.status === 'pending' && (
            <div className="mb-6 text-sm text-brass inline-flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" /> Your late attendance request is waiting on an officer.
            </div>
          )}

          {/* ── Officer bulk bar ─────────────────────────────────────
              Appears only with a selection, and only offers actions that
              apply to what is actually selected — a greyed-out "Approve"
              beside four attended members is noise. */}
          {officer && selected.size > 0 && (
            <div className="mb-4 panel rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className="text-sm text-ash">{selected.size} selected</span>
              {pendingSelected.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => decideSelected('approved')}
                    icon={<Check className="w-3.5 h-3.5" />}>Approve {pendingSelected.length}</Button>
                  <Button size="sm" variant="neutral" disabled={busy} onClick={() => decideSelected('denied')}
                    icon={<X className="w-3.5 h-3.5" />}>Deny {pendingSelected.length}</Button>
                </>
              )}
              {absentSelected.length > 0 && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={markAttended}
                  icon={<UserPlus className="w-3.5 h-3.5" />}>Mark {absentSelected.length} attended</Button>
              )}
              {attendedSelected.length > 0 && (
                <Button size="sm" variant="destructive" disabled={busy} onClick={removeAttended}>
                  Remove {attendedSelected.length}
                </Button>
              )}
              <Button size="sm" variant="neutral" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          {/* ── The roll ─────────────────────────────────────────────── */}
          <div className="panel rounded-lg overflow-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead className="border-b border-line">
                <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">
                  {officer && (
                    <th className="p-3 w-10">
                      <input type="checkbox" checked={allOnPage} onChange={toggleAllOnPage}
                        title="Select everyone on this page" className="accent-brass cursor-pointer" />
                    </th>
                  )}
                  <th className="p-3 font-normal text-left w-12">#</th>
                  <SortHead label="Username" k="username" sort={sort} dir={dir} onSort={onSort} />
                  <SortHead label="Role" k="role" sort={sort} dir={dir} onSort={onSort} />
                  <SortHead label="Status" k="status" sort={sort} dir={dir} onSort={onSort} />
                  <SortHead label="Sign up date" k="signed_up_at" sort={sort} dir={dir} onSort={onSort} />
                  <SortHead label="Last updated" k="last_updated" sort={sort} dir={dir} onSort={onSort} />
                  <th className="p-3 font-normal text-left w-16">Note</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr key={r.discord_id}
                    className={`border-b border-line/60 hover:bg-panelup transition-colors ${selected.has(r.discord_id) ? 'bg-panelup' : ''}`}>
                    {officer && (
                      <td className="p-3">
                        <input type="checkbox" checked={selected.has(r.discord_id)}
                          onChange={() => toggleRow(r.discord_id)} className="accent-brass cursor-pointer" />
                      </td>
                    )}
                    <td className="p-3 text-ash tabular-nums">{page * pageSize + i + 1}</td>
                    <td className="p-3">
                      <span className="flex items-center gap-2">
                        <Avatar src={r.avatar} name={r.display_name} />
                        <span className="text-bone">{r.display_name}</span>
                        {r.walk_in && (
                          <span title="Turned up without signing up"
                            className="text-[10px] eyebrow border border-line rounded-full px-1.5 py-0.5 text-ash">Walk-in</span>
                        )}
                        {r.late && (
                          <span title="Added after the fact by an approved request"
                            className="text-[10px] eyebrow border border-brass/40 rounded-full px-1.5 py-0.5 text-brass">Late</span>
                        )}
                      </span>
                    </td>
                    <td className="p-3"><RoleCell role={r.role} className={r.class_name} /></td>
                    <td className="p-3"><StatusPill status={r.status} /></td>
                    <td className="p-3 text-ash text-xs whitespace-nowrap">
                      {r.signed_up_at ? fmtDatetime(r.signed_up_at) : <span className="text-ash/40">—</span>}
                    </td>
                    <td className="p-3 text-ash text-xs whitespace-nowrap">
                      {r.last_updated ? fmtDatetime(r.last_updated) : <span className="text-ash/40">—</span>}
                    </td>
                    <td className="p-3">
                      {/* Officers only. The statuses are guild-visible; the free
                          text behind them is written to officers. */}
                      {r.note
                        ? <FileText className="w-4 h-4 text-brass cursor-help" title={r.note} />
                        : <FileText className="w-4 h-4 text-ash/20" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Table footer ─────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-4 flex-wrap mt-3 text-xs text-ash">
            <span>{officer ? `${selected.size} of ${rows.length} row(s) selected.` : `${rows.length} member${rows.length === 1 ? '' : 's'}`}</span>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                Rows per page
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                  className="bg-hall border border-line rounded px-2 py-1 text-bone focus:outline-none focus:border-brass">
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <span className="whitespace-nowrap">Page {page + 1} of {pageCount}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(0)} disabled={page === 0}
                  className="p-1 hover:text-brass disabled:opacity-30" title="First page"><ChevronsLeft className="w-4 h-4" /></button>
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                  className="p-1 hover:text-brass disabled:opacity-30" title="Previous page"><ChevronLeft className="w-4 h-4" /></button>
                <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}
                  className="p-1 hover:text-brass disabled:opacity-30" title="Next page"><ChevronRight className="w-4 h-4" /></button>
                <button onClick={() => setPage(pageCount - 1)} disabled={page >= pageCount - 1}
                  className="p-1 hover:text-brass disabled:opacity-30" title="Last page"><ChevronsRight className="w-4 h-4" /></button>
              </div>
            </div>
          </div>

          {/* ── No Reply ─────────────────────────────────────────────── */}
          {/* Its own table, because it is its own question. These people did
              not decline — nothing was heard from them at all, which is as
              often a problem with the post as with the member. */}
          {noReply.length > 0 && (
            <div className="mt-12">
              <h2 className="font-display text-xl text-bone tracking-[0.06em]">
                No Reply <span className="text-sm font-sans text-ash">— {noReply.length}</span>
              </h2>
              <div className="rule-fade mt-2 mb-4" />
              <div className="panel rounded-lg overflow-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead className="border-b border-line">
                    <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">
                      <th className="p-3 font-normal text-left w-12">#</th>
                      <th className="p-3 font-normal text-left">Username</th>
                      <th className="p-3 font-normal text-left">Role</th>
                      <th className="p-3 font-normal text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noReply.map((r, i) => (
                      <tr key={r.discord_id} className="border-b border-line/60 hover:bg-panelup transition-colors">
                        <td className="p-3 text-ash tabular-nums">{i + 1}</td>
                        <td className="p-3">
                          <span className="flex items-center gap-2">
                            <Avatar src={r.avatar} name={r.display_name} />
                            <span className="text-bone">{r.display_name}</span>
                          </span>
                        </td>
                        <td className="p-3"><RoleCell role={r.role} className={r.class_name} /></td>
                        <td className="p-3"><StatusPill status="no_reply" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'details' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
          {[
            ['Event', event.title],
            ['Night', dateText],
            ['Scheduled event', event.schedule_name || 'Custom — not on the schedule'],
            ['Scheduled time', event.event_time ? fmtTimeEst(event.event_time) : '—'],
            ['Attendance taken', event.created_at ? fmtDatetime(event.created_at) : '—'],
            ['Turned up', `${counts.attended} of ${counts.roster} on the roster`],
            ['Excused (LOA)', String(counts.loa)],
            ['Signed up, didn\'t show', String(counts.noshow_signed)],
            ['No reply', String(counts.no_reply)],
            ['Late requests waiting', String(counts.pending)],
            ['Signups opened', signup ? `${signup.counts.going} said they were coming${signup.capacity ? ` of ${signup.capacity} slots` : ''}` : 'No signup was opened for this night'],
            ['Party recorded', party ? (party.name || 'Yes') : 'None'],
          ].map(([label, value]) => (
            <div key={label} className="panel rounded-lg px-4 py-3">
              <div className="eyebrow text-[10px] text-ash mb-1">{label}</div>
              <div className="text-bone text-sm">{value}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'parties' && party && (
        <div>
          <div className="eyebrow text-[10px] text-brass mb-3 flex items-center gap-2">
            <Swords className="w-3 h-3" />
            {party.name || 'Party fielded'}
            <span className="text-ash normal-case tracking-normal">
              ({party.parties.reduce((n, p) => n + p.members.filter((m) => m.attended).length, 0)} of{' '}
              {party.parties.reduce((n, p) => n + p.members.length, 0)} turned up)
            </span>
          </div>
          {/* A frozen copy taken when attendance was saved — editing the saved
              roster afterwards cannot rewrite what this night fielded. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {party.parties.map((p, i) => (
              <div key={`${p.name}-${i}`} className="panel rounded-lg p-3">
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
          <p className="text-ash/50 text-xs mt-4">
            Stored as a copy when attendance was saved. Editing or deleting the saved party since then hasn't changed this.
          </p>
        </div>
      )}
    </PageShell>
  );
}
