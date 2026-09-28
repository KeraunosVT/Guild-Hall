import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Plus } from 'lucide-react';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import {
  ROLES, inputClass, labelClass, errorOf, formatWhen, useThreatGuilds, GuildOptions, GuildName, VerifiedBadge,
} from './shared';

// A leader's fill requests: the list, and the form for a new one. Each card
// opens the request's own page (FillRequestDetail), where the pool lives.

function SlotBar({ request }) {
  const total = ROLES.reduce((n, r) => n + (request.slots[r] || 0), 0);
  const filled = ROLES.reduce((n, r) => n + (request.filled[r] || 0), 0);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-sm ${i < filled ? 'bg-emerald-500' : 'bg-line'}`} />
        ))}
      </div>
      <div className="text-xs text-ash tabular-nums">
        <span className="text-bone font-semibold">{filled}</span>/{total} filled ·{' '}
        {ROLES.filter((r) => request.slots[r]).map((r) => `${r} ${request.filled[r]}/${request.slots[r]}`).join(' · ')}
      </div>
    </div>
  );
}

// Local date and time inputs → an instant. The browser reads them in the
// leader's own zone, which is the zone they are thinking in.
const defaultDate = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function NewRequest({ me, onCancel, onCreated }) {
  const board = useThreatGuilds();
  const postAs = [
    ...me.leader.guilds.map((g) => ({ value: g.guild_id, label: `${g.house} (Guild Hall)` })),
    ...(me.leader.claim && me.leader.claim.status !== 'rejected'
      ? [{ value: 'claim', label: `${board.guilds.find((g) => g.id === me.leader.claim.threat_guild_id)?.name || 'Your guild'}${me.leader.claim.status === 'approved' ? '' : ' (unverified)'}` }]
      : []),
  ];
  const [form, setForm] = useState({
    as: postAs[0]?.value || '', opponent_id: '', date: defaultDate(), time: '20:00', duration_min: 60,
    slots: { Tank: 1, DPS: 2, Healer: 1 }, notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const exclude = form.as === 'claim' && me.leader.claim ? [me.leader.claim.threat_guild_id] : [];

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const starts = new Date(`${form.date}T${form.time}`);
      const res = await axios.post('/api/fills/requests', {
        guild_id: form.as === 'claim' ? null : form.as,
        opponent_id: form.opponent_id,
        starts_at: starts.toISOString(),
        duration_min: Number(form.duration_min),
        slots: form.slots,
        notes: form.notes,
      });
      onCreated(res.data.request.id);
    } catch (err) {
      setError(errorOf(err, 'Could not create the request.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel rounded-lg p-5 space-y-4 max-w-2xl">
      <h2 className="font-display tracking-wide">New fill request</h2>
      {error && <p className="text-sm text-oxblood">{error}</p>}
      {postAs.length > 1 && (
        <div>
          <label className={labelClass} htmlFor="nr-as">Posting for</label>
          <select id="nr-as" className={inputClass} value={form.as} onChange={(e) => set({ as: e.target.value })}>
            {postAs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className={labelClass} htmlFor="nr-opp">Opponent</label>
        <select id="nr-opp" className={inputClass} required value={form.opponent_id} onChange={(e) => set({ opponent_id: e.target.value })}>
          <option value="">Pick from the threat board…</option>
          <GuildOptions guilds={board.guilds} clusters={board.clusters} exclude={exclude} />
        </select>
        <p className="text-xs text-ash mt-1.5">Players from this guild or its ally are left out of your pool automatically.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="nr-date">Date</label>
          <input id="nr-date" type="date" required className={inputClass} value={form.date} onChange={(e) => set({ date: e.target.value })} />
        </div>
        <div>
          <label className={labelClass} htmlFor="nr-time">Start (your time)</label>
          <input id="nr-time" type="time" required className={inputClass} value={form.time} onChange={(e) => set({ time: e.target.value })} />
        </div>
        <div>
          <label className={labelClass} htmlFor="nr-dur">Length (minutes)</label>
          <input id="nr-dur" type="number" min="15" max="360" step="15" className={`${inputClass} tabular-nums`} value={form.duration_min}
            onChange={(e) => set({ duration_min: e.target.value })} />
        </div>
      </div>
      <div>
        <span className={labelClass}>Slots needed</span>
        <div className="grid grid-cols-3 gap-3">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <span className="w-12">{r}</span>
              <input type="number" min="0" max="30" className={`${inputClass} tabular-nums`} value={form.slots[r]}
                onChange={(e) => set({ slots: { ...form.slots, [r]: Number(e.target.value) } })} />
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="nr-notes">Notes for fills</label>
        <textarea id="nr-notes" rows={2} maxLength={500} className={inputClass} value={form.notes}
          onChange={(e) => set({ notes: e.target.value })} placeholder="Voice channel, consumables, where to meet…" />
      </div>
      <div className="flex gap-3">
        <Button type="submit" disabled={saving || !form.as}>{saving ? 'Creating…' : 'Create and pick fills'}</Button>
        <Button type="button" variant="neutral" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export default function FillRequests({ me, base, claimPath }) {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/requests');
      setList(res.data.requests);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load your fill requests.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const upcoming = useMemo(() => (list || []).filter((r) => r.status === 'open'), [list]);
  const cancelled = useMemo(() => (list || []).filter((r) => r.status !== 'open'), [list]);

  if (!me.leader.canLead) {
    return (
      <div className="panel rounded-lg p-8 text-center space-y-3">
        <p>Only guild leaders can post fill requests.</p>
        {claimPath && (
          <p className="text-sm text-ash">
            Lead a guild that doesn&apos;t use Guild Hall? <Link className="text-brass hover:text-brassbright underline underline-offset-4" to={claimPath}>Tell us which one</Link> and you can start posting right away.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {me.leader.claim && !me.leader.guilds.length && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Posting as a leader of{' '}
          <span className="text-bone">{me.leader.claim.guild?.name || 'your guild'}</span>
          <VerifiedBadge verified={me.leader.claim.status === 'approved'} />
        </div>
      )}
      {creating
        ? <NewRequest me={me} onCancel={() => setCreating(false)} onCreated={(id) => navigate(`${base}/${id}`)} />
        : <Button icon={<Plus className="w-4 h-4" />} onClick={() => setCreating(true)}>New fill request</Button>}

      {error && <p className="text-oxblood">{error}</p>}
      {!list && !error && <EmptyState>Loading requests…</EmptyState>}
      {list && upcoming.length === 0 && !creating && (
        <div className="panel rounded-lg p-8 text-center text-ash">No fill requests yet. Post one for your next wargame.</div>
      )}
      {upcoming.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {upcoming.map((r) => (
            <Link key={r.id} to={`${base}/${r.id}`} className="panel rounded-lg p-5 space-y-3 hover:border-ash transition-colors">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-lg tracking-wide">vs <GuildName guild={r.opponent} /></span>
                <span className="text-sm text-ash tabular-nums">{formatWhen(r.starts_at)}</span>
              </div>
              <SlotBar request={r} />
              <div className="text-xs text-ash">{r.guild_label} · posted by {r.leader_name}</div>
            </Link>
          ))}
        </div>
      )}
      {cancelled.length > 0 && (
        <div className="text-xs text-ash">
          Cancelled: {cancelled.map((r) => `vs ${r.opponent?.name || 'unknown'} (${formatWhen(r.starts_at)})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export { SlotBar };
