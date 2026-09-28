import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import { errorOf, GuildName, Pill, formatWhen } from './shared';

// Guild Hall staff confirming outside leaders. Same gate as editing the threat
// board: a platform role from deploy config, never a guild capability.

const TONE = { pending: 'brass', approved: 'good', rejected: 'bad' };

export default function StaffClaims() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/claims');
      setList(res.data.claims);
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
      <td className="py-2.5 pr-3"><GuildName guild={c.guild} /><div className="text-xs text-ash">{c.guild?.cluster}</div></td>
      <td className="py-2.5 pr-3 max-w-xs">{c.proof || <span className="text-ash">—</span>}</td>
      <td className="py-2.5 pr-3"><Pill tone={TONE[c.status]}>{c.status}</Pill><div className="text-xs text-ash mt-1">{formatWhen(c.updated_at)}</div></td>
      <td className="py-2.5 text-right whitespace-nowrap">
        {c.status === 'pending' ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide(c, 'approved')}>Approve</Button>
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
      <p className="text-sm text-ash">
        Leaders of guilds that don&apos;t use Guild Hall. Approving one marks their fill invites as verified. They&apos;re DM&apos;d the outcome when the bot can reach them.
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
