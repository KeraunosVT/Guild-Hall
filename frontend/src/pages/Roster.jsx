import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';
import Tabs from '../components/ui/Tabs';

const fmt = (n) => (Number(n) || 0).toLocaleString();
const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';
const fmtAvg = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

// Class-group filter — a member's primary_class (their most-played class,
// computed server-side from match history) maps to one of these groups.
const CLASS_GROUPS = {
  Gladiator: 'Melee', Shadowdancer: 'Melee',
  Enigma: 'Range', Spellblade: 'Range', Raider: 'Range', Lunarch: 'Range',
  Scorpion: 'Kill Squad', Infiltrator: 'Kill Squad', Ravager: 'Kill Squad',
  Seeker: 'Healers', Oracle: 'Healers',
};
const CLASS_GROUP_TABS = [
  { key: '', label: 'All' },
  { key: 'Melee', label: 'Melee' },
  { key: 'Range', label: 'Range' },
  { key: 'Kill Squad', label: 'Kill Squad' },
  { key: 'Healers', label: 'Healers' },
];

const PLAYER_COL = { key: 'player_name', label: 'Player', align: 'left', render: (p) => <Link to={`/roster/${encodeURIComponent(p.player_name)}`} className={`hover:text-brassbright transition-colors ${p.is_member ? 'text-emerald-400' : 'text-ash'}`}>{p.player_name}</Link>, cls: 'font-semibold' };
const MATCHES_COL = { key: 'matches', label: 'Matches', align: 'right', render: (p) => fmt(p.matches) };

const TABS = {
  totals: {
    label: 'Totals',
    columns: [
      PLAYER_COL,
      MATCHES_COL,
      { key: 'kills',        label: 'Kills',     align: 'right', render: (p) => fmt(p.kills), cls: 'text-brassbright' },
      { key: 'assists',      label: 'Assists',   align: 'right', render: (p) => fmt(p.assists) },
      { key: 'ka',           label: 'K+A',       align: 'right', render: (p) => fmt(p.ka), cls: 'text-brassbright' },
      { key: 'damage_dealt', label: 'Dmg Dealt', align: 'right', render: (p) => fmtM(p.damage_dealt) },
      { key: 'damage_taken', label: 'Dmg Taken', align: 'right', render: (p) => fmtM(p.damage_taken) },
      { key: 'healing',      label: 'Healing',   align: 'right', render: (p) => fmtM(p.healing) },
    ],
    defaultSort: 'kills',
  },
  averages: {
    label: 'Averages',
    columns: [
      PLAYER_COL,
      MATCHES_COL,
      { key: 'avg_kills',   label: 'Avg Kills',   align: 'right', render: (p) => fmtAvg(p.avg_kills), cls: 'text-brassbright' },
      { key: 'avg_assists', label: 'Avg Assists',  align: 'right', render: (p) => fmtAvg(p.avg_assists) },
      { key: 'avg_ka',      label: 'Avg K+A',      align: 'right', render: (p) => fmtAvg(p.avg_ka), cls: 'text-brassbright' },
      { key: 'avg_dealt',   label: 'Avg Dmg',      align: 'right', render: (p) => fmtM(p.avg_dealt) },
      { key: 'avg_taken',   label: 'Avg Dmg Taken', align: 'right', render: (p) => fmtM(p.avg_taken) },
      { key: 'avg_healing', label: 'Avg Healing',  align: 'right', render: (p) => fmtM(p.avg_healing) },
    ],
    defaultSort: 'avg_kills',
  },
};

export default function Roster() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [membersOnly, setMembersOnly] = useState(true);
  const [lastTen, setLastTen] = useState(false);
  const [classGroup, setClassGroup] = useState('');
  const [tab, setTab] = useState('totals');
  const [sortKey, setSortKey] = useState('kills');
  const [sortDir, setSortDir] = useState('desc');

  const fetchPlayers = () => {
    setLoading(true); setError(false);
    axios.get(`/api/players${lastTen ? '?last=10' : ''}`)
      .then((res) => setPlayers((res.data.players || []).map((p) => {
        const m = Number(p.matches) || 0;
        const per = (v) => (m ? (Number(v) || 0) / m : 0);
        return {
          ...p,
          ka: (Number(p.kills) || 0) + (Number(p.assists) || 0),
          avg_kills: per(p.kills),
          avg_assists: per(p.assists),
          avg_ka: per((Number(p.kills) || 0) + (Number(p.assists) || 0)),
          avg_dealt: per(p.damage_dealt),
          avg_taken: per(p.damage_taken),
          avg_healing: per(p.healing),
        };
      })))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPlayers(); }, [lastTen]);

  const switchTab = (key) => {
    setTab(key);
    setSortKey(TABS[key].defaultSort);
    setSortDir('desc');
  };

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'player_name' ? 'asc' : 'desc'); }
  };

  const columns = TABS[tab].columns;

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = players.filter((p) =>
      (p.player_name || '').toLowerCase().includes(f)
      && (!membersOnly || p.is_member)
      && (!classGroup || CLASS_GROUPS[p.primary_class] === classGroup)
    );
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [players, filter, sortKey, sortDir, membersOnly, classGroup]);

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-4">
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
            className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
          />
          <button onClick={() => setMembersOnly((v) => !v)}
            className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 cursor-pointer shrink-0" title="Toggle current members only">
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${membersOnly ? 'bg-emerald-500 text-ink' : 'text-ash'}`}>Members</span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${!membersOnly ? 'bg-brass text-ink' : 'text-ash'}`}>All</span>
          </button>
          <button onClick={() => setLastTen((v) => !v)}
            className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 cursor-pointer shrink-0" title="Toggle last 10 matches">
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${!lastTen ? 'bg-brass text-ink' : 'text-ash'}`}>All Time</span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${lastTen ? 'bg-oxblood text-bone' : 'text-ash'}`}>Last 10</span>
          </button>
          <Tabs items={CLASS_GROUP_TABS} active={classGroup} onChange={setClassGroup} />
          <Tabs
            items={Object.entries(TABS).map(([key, t]) => ({ key, label: t.label }))}
            active={tab}
            onChange={switchTab}
          />
        </div>
        {!loading && !error && <span className="text-sm text-ash shrink-0">{rows.length} members</span>}
      </div>

      {error ? (
        <ErrorState title="The roll is sealed" message="The record couldn't be read. Try again." onRetry={fetchPlayers} />
      ) : loading ? (
        <EmptyState>Reading the roll…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No members on record yet.</EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]">
          <Thead sticky>
            <th className="p-2.5 text-center font-normal w-12">#</th>
            {columns.map((c) => (
              <SortableTh key={c.key} label={c.label} sortKey={c.key} activeKey={sortKey} dir={sortDir} onSort={sortBy} align={c.align} dense />
            ))}
          </Thead>
          <tbody>
            {rows.map((p, i) => (
              <Tr key={p.player_name + i}>
                <td className="p-2.5 text-center font-mono text-ash">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.key} className={`p-2.5 whitespace-nowrap ${c.align === 'right' ? 'text-right font-mono' : ''} ${c.cls || 'text-bone'}`}>
                    {c.render(p)}
                  </td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </PageShell>
  );
}
