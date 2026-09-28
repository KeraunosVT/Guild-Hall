import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { EyeOff } from 'lucide-react';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import {
  ROLES, WEEKDAYS, CLASS_LIST, inputClass, labelClass, errorOf, formatWhen, GuildName, VerifiedBadge, Pill, INVITE_STATUS,
} from './shared';

// One fill request: its slots, who has been invited, and the pool to invite
// from. The server has already removed everyone this leader must not see —
// the opponent's players, its ally's, anyone who won't fill against it, and
// this guild's own members — and reports only how many, never who.

const HIDDEN_LABEL = {
  opponent: 'play for the opponent',
  ally: "play for the opponent's ally",
  avoid: "won't fill against the opponent",
  own: 'are already in your guild',
};

function Slots({ data }) {
  const { request, invites } = data;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {ROLES.filter((r) => request.slots[r] > 0).map((role) => {
        const live = invites.filter((i) => i.role === role && (i.status === 'accepted' || i.status === 'invited'))
          .sort((a, b) => (a.status === 'accepted' ? -1 : 1) - (b.status === 'accepted' ? -1 : 1));
        const open = Math.max(0, request.slots[role] - request.filled[role]);
        return (
          <div key={role} className="panel rounded-lg p-4 space-y-2">
            <div className="flex justify-between font-semibold">
              <span>{role}</span>
              <span className="tabular-nums">{request.filled[role]}/{request.slots[role]}</span>
            </div>
            <ul className="space-y-1 text-sm">
              {live.map((i) => (
                <li key={i.discord_id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{i.username}</span>
                  <Pill tone={i.status === 'accepted' ? 'good' : 'brass'}>{i.status === 'accepted' ? 'In' : 'Invited'}</Pill>
                </li>
              ))}
              {open > 0 && <li className="text-xs text-ash">{open} open{live.some((i) => i.status === 'invited') ? ' · first to accept gets it' : ''}</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function FillRequestDetail({ base }) {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [msg, flash] = useFlash();
  const [filters, setFilters] = useState({ role: 'any', cls: 'any', gear: '', availableOnly: true });
  const [inviteRole, setInviteRole] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/fills/requests/${id}`);
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load that request.'));
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (data?.pool || []).filter((p) => (filters.role === 'any' || p.role === filters.role)
    && (filters.cls === 'any' || (p.classes || []).includes(filters.cls))
    && (!filters.gear || (p.gear || 0) >= Number(filters.gear))
    && (!filters.availableOnly || p.available)), [data, filters]);

  const act = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      flash(ok);
    } catch (e) {
      flash(errorOf(e, 'That did not work.'), false);
    } finally {
      setBusy(false);
      load();
    }
  };

  if (error) return <div className="space-y-4"><Link to={base} className="text-sm text-ash hover:text-bone">← Fill requests</Link><p className="text-oxblood">{error}</p></div>;
  if (!data) return <EmptyState>Loading the request…</EmptyState>;

  const { request: r, canEdit, hidden } = data;
  const hiddenTotal = Object.values(hidden).reduce((a, b) => a + b, 0);
  const unavailable = (data.pool || []).filter((p) => !p.available).length;
  const answered = data.invites.filter((i) => !['accepted', 'invited'].includes(i.status));
  const roleFor = (p) => inviteRole[p.discord_id] || (r.slots[p.role] > 0 ? p.role : ROLES.find((x) => r.slots[x] > 0));

  return (
    <div className="space-y-6">
      <Link to={base} className="text-sm text-ash hover:text-bone">← Fill requests</Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow text-[10px] text-ash">{r.guild_label} · {formatWhen(r.starts_at)} · {r.duration_min} min</div>
          <h1 className="font-display text-2xl tracking-[0.06em] mt-1">vs <GuildName guild={r.opponent} /></h1>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
            <VerifiedBadge verified={r.verified} />
            {r.opponent && <span className="text-ash">{r.opponent.status} · {r.opponent.cluster}</span>}
            {r.status !== 'open' && <Pill tone="bad">Cancelled</Pill>}
          </div>
        </div>
        {canEdit && (confirmCancel ? (
          <div className="flex items-center gap-2 text-sm">
            <span>Cancel this wargame? Invited players are told.</span>
            <Button size="sm" variant="secondary" disabled={busy}
              onClick={() => act(() => axios.delete(`/api/fills/requests/${r.id}`), 'Request cancelled.')}>Yes, cancel</Button>
            <Button size="sm" variant="neutral" onClick={() => setConfirmCancel(false)}>Keep it</Button>
          </div>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setConfirmCancel(true)}>Cancel request</Button>
        ))}
      </div>
      <Toast msg={msg} />
      {r.notes && <p className="text-sm text-ash">Notes: <span className="text-bone">{r.notes}</span></p>}

      <Slots data={data} />

      {canEdit && (
        <section className="panel rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display tracking-wide">Fill pool</h2>
            <span className="text-xs text-ash tabular-nums">
              {shown.length} shown{filters.availableOnly && unavailable ? ` · ${unavailable} not free then` : ''}
            </span>
          </div>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4 items-end">
            <div>
              <label className={labelClass} htmlFor="f-role">Role</label>
              <select id="f-role" className={inputClass} value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
                <option value="any">Any role</option>
                {ROLES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="f-cls">Class</label>
              <select id="f-cls" className={inputClass} value={filters.cls} onChange={(e) => setFilters({ ...filters, cls: e.target.value })}>
                <option value="any">Any class</option>
                {CLASS_LIST.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="f-gear">Min gear</label>
              <input id="f-gear" type="number" min="0" className={`${inputClass} tabular-nums`} value={filters.gear}
                onChange={(e) => setFilters({ ...filters, gear: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm pb-2">
              <input type="checkbox" checked={filters.availableOnly} onChange={(e) => setFilters({ ...filters, availableOnly: e.target.checked })} />
              Free at this time
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left eyebrow text-[10px] text-ash border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Player</th>
                  <th className="py-2 pr-3 font-semibold">Role · classes</th>
                  <th className="py-2 pr-3 font-semibold text-right">Gear</th>
                  <th className="py-2 pr-3 font-semibold">Availability</th>
                  <th className="py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={5} className="py-8 text-center text-ash">Nobody matches these filters.</td></tr>
                )}
                {shown.map((p) => {
                  const status = p.invite && INVITE_STATUS[p.invite];
                  const live = p.invite === 'invited' || p.invite === 'accepted';
                  return (
                    <tr key={p.discord_id} className="border-b border-line last:border-0 align-top">
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          {p.avatar
                            ? <img src={p.avatar} alt="" className="w-7 h-7 rounded-full border border-line" />
                            : <span className="w-7 h-7 rounded-full bg-panelup border border-line" />}
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{p.username}</div>
                            <div className="text-xs text-ash">
                              {p.guild_hall ? 'Guild Hall member' : 'Independent'}
                              {p.home_guild ? <> · <GuildName guild={p.home_guild} /></> : ''}
                            </div>
                          </div>
                        </div>
                        {p.notes && <div className="text-xs text-ash mt-1 max-w-xs">{p.notes}</div>}
                      </td>
                      <td className="py-2.5 pr-3">{p.role}<div className="text-xs text-ash">{(p.classes || []).join(', ')}</div></td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{p.gear ?? '—'}</td>
                      <td className="py-2.5 pr-3">
                        <Pill tone={p.available ? 'good' : 'neutral'}>{p.available ? 'Free then' : 'Outside their windows'}</Pill>
                        <div className="text-xs text-ash mt-1">
                          {(p.windows || []).map((w) => `${WEEKDAYS[w.d]} ${w.from}–${w.to}`).join(', ') || 'No windows'}
                          {' '}({p.timezone})
                        </div>
                      </td>
                      <td className="py-2.5 whitespace-nowrap text-right">
                        {live ? (
                          <div className="flex items-center justify-end gap-2">
                            <Pill tone={status.tone}>{status.label}</Pill>
                            <Button size="none" variant="destructive" className="text-xs" disabled={busy}
                              onClick={() => act(() => axios.delete(`/api/fills/requests/${r.id}/invites/${p.discord_id}`), `Invite to ${p.username} withdrawn.`)}>
                              Withdraw
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <select aria-label="Invite as" className={`${inputClass} w-auto py-1`} value={roleFor(p)}
                              onChange={(e) => setInviteRole({ ...inviteRole, [p.discord_id]: e.target.value })}>
                              {ROLES.filter((x) => r.slots[x] > 0).map((x) => <option key={x}>{x}</option>)}
                            </select>
                            <Button size="sm" disabled={busy}
                              onClick={() => act(() => axios.post(`/api/fills/requests/${r.id}/invites`, { discord_id: p.discord_id, role: roleFor(p) }),
                                `Invited ${p.username}. They'll see it on their invites page.`)}>
                              {p.invite ? 'Re-invite' : 'Invite'}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hiddenTotal > 0 && (
            <p className="flex gap-2 text-xs text-ash">
              <EyeOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {hiddenTotal} {hiddenTotal === 1 ? 'player is' : 'players are'} hidden from this pool because they{' '}
                {Object.entries(hidden).filter(([, n]) => n).map(([k, n]) => `${HIDDEN_LABEL[k]} (${n})`).join(', ')}.
                Hidden players are never shown by name.
              </span>
            </p>
          )}
        </section>
      )}

      {answered.length > 0 && (
        <p className="text-xs text-ash">
          Answered: {answered.map((i) => `${i.username} (${INVITE_STATUS[i.status]?.label.toLowerCase() || i.status})`).join(' · ')}
        </p>
      )}
    </div>
  );
}
