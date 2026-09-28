import { useState } from 'react';
import axios from 'axios';
import Button from '../../components/ui/Button';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import { inputClass, labelClass, errorOf, useThreatGuilds, GuildOptions, GuildName, Pill } from './shared';

// For leaders whose guild doesn't use Guild Hall. Guild Hall can't see into
// their Discord, so they say which threat-board guild they lead and staff
// confirm it by hand. They can post fill requests while they wait; players see
// "Unverified leader" on those invites until staff approve.

const STATUS = {
  pending: { label: 'Waiting for staff', tone: 'brass' },
  approved: { label: 'Verified', tone: 'good' },
  rejected: { label: 'Not verified', tone: 'bad' },
};

export default function LeaderClaim({ me, onSaved }) {
  const board = useThreatGuilds();
  const claim = me.leader.claim;
  const [editing, setEditing] = useState(!claim);
  const [form, setForm] = useState({ threat_guild_id: claim?.threat_guild_id || '', proof: claim?.proof || '' });
  const [saving, setSaving] = useState(false);
  const [msg, flash] = useFlash();

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await axios.put('/api/fills/claim', form);
      flash('Sent to Guild Hall staff. You can post fill requests now.');
      setEditing(false);
      onSaved?.();
    } catch (err) {
      flash(errorOf(err, 'Could not save your claim.'), false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <p className="text-sm text-ash">
        Leaders of Guild Hall guilds don&apos;t need this — they&apos;re verified by their guild&apos;s own officer roles.
        {me.leader.guilds.length > 0 && <> You already lead {me.leader.guilds.map((g) => g.house).join(', ')} here.</>}
      </p>
      <Toast msg={msg} />
      {claim && !editing && (
        <section className="panel rounded-lg p-5 space-y-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-ash">Guild</dt><dd><GuildName guild={claim.guild} /></dd>
            <dt className="text-ash">Status</dt><dd><Pill tone={STATUS[claim.status].tone}>{STATUS[claim.status].label}</Pill></dd>
            <dt className="text-ash">How to confirm</dt><dd>{claim.proof || '—'}</dd>
          </dl>
          <p className="text-xs text-ash">
            {claim.status === 'approved' && 'Players see “Verified leader” on your invites.'}
            {claim.status === 'pending' && 'You can post requests and invite fills meanwhile. Players see “Unverified leader” until staff confirm.'}
            {claim.status === 'rejected' && 'Staff could not confirm this. You can send it again with more detail, or ask in the Guild Hall Discord.'}
          </p>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {claim.status === 'rejected' ? 'Try again' : 'Change guild'}
          </Button>
        </section>
      )}
      {editing && (
        <form onSubmit={submit} className="panel rounded-lg p-5 space-y-4">
          <div>
            <label className={labelClass} htmlFor="lc-guild">Your guild</label>
            <select id="lc-guild" required className={inputClass} value={form.threat_guild_id}
              onChange={(e) => setForm({ ...form, threat_guild_id: e.target.value })}>
              <option value="">Pick from the threat board…</option>
              <GuildOptions guilds={board.guilds} clusters={board.clusters} />
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="lc-proof">How can staff confirm it?</label>
            <input id="lc-proof" type="text" maxLength={300} className={inputClass} value={form.proof}
              onChange={(e) => setForm({ ...form, proof: e.target.value })}
              placeholder="e.g. I'm Guild Master in-game; happy to post a screenshot" />
          </div>
          <p className="text-xs text-ash">Changing your guild sends the claim back to staff.</p>
          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>{saving ? 'Sending…' : 'Send to staff'}</Button>
            {claim && <Button type="button" variant="neutral" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </form>
      )}
    </div>
  );
}
