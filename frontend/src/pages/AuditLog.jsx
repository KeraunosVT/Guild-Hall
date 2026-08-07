import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { Table, Thead, Tr } from '../components/ui/Table';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import { fmtDatetime } from '../timeUtils';

const LIMIT = 50;

const METHOD_STYLE = {
  POST: 'text-emerald-400',
  PUT: 'text-brassbright',
  PATCH: 'text-brassbright',
  DELETE: 'text-oxblood',
};

export default function AuditLog() {
  const { user, can } = useAuth();
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [feature, setFeature] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/admin/audit-log', {
      params: {
        page, limit: LIMIT,
        discord_id: discordId || undefined,
        feature: feature || undefined,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
      },
    })
      .then((res) => { setEntries(res.data.entries || []); setTotal(res.data.total || 0); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the audit log.'))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [page, discordId, feature, fromDate, toDate]);

  // Filter option lists derived from whatever's currently loaded, same idiom
  // as LootHistory.jsx's member dropdown — no separate lookup endpoint.
  const members = useMemo(() => {
    const m = new Map();
    entries.forEach((e) => { if (e.discord_id && !m.has(e.discord_id)) m.set(e.discord_id, e.display_name || e.discord_id); });
    return [...m.entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
  }, [entries]);
  const features = useMemo(() => [...new Set(entries.map((e) => e.feature).filter(Boolean))].sort(), [entries]);

  const resetToFirstPage = (setter) => (value) => { setPage(1); setter(value); };

  if (!can('audit')) {
    return <RestrictedGate />;
  }

  const totalPages = Math.max(Math.ceil(total / LIMIT), 1);

  return (
    <PageShell maxWidth="max-w-6xl">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select value={discordId} onChange={(e) => resetToFirstPage(setDiscordId)(e.target.value)}
          className="bg-panel border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
          <option value="">All members</option>
          {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={feature} onChange={(e) => resetToFirstPage(setFeature)(e.target.value)}
          className="bg-panel border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
          <option value="">All features</option>
          {features.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="flex items-center gap-2 text-sm text-ash">
          <input type="date" value={fromDate} onChange={(e) => resetToFirstPage(setFromDate)(e.target.value)}
            className="bg-panel border border-line rounded-lg px-3 py-2 text-bone text-sm focus:outline-none focus:border-brass" />
          <span>to</span>
          <input type="date" value={toDate} onChange={(e) => resetToFirstPage(setToDate)(e.target.value)}
            className="bg-panel border border-line rounded-lg px-3 py-2 text-bone text-sm focus:outline-none focus:border-brass" />
        </div>
        <span className="text-ash text-sm">{total} entr{total === 1 ? 'y' : 'ies'}</span>
        <div className="flex-1" />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {error ? (
        <ErrorState title="The ledger couldn't be read" message={error} onRetry={load} />
      ) : loading ? (
        <EmptyState>Reading the ledger…</EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState>No matching writes on record.</EmptyState>
      ) : (
        <>
          <Table minWidth="min-w-[900px]">
            <Thead>
              <th className="text-left p-2.5 font-normal">When</th>
              <th className="text-left p-2.5 font-normal">Member</th>
              <th className="text-left p-2.5 font-normal">Feature</th>
              <th className="text-left p-2.5 font-normal">Method</th>
              <th className="text-left p-2.5 font-normal">Path</th>
              <th className="text-left p-2.5 font-normal">Payload</th>
            </Thead>
            <tbody>
              {entries.map((e) => (
                <Tr key={e.id}>
                  <td className="p-2.5 whitespace-nowrap text-ash text-xs">{fmtDatetime(e.created_at)}</td>
                  <td className="p-2.5 whitespace-nowrap text-brass">{e.display_name || e.discord_id}</td>
                  <td className="p-2.5 whitespace-nowrap text-bone">{e.feature || '—'}</td>
                  <td className={`p-2.5 whitespace-nowrap font-mono text-xs ${METHOD_STYLE[e.method] || 'text-ash'}`}>{e.method}</td>
                  <td className="p-2.5 whitespace-nowrap font-mono text-xs text-ash">{e.path}</td>
                  <td className="p-2.5 font-mono text-xs text-ash/70 max-w-xs truncate" title={JSON.stringify(e.body)}>
                    {e.body && Object.keys(e.body).length > 0 ? JSON.stringify(e.body) : '—'}
                  </td>
                </Tr>
              ))}
            </tbody>
          </Table>

          <div className="flex items-center justify-between mt-4">
            <span className="text-ash text-sm">Page {page} of {totalPages}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1}
                className="inline-flex items-center gap-1 text-sm text-ash hover:text-brass transition-colors disabled:opacity-30 disabled:pointer-events-none">
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <button onClick={() => setPage((p) => Math.min(p + 1, totalPages))} disabled={page >= totalPages}
                className="inline-flex items-center gap-1 text-sm text-ash hover:text-brass transition-colors disabled:opacity-30 disabled:pointer-events-none">
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
