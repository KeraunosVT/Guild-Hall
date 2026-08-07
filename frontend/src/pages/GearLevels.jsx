import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, History } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';
import Modal from '../components/ui/Modal';
import { fmtDatetime } from '../timeUtils';

const MAX_LEVEL = 80;
const isMaxed = (e) => e.weapon === MAX_LEVEL && e.armor === MAX_LEVEL && e.accessory === MAX_LEVEL;

const COLUMNS = [
  { key: 'display_name', label: 'Member', align: 'left' },
  { key: 'weapon', label: 'Weapon', align: 'right' },
  { key: 'armor', label: 'Armor', align: 'right' },
  { key: 'accessory', label: 'Accessory', align: 'right' },
  { key: 'average', label: 'Average', align: 'right' },
  { key: 'maxed_at', label: 'Maxed', align: 'right' },
];

export default function GearLevels() {
  const { user, can } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState('average');
  const [sortDir, setSortDir] = useState('desc');

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/admin/gear-ilvl')
      .then((res) => setEntries(res.data.entries || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load gear levels.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'display_name' ? 'asc' : 'desc'); }
  };

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = entries.filter((e) => (e.display_name || '').toLowerCase().includes(f));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      // Members who've hit 80/80/80 keep a fixed order among themselves —
      // first to achieve it ranks first — instead of being reshuffled every
      // time they're tied at the cap.
      if (sortKey === 'average' && isMaxed(a) && isMaxed(b)) {
        return new Date(a.maxed_at || 0) - new Date(b.maxed_at || 0);
      }
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [entries, filter, sortKey, sortDir]);

  const guildAverage = useMemo(() => {
    if (entries.length === 0) return 0;
    return entries.reduce((sum, e) => sum + (Number(e.average) || 0), 0) / entries.length;
  }, [entries]);

  const [historyMember, setHistoryMember] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openHistory = (entry) => {
    setHistoryMember(entry);
    setHistoryLoading(true);
    axios.get(`/api/admin/gear-ilvl/${entry.discord_id}/history`)
      .then((res) => setHistoryEntries(res.data.entries || []))
      .catch(() => setHistoryEntries([]))
      .finally(() => setHistoryLoading(false));
  };

  if (!can('gear')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-4">
          {!loading && !error && (
            <>
              <span className="text-sm text-ash">Guild average <span className="text-brassbright font-mono">{guildAverage.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></span>
              <span className="text-sm text-ash">{rows.length} submitted</span>
            </>
          )}
          <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <EmptyState>Reading the vault…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No one has submitted their gear yet.</EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]">
          <Thead sticky>
            {COLUMNS.map((c) => (
              <SortableTh key={c.key} label={c.label} sortKey={c.key} activeKey={sortKey} dir={sortDir} onSort={sortBy} align={c.align} />
            ))}
            <th className="p-4 w-10"></th>
          </Thead>
          <tbody>
            {rows.map((e) => (
              <Tr key={e.discord_id}>
                <td className="p-4 text-bone font-semibold">{e.display_name || 'Member'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.weapon || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.armor || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.accessory || '—'}</td>
                <td className="p-4 text-right font-mono text-brassbright">{e.average || '—'}</td>
                <td className="p-4 text-right text-ash text-xs">{e.maxed_at ? fmtDatetime(e.maxed_at) : '—'}</td>
                <td className="p-4 text-center">
                  <button onClick={() => openHistory(e)} className="text-ash hover:text-brass" title="View submission history">
                    <History className="w-3.5 h-3.5" />
                  </button>
                </td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {historyMember && (
        <Modal onClose={() => setHistoryMember(null)} maxWidth="max-w-lg" scrollable>
          <div className="eyebrow text-brass text-[11px] mb-3">Gear Level History</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-4">{historyMember.display_name || 'Member'}</h2>
          {historyLoading ? (
            <p className="text-ash text-sm">Loading…</p>
          ) : historyEntries.length === 0 ? (
            <p className="text-ash text-sm">No submission history on file.</p>
          ) : (
            <div className="space-y-2">
              {historyEntries.map((h) => (
                <div key={h.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                  <span className="text-ash text-xs w-36 shrink-0">{fmtDatetime(h.submitted_at)}</span>
                  <span className="font-mono text-bone">W {h.weapon}</span>
                  <span className="font-mono text-bone">A {h.armor}</span>
                  <span className="font-mono text-bone">Ac {h.accessory}</span>
                  <span className="font-mono text-brassbright ml-auto">Avg {h.average}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </PageShell>
  );
}
