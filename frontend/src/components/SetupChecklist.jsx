import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { useGuild } from '../guild';

// Shown on Home to officers who can change Guild Settings — the people who can
// act on either part of it:
//
//   · a BILLING banner when the subscription has lapsed and the guild is in
//     its grace period, with the date it closes. Not dismissable: it's the one
//     thing here that ends with the hall locked.
//   · a SETUP checklist for a new guild, derived from what exists (see GET
//     /api/admin/settings/setup-status), so it can't claim a step is done that
//     isn't. Dismissable per browser once someone has seen it.

const STEPS = [
  { key: 'channels', label: 'Choose the channels the bot posts rosters, LOAs and announcements in', to: '/admin/settings' },
  { key: 'member_roles', label: 'Pick which Discord roles count as members on the roster', to: '/admin/settings' },
  { key: 'event_schedule', label: 'Add your recurring events — LOA and attendance key off them', to: '/admin' },
  { key: 'first_match', label: 'Upload your first wargame scoreboard', to: '/admin' },
];

const LAPSED = new Set(['past_due', 'paused', 'canceled']);
const dismissKey = (guildId) => `gh_setup_dismissed_${guildId}`;
const readDismissed = (guildId) => { try { return localStorage.getItem(dismissKey(guildId)) === '1'; } catch { return false; } };

export default function SetupChecklist() {
  const { can } = useAuth();
  const { activeGuildId: guildId } = useGuild();
  const allowed = can('settings');
  const [status, setStatus] = useState(null);
  const [billing, setBilling] = useState(null);
  const [dismissed, setDismissed] = useState(() => readDismissed(guildId));

  useEffect(() => {
    if (!allowed) return;
    axios.get('/api/admin/settings/setup-status').then((r) => setStatus(r.data)).catch(() => setStatus(null));
    axios.get('/api/admin/settings/billing').then((r) => setBilling(r.data)).catch(() => setBilling(null));
  }, [allowed, guildId]);

  if (!allowed) return null;

  const lapsed = billing && !billing.comped && LAPSED.has(billing.status) && billing.grace_until;
  const remaining = status ? STEPS.filter((s) => !status[s.key]) : [];
  const showChecklist = status && remaining.length > 0 && !dismissed;
  if (!lapsed && !showChecklist) return null;

  const dismiss = () => {
    try { localStorage.setItem(dismissKey(guildId), '1'); } catch { /* private window */ }
    setDismissed(true);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 pt-8 space-y-4">
      {lapsed && (
        <div className="px-5 py-4 border border-oxblood/60 bg-oxblooddeep/25 rounded-xl text-sm">
          <div className="text-bone font-semibold mb-1">Your subscription needs attention</div>
          <p className="text-ash">
            The last payment didn't go through or the subscription was cancelled. The hall stays open until{' '}
            <span className="text-bone">{new Date(billing.grace_until).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>,
            then closes until it's renewed. Nothing is deleted.
          </p>
          <Link to="/admin/settings#billing" className="inline-block mt-2 text-brassbright underline underline-offset-4">Manage billing</Link>
        </div>
      )}

      {showChecklist && (
        <div className="px-5 py-4 border border-line bg-panel rounded-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="eyebrow text-brass text-[10px] mb-1">Getting started</div>
              <div className="text-bone font-semibold">Finish setting up your hall</div>
            </div>
            <button onClick={dismiss} className="text-xs text-ash hover:text-bone shrink-0">Hide</button>
          </div>
          <ul className="mt-3 space-y-2">
            {STEPS.map((s) => {
              const done = status[s.key];
              return (
                <li key={s.key} className="flex items-start gap-3 text-sm">
                  <span className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center text-[10px] shrink-0 ${done ? 'bg-brass border-brass text-ink' : 'border-line'}`}>
                    {done ? '✓' : ''}
                  </span>
                  {done
                    ? <span className="text-ash line-through">{s.label}</span>
                    : <Link to={s.to} className="text-bone hover:text-brassbright">{s.label}</Link>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
