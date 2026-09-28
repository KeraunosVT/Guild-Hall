import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { AlertTriangle } from 'lucide-react';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import { GuildName, VerifiedBadge, Pill, INVITE_STATUS, formatWhen, errorOf } from './shared';

// A player's invites. Accepting is a race when a leader has invited more
// players than slots — the server settles it (fill_accept_invite in
// migrations/saas_009), and the loser is told the slot filled first.

function InviteCard({ invite, onAnswer, busy }) {
  const r = invite.request;
  const s = INVITE_STATUS[invite.status] || INVITE_STATUS.invited;
  const open = invite.status === 'invited';
  const upcoming = new Date(r.starts_at).getTime() > Date.now();
  return (
    <article className="panel rounded-lg p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg tracking-wide">
          {r.guild_label} <span className="text-ash text-sm">vs</span> <GuildName guild={r.opponent} />
        </h3>
        {!open && <Pill tone={s.tone}>{s.label}</Pill>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <VerifiedBadge verified={r.verified} />
        <Pill>{invite.role}</Pill>
        <span className="text-ash tabular-nums">{formatWhen(r.starts_at)} · {r.duration_min} min</span>
      </div>
      <p className="text-xs text-ash">
        {r.filled[invite.role]} of {r.slots[invite.role]} {invite.role} slots filled · from {r.leader_name}
        {r.from_guild_hall ? ', a Guild Hall guild' : ''}
      </p>
      {r.notes && <p className="text-sm">{r.notes}</p>}
      {invite.clashes.length > 0 && (
        <div className="flex gap-2 text-sm rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-300 shrink-0 mt-0.5" />
          <span>
            Overlaps a wargame you already accepted:{' '}
            {invite.clashes.map((c) => `${c.guild_label} vs ${c.opponent} at ${formatWhen(c.starts_at)}`).join('; ')}.
          </span>
        </div>
      )}
      {open && upcoming && (
        <div className="flex gap-3">
          <Button size="sm" disabled={busy} onClick={() => onAnswer(invite, 'accept')}>Accept</Button>
          <Button size="sm" variant="neutral" disabled={busy} onClick={() => onAnswer(invite, 'decline')}>Decline</Button>
        </div>
      )}
      {invite.status === 'accepted' && upcoming && r.status === 'open' && (
        <Button size="none" variant="destructive" className="text-sm" disabled={busy} onClick={() => onAnswer(invite, 'decline')}>
          Drop out
        </Button>
      )}
    </article>
  );
}

export default function FillInvites({ onChange }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/invites');
      setList(res.data.invites);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load your invites.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const answer = async (invite, verb) => {
    setBusy(true);
    try {
      await axios.post(`/api/fills/invites/${invite.id}/${verb}`);
      flash(verb === 'accept'
        ? `You're in. ${invite.request.leader_name} has been told.`
        : 'Done. The slot is open again for the leader.');
    } catch (e) {
      flash(errorOf(e, 'Could not answer that invite.'), false);
    } finally {
      setBusy(false);
      load();
      onChange?.();
    }
  };

  if (error) return <p className="text-oxblood">{error}</p>;
  if (!list) return <EmptyState>Checking for invites…</EmptyState>;

  const pending = list.filter((i) => i.status === 'invited');
  const rest = list.filter((i) => i.status !== 'invited');
  return (
    <div className="space-y-6">
      <Toast msg={msg} />
      <p className="text-xs text-ash">Times are shown in your timezone. Invites also arrive as a Discord DM when the Guild Hall bot can reach you.</p>
      {pending.length === 0
        ? <div className="panel rounded-lg p-8 text-center text-ash">No open invites. Keep your profile listed and leaders will find you.</div>
        : <div className="grid gap-4 lg:grid-cols-2">{pending.map((i) => <InviteCard key={i.id} invite={i} onAnswer={answer} busy={busy} />)}</div>}
      {rest.length > 0 && (
        <>
          <div className="eyebrow text-[10px] text-ash">Answered</div>
          <div className="grid gap-4 lg:grid-cols-2">{rest.map((i) => <InviteCard key={i.id} invite={i} onAnswer={answer} busy={busy} />)}</div>
        </>
      )}
    </div>
  );
}
