import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Search } from 'lucide-react';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import { ROLES, WEEKDAYS, CLASS_LIST, inputClass, labelClass, errorOf, GuildName, Pill, formatWhen } from './shared';

// Every fill profile, for Guild Hall staff. Unlike a leader's pool, nothing is
// hidden here — home guild, "won't fill against", paused listings — because
// staff are the ones who have to spot a troll, an impersonator or a repeat
// no-show. A staff pause takes a listing out of every pool until staff lift
// it; the player sees the reason (not who set it). See migrations/saas_010.

const STATUS_FILTERS = [
  { key: 'all', label: 'Everyone' },
  { key: 'pool', label: 'In the pool' },
  { key: 'self', label: 'Paused by player' },
  { key: 'staff', label: 'Paused by staff' },
];

function statusOf(p) {
  if (p.staff_paused) return { key: 'staff', label: 'Paused by staff', tone: 'bad' };
  if (!p.active) return { key: 'self', label: 'Paused by player', tone: 'neutral' };
  return { key: 'pool', label: 'In the pool', tone: 'good' };
}

function PauseControl({ p, busy, onPause, onLift }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (p.staff_paused) {
    return (
      <div className="space-y-1 text-right">
        <Button size="none" variant="secondary" className="text-xs px-3 py-1.5" disabled={busy} onClick={() => onLift(p)}>Lift pause</Button>
        <div className="text-xs text-ash max-w-[14rem] ml-auto">
          “{p.staff_paused_reason}” — {p.staff_paused_by?.replace(/ \(\d+\)$/, '')}, {p.staff_paused_at ? formatWhen(p.staff_paused_at) : ''}
        </div>
      </div>
    );
  }
  if (!open) {
    return <Button size="none" variant="destructive" className="text-xs" onClick={() => setOpen(true)}>Pause listing</Button>;
  }
  return (
    <form
      className="flex flex-col items-end gap-1.5"
      onSubmit={(e) => { e.preventDefault(); onPause(p, reason).then((ok) => ok && setOpen(false)); }}
    >
      <input
        autoFocus type="text" maxLength={300} required placeholder="Reason — the player sees this"
        className={`${inputClass} w-56 py-1 text-xs`} value={reason} onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="button" size="none" variant="neutral" className="text-xs" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="none" className="text-xs px-3 py-1.5" disabled={busy || !reason.trim()}>Pause</Button>
      </div>
    </form>
  );
}

export default function StaffPool() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  const [f, setF] = useState({ q: '', status: 'all', role: 'any', cls: 'any', home: 'any' });

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/staff/pool');
      setList(res.data.profiles);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load the player pool.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { all: 0, pool: 0, self: 0, staff: 0 };
    (list || []).forEach((p) => { c.all += 1; c[statusOf(p).key] += 1; });
    return c;
  }, [list]);

  // Home guilds actually present, for the filter — the board has 130 guilds
  // and most will have nobody listed.
  const homes = useMemo(() => {
    const m = new Map();
    (list || []).forEach((p) => p.home_guild && m.set(p.home_guild.id, p.home_guild));
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);

  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return (list || []).filter((p) => (!q || p.username.toLowerCase().includes(q) || p.discord_id.includes(q))
      && (f.status === 'all' || statusOf(p).key === f.status)
      && (f.role === 'any' || p.role === f.role)
      && (f.cls === 'any' || (p.classes || []).includes(f.cls))
      && (f.home === 'any' || (f.home === 'none' ? !p.home_guild : p.home_guild?.id === f.home)));
  }, [list, f]);

  const pause = async (p, reason) => {
    setBusy(true);
    try {
      await axios.post(`/api/fills/staff/pool/${p.discord_id}/pause`, { reason });
      flash(`${p.username} is paused and out of every pool. They've been told why.`);
      return true;
    } catch (e) {
      flash(errorOf(e, 'Could not pause that listing.'), false);
      return false;
    } finally {
      setBusy(false);
      load();
    }
  };
  const lift = async (p) => {
    setBusy(true);
    try {
      await axios.delete(`/api/fills/staff/pool/${p.discord_id}/pause`);
      flash(p.active ? `${p.username} is back in the pool.` : `Pause lifted. ${p.username} is still paused by their own choice.`);
    } catch (e) {
      flash(errorOf(e, 'Could not lift the pause.'), false);
    } finally {
      setBusy(false);
      load();
    }
  };

  if (error) return <p className="text-oxblood">{error}</p>;
  if (!list) return <EmptyState>Loading the pool…</EmptyState>;

  return (
    <div className="space-y-5">
      <Toast msg={msg} />
      <p className="text-sm text-ash">
        Everyone with a fill profile, including paused listings and what leaders never see: home guild and
        &ldquo;won&apos;t fill against&rdquo;. Pausing a listing removes it from every pool until staff lift it; invites the player already has still work.
      </p>

      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((s) => (
          <button key={s.key} type="button" onClick={() => setF({ ...f, status: s.key })}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${f.status === s.key ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}>
            {s.label} <span className="tabular-nums text-xs text-ash">{counts[s.key]}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4 items-end">
        <div className="col-span-2 md:col-span-1">
          <label className={labelClass} htmlFor="sp-q">Search</label>
          <div className="relative">
            <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
            <input id="sp-q" type="search" className={`${inputClass} pl-9`} placeholder="Name or Discord ID"
              value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="sp-role">Role</label>
          <select id="sp-role" className={inputClass} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="any">Any role</option>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="sp-cls">Class</label>
          <select id="sp-cls" className={inputClass} value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })}>
            <option value="any">Any class</option>
            {CLASS_LIST.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="sp-home">Home guild</label>
          <select id="sp-home" className={inputClass} value={f.home} onChange={(e) => setF({ ...f, home: e.target.value })}>
            <option value="any">Any</option>
            <option value="none">No guild (free agent)</option>
            {homes.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>

      <div className="panel rounded-lg p-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left eyebrow text-[10px] text-ash border-b border-line">
              <th className="py-2 pr-3 font-semibold">Player</th>
              <th className="py-2 pr-3 font-semibold">Status</th>
              <th className="py-2 pr-3 font-semibold">Role · classes</th>
              <th className="py-2 pr-3 font-semibold text-right">Gear</th>
              <th className="py-2 pr-3 font-semibold">Guild</th>
              <th className="py-2 pr-3 font-semibold">Availability</th>
              <th className="py-2 pr-3 font-semibold" title="Invites accepted / declined / slot already filled">Invites</th>
              <th className="py-2 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-ash">{list.length ? 'Nobody matches these filters.' : 'Nobody has listed themselves yet.'}</td></tr>
            )}
            {shown.map((p) => {
              const st = statusOf(p);
              return (
                <tr key={p.discord_id} className="border-b border-line last:border-0 align-top">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2">
                      {p.avatar
                        ? <img src={p.avatar} alt="" className="w-7 h-7 rounded-full border border-line" />
                        : <span className="w-7 h-7 rounded-full bg-panelup border border-line shrink-0" />}
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{p.username}</div>
                        <div className="text-xs text-ash tabular-nums">{p.discord_id}</div>
                      </div>
                    </div>
                    {p.notes && <div className="text-xs text-ash mt-1 max-w-xs">{p.notes}</div>}
                    <div className="text-xs text-ash mt-1">Updated {formatWhen(p.updated_at)}</div>
                  </td>
                  <td className="py-2.5 pr-3"><Pill tone={st.tone}>{st.label}</Pill></td>
                  <td className="py-2.5 pr-3">{p.role}<div className="text-xs text-ash">{(p.classes || []).join(', ') || '—'}</div></td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{p.gear ?? '—'}</td>
                  <td className="py-2.5 pr-3">
                    {p.home_guild ? <GuildName guild={p.home_guild} /> : <span className="text-ash">Free agent</span>}
                    <div className="text-xs text-ash">{p.guild_hall ? 'Guild Hall member' : 'Not in Guild Hall'}</div>
                    {p.avoid_guilds.length > 0 && (
                      <div className="text-xs text-ash mt-1 max-w-[14rem]">
                        Won&apos;t fill vs {p.avoid_guilds.map((g) => g.name).join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-ash max-w-[14rem]">
                    {(p.windows || []).map((w) => `${WEEKDAYS[w.d]} ${w.from}–${w.to}`).join(', ') || 'No windows'}
                    <div>{p.timezone}</div>
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums whitespace-nowrap">
                    <span className="text-emerald-600 dark:text-emerald-300" title="Accepted">{p.stats.accepted}</span>
                    {' / '}<span title="Declined">{p.stats.declined}</span>
                    {' / '}<span className="text-ash" title="Said yes after the slot filled">{p.stats.missed}</span>
                    {p.stats.invited > 0 && <div className="text-xs text-ash">{p.stats.invited} open</div>}
                  </td>
                  <td className="py-2.5 whitespace-nowrap">
                    <PauseControl p={p} busy={busy} onPause={pause} onLift={lift} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
