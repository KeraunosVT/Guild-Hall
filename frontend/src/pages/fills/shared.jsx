import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { BadgeCheck, ShieldAlert } from 'lucide-react';
import weaponToClass from '../../../../shared/weaponClasses.json';
import { STATUS_META } from '../../threatStatus';

// Shared by every wargame-fill page, on both hosts: inside the guild app's
// sidebar (guild-hall.gg) and on the standalone fill pool (merc.guild-hall.gg).
// The pages take a `base` path for their own links, because the same page sits
// at /admin/fills on one host and /requests on the other.

export const ROLES = ['Tank', 'DPS', 'Healer'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Same list the Classes page offers, so a member's fill profile can say exactly
// what their guild profile says.
export const CLASS_LIST = [...new Set([...Object.values(weaponToClass), 'Oracle (DPS)', 'Seeker (DPS)'])].sort();

// The Discord players are pointed to from the fill pages — for questions,
// finding a group, or a listing staff have paused.
export const DISCORD_INVITE = 'https://discord.gg/Bx4gXYB2uk';

export const inputClass = 'w-full bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass disabled:opacity-60';
export const labelClass = 'eyebrow text-[10px] text-ash block mb-1.5';

export const errorOf = (e, fallback) => e?.response?.data?.error || fallback;

export const browserTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

// "Sat 3 Oct, 21:00" in the viewer's own zone. A leader and a player can be
// continents apart, so every time on these pages is shown in the reader's zone
// and labelled as such once per page, never converted by hand.
export function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function GuildName({ guild, fallback = 'Unknown guild' }) {
  if (!guild) return <span className="text-ash">{fallback}</span>;
  const m = STATUS_META[guild.status];
  return (
    <span className="inline-flex items-center gap-1.5" title={guild.status ? `${guild.status} on the threat board` : undefined}>
      {m && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} />}
      {guild.name}
    </span>
  );
}

export function VerifiedBadge({ verified }) {
  return verified ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
      <BadgeCheck className="w-3.5 h-3.5" /> Verified leader
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300"
      title="Guild Hall staff haven't confirmed this person leads the guild yet"
    >
      <ShieldAlert className="w-3.5 h-3.5" /> Unverified leader
    </span>
  );
}

export function Pill({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'bg-panelup text-ash border-line',
    brass: 'bg-brass/10 text-brassbright border-brass/30',
    good: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-transparent',
    bad: 'bg-oxblood/10 text-oxblood border-transparent',
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export const INVITE_STATUS = {
  invited: { label: 'Awaiting reply', tone: 'brass' },
  accepted: { label: 'Accepted', tone: 'good' },
  declined: { label: 'Declined', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  missed: { label: 'Slot already filled', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

// The threat board, for opponent pickers and home-guild names. Public, so it
// loads for anyone; ordered by cluster then name for the dropdowns.
export function useThreatGuilds() {
  const [state, setState] = useState({ guilds: [], clusters: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/threat-board')
      .then((res) => {
        if (cancelled) return;
        const guilds = (res.data.guilds || []).filter((g) => g.status !== 'Disbanded/Merged');
        setState({ guilds, clusters: res.data.clusters || [], loading: false, error: null, stale: !!res.data.stale });
      })
      .catch((e) => !cancelled && setState({ guilds: [], clusters: [], loading: false, error: errorOf(e, 'Could not load the threat board.') }));
    return () => { cancelled = true; };
  }, []);
  return state;
}

// <option>s grouped by cluster.
export function GuildOptions({ guilds, clusters, exclude = [] }) {
  const order = clusters.map((c) => c.label);
  const groups = order.map((label) => [label, guilds.filter((g) => g.cluster === label && !exclude.includes(g.id))])
    .filter(([, list]) => list.length);
  return groups.map(([label, list]) => (
    <optgroup key={label} label={label}>
      {list.sort((a, b) => a.name.localeCompare(b.name)).map((g) => (
        <option key={g.id} value={g.id}>{g.name} — {g.status}</option>
      ))}
    </optgroup>
  ));
}

// /api/fills/me, which every fills page starts from.
export function useFillsMe() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/fills/me');
      setMe(res.data);
      setError(null);
    } catch (e) {
      setError(errorOf(e, 'Could not load the fill pool.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { me, error, reload: load };
}
