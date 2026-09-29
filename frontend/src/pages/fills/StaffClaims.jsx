import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { UserPlus } from 'lucide-react';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import {
  errorOf, GuildName, Pill, formatWhen, inputClass, labelClass, useThreatGuilds, GuildOptions,
} from './shared';

// Guild Hall staff confirming outside leaders. Same gate as editing the threat
// board: a platform role from deploy config, never a guild capability.

const TONE = { pending: 'brass', approved: 'good', rejected: 'bad' };

// Add a leader directly, already verified — for someone who asked in Discord
// instead of sending a claim. The bot looks the ID up and supplies the name;
// the name field is only needed when the bot can't.
function AddLeader({ existing, max, onDone, onCancel }) {
  const board = useThreatGuilds();
  const [form, setForm] = useState({ discord_id: '', threat_guild_id: '', username: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const id = form.discord_id.trim();
  const already = existing.find((c) => c.discord_id === id);
  const full = form.threat_guild_id
    && existing.filter((c) => c.threat_guild_id === form.threat_guild_id && c.status === 'approved' && c.discord_id !== id).length >= max;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await axios.post('/api/fills/claims', { ...form, discord_id: id });
      onDone(res.data);
    } catch (err) {
      setError(errorOf(err, 'Could not add that leader.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel rounded-lg p-5 space-y-4 max-w-2xl">
      <h2 className="font-display tracking-wide">Add a verified leader</h2>
      {error && <p className="text-sm text-oxblood">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="al-id">Discord user ID</label>
          <input id="al-id" required inputMode="numeric" className={`${inputClass} tabular-nums`} value={form.discord_id}
            onChange={(e) => set({ discord_id: e.target.value })} placeholder="e.g. 123456789012345678" />
          <p className="text-xs text-ash mt-1.5">In Discord: Settings → Advanced → Developer Mode, then right-click them → Copy User ID.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="al-guild">Guild</label>
          <select id="al-guild" required className={inputClass} value={form.threat_guild_id}
            onChange={(e) => set({ threat_guild_id: e.target.value })}>
            <option value="">Pick from the threat board…</option>
            <GuildOptions guilds={board.guilds} clusters={board.clusters} />
          </select>
          {full && <p className="text-xs text-oxblood mt-1.5">That guild already has {max} verified leaders.</p>}
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="al-name">Their Discord name (optional)</label>
        <input id="al-name" maxLength={80} className={inputClass} value={form.username}
          onChange={(e) => set({ username: e.target.value })} placeholder="Only used if the bot can't look the ID up" />
      </div>
      {already && (
        <p className="text-sm text-ash">
          {already.username} already has a {already.status} claim{already.guild ? ` for ${already.guild.name}` : ''}. Adding them replaces it.
        </p>
      )}
      <div className="flex gap-3">
        <Button type="submit" disabled={saving || !id || !form.threat_guild_id || full}>{saving ? 'Adding…' : 'Add as verified leader'}</Button>
        <Button type="button" variant="neutral" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export default function StaffClaims() {
  const [list, setList] = useState(null);
  const [max, setMax] = useState(2);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/claims');
      setList(res.data.claims);
      if (res.data.maxLeaders) setMax(res.data.maxLeaders);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load leader claims.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (c, status) => {
    setBusy(true);
    try {
      await axios.post(`/api/fills/claims/${c.discord_id}/decision`, { status });
      flash(status === 'approved' ? `${c.username} is now a verified leader of ${c.guild?.name || 'their guild'}.`
        : status === 'rejected' ? `Rejected ${c.username}'s claim.` : 'Moved back to pending.');
    } catch (e) {
      flash(errorOf(e, 'Could not record that.'), false);
    } finally {
      setBusy(false);
      load();
    }
  };

  if (error) return <p className="text-oxblood">{error}</p>;
  if (!list) return <EmptyState>Loading claims…</EmptyState>;
  const pending = list.filter((c) => c.status === 'pending');
  const decided = list.filter((c) => c.status !== 'pending');

  const row = (c) => (
    <tr key={c.discord_id} className="border-b border-line last:border-0 align-top">
      <td className="py-2.5 pr-3"><div className="font-semibold">{c.username}</div><div className="text-xs text-ash">Discord {c.discord_id}</div></td>
      <td className="py-2.5 pr-3">
        <GuildName guild={c.guild} />
        <div className="text-xs text-ash">{c.guild?.cluster}</div>
        {/* How many of the guild's verified-leader places are taken, counting
            this claimant only if they already hold one. */}
        <div className="text-xs text-ash tabular-nums">
          {c.otherApproved + (c.status === 'approved' ? 1 : 0)}/{max} verified leaders
        </div>
      </td>
      <td className="py-2.5 pr-3 max-w-xs">{c.proof || <span className="text-ash">—</span>}</td>
      <td className="py-2.5 pr-3"><Pill tone={TONE[c.status]}>{c.status}</Pill><div className="text-xs text-ash mt-1">{formatWhen(c.updated_at)}</div></td>
      <td className="py-2.5 text-right whitespace-nowrap">
        {c.status === 'pending' ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy || c.otherApproved >= max}
              title={c.otherApproved >= max ? `${c.guild?.name || 'This guild'} already has ${max} verified leaders — reject or undo one first` : undefined}
              onClick={() => decide(c, 'approved')}>Approve</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide(c, 'rejected')}>Reject</Button>
          </div>
        ) : (
          <Button size="none" variant="neutral" className="text-xs" disabled={busy} onClick={() => decide(c, 'pending')}>Undo</Button>
        )}
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      <Toast msg={msg} />
      {adding ? (
        <AddLeader
          existing={list} max={max}
          onCancel={() => setAdding(false)}
          onDone={({ claim, verifiedName }) => {
            setAdding(false);
            flash(`${claim.username} is now a verified leader of ${claim.guild?.name || 'their guild'}.`
              + (verifiedName ? '' : " The bot couldn't confirm that ID, so double-check it."));
            load();
          }}
        />
      ) : (
        <Button icon={<UserPlus className="w-4 h-4" />} onClick={() => setAdding(true)}>Add leader</Button>
      )}
      <p className="text-sm text-ash">
        Leaders of guilds that don&apos;t use Guild Hall. Approving one marks their fill invites as verified. A guild can have up to {max} verified leaders, who share its fill requests. They&apos;re DM&apos;d the outcome when the bot can reach them.
      </p>
      {list.length === 0 ? <div className="panel rounded-lg p-8 text-center text-ash">No claims yet.</div> : (
        <div className="panel rounded-lg p-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left eyebrow text-[10px] text-ash border-b border-line">
                <th className="py-2 pr-3 font-semibold">Leader</th>
                <th className="py-2 pr-3 font-semibold">Guild</th>
                <th className="py-2 pr-3 font-semibold">How to confirm</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>{[...pending, ...decided].map(row)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
