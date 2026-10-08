import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Search } from 'lucide-react';
import { useAuth } from '../auth';
import Login from './Login';
import Lockup from '../components/Lockup';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { inputClass, labelClass, errorOf, Pill, formatWhen } from './fills/shared';

// ── /staff/guilds — every tenant, for Guild Hall staff ───────────────────────
// Outside the guild gate, like the threat board: staff may belong to no guild,
// and this page belongs to none. The server decides who is staff
// (backend/staff.js) and refuses everyone else; the check here only spares a
// non-staff visitor a page of 403s.

const SUB_LABEL = { trialing: 'Trial', active: 'Paying', past_due: 'Payment failed', paused: 'Paused', canceled: 'Cancelled' };

function standing(g) {
  if (g.status === 'suspended' && g.suspended_reason === 'staff') return { key: 'staff', label: 'Suspended by staff', tone: 'bad' };
  if (g.status === 'suspended') return { key: 'billing', label: 'Suspended — billing', tone: 'bad' };
  if (g.status !== 'active') return { key: 'other', label: g.status, tone: 'neutral' };
  const s = g.subscription;
  if (!g.billing_exempt && s && s.grace_until) return { key: 'grace', label: 'In grace period', tone: 'brass' };
  return { key: 'active', label: 'Active', tone: 'good' };
}

function billingOf(g) {
  if (g.billing_exempt) return { label: 'Comped', detail: g.subscription ? `subscription ${SUB_LABEL[g.subscription.status] || g.subscription.status}` : null };
  const s = g.subscription;
  if (!s) return { label: 'Comped', detail: 'no subscription' };
  const detail = s.status === 'trialing' && s.trial_ends_at ? `trial ends ${formatWhen(s.trial_ends_at)}`
    : s.status === 'active' && s.current_period_end ? `renews ${formatWhen(s.current_period_end)}`
      : s.grace_until ? `closes ${formatWhen(s.grace_until)}` : null;
  return { label: SUB_LABEL[s.status] || s.status, detail };
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'grace', label: 'In grace' },
  { key: 'billing', label: 'Billing suspended' },
  { key: 'staff', label: 'Staff suspended' },
];

function SuspendControl({ g, busy, onSuspend }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  if (!open) return <Button size="none" variant="destructive" className="text-xs" onClick={() => setOpen(true)}>Suspend</Button>;
  return (
    <form className="flex flex-col items-end gap-1.5"
      onSubmit={(e) => { e.preventDefault(); onSuspend(g, note).then((ok) => ok && setOpen(false)); }}>
      <input autoFocus type="text" maxLength={500} required placeholder="Reason — internal to staff"
        className={`${inputClass} w-56 py-1 text-xs`} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button type="button" size="none" variant="neutral" className="text-xs" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="none" className="text-xs px-3 py-1.5" disabled={busy || !note.trim()}>Suspend</Button>
      </div>
    </form>
  );
}

function GuildsTable() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  const [f, setF] = useState({ q: '', status: 'all' });

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/staff/guilds');
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load guilds.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, grace: 0, billing: 0, staff: 0, other: 0 };
    (data?.guilds || []).forEach((g) => { c.all += 1; c[standing(g).key] += 1; });
    return c;
  }, [data]);

  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return (data?.guilds || []).filter((g) => (!q || [g.house, g.tag, g.discord_guild_id, g.created_by]
      .some((v) => String(v || '').toLowerCase().includes(q)))
      && (f.status === 'all' || standing(g).key === f.status));
  }, [data, f]);

  const act = async (fn, ok, fail) => {
    setBusy(true);
    try { await fn(); flash(ok); return true; } catch (e) { flash(errorOf(e, fail), false); return false; } finally { setBusy(false); load(); }
  };
  const suspend = (g, note) => act(() => axios.post(`/api/staff/guilds/${g.id}/suspend`, { note }),
    `${g.house} is suspended. Its members can't sign in until staff reactivate it.`, 'Could not suspend.');
  const reactivate = (g) => act(() => axios.post(`/api/staff/guilds/${g.id}/reactivate`),
    `${g.house} is open again.`, 'Could not reactivate.');
  const comp = (g, exempt) => act(() => axios.post(`/api/staff/guilds/${g.id}/comp`, { exempt }),
    exempt ? `${g.house} is comped — it will never be suspended for billing.` : `${g.house} is billed normally again.`,
    'Could not change billing.');

  if (error) return <p className="text-oxblood">{error}</p>;
  if (!data) return <EmptyState>Loading guilds…</EmptyState>;

  return (
    <div className="space-y-5">
      <Toast msg={msg} />

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((s) => (
          <button key={s.key} type="button" onClick={() => setF({ ...f, status: s.key })}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${f.status === s.key ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}>
            {s.label} <span className="tabular-nums text-xs text-ash">{counts[s.key]}</span>
          </button>
        ))}
      </div>

      <div className="max-w-sm">
        <label className={labelClass} htmlFor="sg-q">Search</label>
        <div className="relative">
          <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
          <input id="sg-q" type="search" className={`${inputClass} pl-9`} placeholder="Name, tag, server or founder ID"
            value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </div>
      </div>

      <div className="panel rounded-lg p-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left eyebrow text-[10px] text-ash border-b border-line">
              <th className="py-2 pr-3 font-semibold">Guild</th>
              <th className="py-2 pr-3 font-semibold">Standing</th>
              <th className="py-2 pr-3 font-semibold">Billing</th>
              <th className="py-2 pr-3 font-semibold">Created</th>
              <th className="py-2 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-ash">{data.guilds.length ? 'No guilds match.' : 'No guilds yet.'}</td></tr>
            )}
            {shown.map((g) => {
              const st = standing(g);
              const bill = billingOf(g);
              return (
                <tr key={g.id} className="border-b border-line last:border-0 align-top">
                  <td className="py-2.5 pr-3">
                    <div className="font-semibold">{g.house} <span className="text-ash font-normal">[{g.tag}]</span></div>
                    <div className="text-xs text-ash tabular-nums">Server {g.discord_guild_id}</div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {st.key === 'staff' && (
                      <div className="text-xs text-ash mt-1 max-w-[16rem]">
                        “{g.suspended_note}” — {g.suspended_by?.replace(/ \(\d+\)$/, '')}{g.suspended_at ? `, ${formatWhen(g.suspended_at)}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    {bill.label}
                    {bill.detail && <div className="text-xs text-ash">{bill.detail}</div>}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-ash">
                    {formatWhen(g.created_at)}
                    {g.created_by && <div className="tabular-nums">by {g.created_by}</div>}
                  </td>
                  <td className="py-2.5 text-right space-y-2">
                    <div>
                      {st.key === 'staff'
                        ? <Button size="none" variant="secondary" className="text-xs px-3 py-1.5" disabled={busy} onClick={() => reactivate(g)}>Reactivate</Button>
                        : <SuspendControl g={g} busy={busy} onSuspend={suspend} />}
                    </div>
                    <div>
                      <Button size="none" variant="ghost" className="text-xs" disabled={busy} onClick={() => comp(g, !g.billing_exempt)}>
                        {g.billing_exempt ? 'Stop comping' : 'Comp'}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.unclaimed.length > 0 && (
        <div className="panel rounded-lg p-4">
          <div className="eyebrow text-[10px] text-ash mb-2">Paid, not set up yet</div>
          <p className="text-xs text-ash mb-3">Subscriptions with no guild: someone checked out and didn't finish adding the bot or the basics.</p>
          <ul className="text-sm space-y-1">
            {data.unclaimed.map((s, i) => (
              <li key={i} className="flex flex-wrap gap-x-4">
                <span className="tabular-nums">Discord user {s.discord_user_id || 'unknown'}</span>
                <span className="text-ash">{SUB_LABEL[s.status] || s.status}</span>
                <span className="text-ash">since {formatWhen(s.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function StaffGuilds() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-ink" />;
  if (!user) return <Login />;

  return (
    <div className="min-h-screen bg-ink text-bone">
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Link to="/"><Lockup className="w-[160px] h-auto" /></Link>
          <div className="eyebrow text-[10px] text-brass">Staff · Guilds</div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {user.staff
          ? <GuildsTable />
          : <p className="text-ash">This page is for Guild Hall staff.</p>}
      </main>
    </div>
  );
}
