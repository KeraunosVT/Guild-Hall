import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, Upload } from 'lucide-react';
import { fmtDatetime } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import { CURRENCY_LABEL } from '../currencies';
import CurrencyIcon from '../components/ui/CurrencyIcon';

const KIND_FILTERS = [{ key: 'all', label: 'All' }, { key: 'item', label: 'Gear' }, { key: 'currency', label: 'Lucent & Shards' }];

const PRIO_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };
const PRIO_STYLE = {
  'PvP':          { on: 'bg-oxblood text-bone border-transparent',     off: 'border-line text-ash hover:text-bone' },
  'Second Build': { on: 'bg-brass text-ink border-transparent',        off: 'border-line text-ash hover:text-bone' },
  'PvE':          { on: 'bg-emerald-500 text-ink border-transparent',  off: 'border-line text-ash hover:text-bone' },
};

export default function LootHistory() {
  const { user, can, canAny } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [awards, setAwards] = useState([]);
  const [currencyAwards, setCurrencyAwards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [member, setMember] = useState('');
  const [kind, setKind] = useState('all'); // all | item | currency
  const [importing, setImporting] = useState(null); // null | 'item' | 'currency'
  const [importResult, setImportResult] = useState(null);
  const [savingBuild, setSavingBuild] = useState(null); // award id currently being updated

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/loot/catalog'),
      axios.get('/api/admin/loot/awards'),
      axios.get('/api/admin/currency-awards'),
    ])
      .then(([catRes, aw, cur]) => {
        setCatalog(catRes.data);
        setAwards(aw.data.awards || []);
        setCurrencyAwards(cur.data.awards || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load loot history.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // Set or correct which build an award was for — most useful on awards made
  // before builds were tracked, but works to fix a mistagged one too.
  const setBuild = (id, priority) => {
    setSavingBuild(id);
    axios.patch(`/api/admin/loot/awards/${id}`, { priority })
      .then(() => setAwards((prev) => prev.map((a) => (a.id === id ? { ...a, priority } : a))))
      .catch((err) => setError(err.response?.data?.error || 'Failed to set build.'))
      .finally(() => setSavingBuild(null));
  };

  const itemByKey = useMemo(() => {
    if (!catalog) return {};
    return Object.fromEntries(catalog.categories.flatMap((c) => c.items.map((i) => [i.key, { ...i, category: c.label }])));
  }, [catalog]);

  // Items and currency are separate tables with different shapes, flattened
  // into one chronological ledger — "who got what, when" is the question this
  // page answers, and gear and Lucent are both answers to it.
  const entries = useMemo(() => {
    const items = awards.map((a) => ({ ...a, kind: 'item', at: a.awarded_at }));
    const currency = currencyAwards.map((c) => ({ ...c, kind: 'currency', at: c.awarded_at }));
    return [...items, ...currency].sort((a, b) => new Date(b.at) - new Date(a.at));
  }, [awards, currencyAwards]);

  const members = useMemo(() => {
    const m = new Map();
    entries.forEach((e) => { if (e.discord_id && !m.has(e.discord_id)) m.set(e.discord_id, e.display_name || e.discord_id); });
    return [...m.entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
  }, [entries]);

  const filtered = useMemo(() => entries.filter(
    (e) => (!member || e.discord_id === member) && (kind === 'all' || e.kind === kind),
  ), [entries, member, kind]);

  // Both importers share one contract — { imported, skipped, errors[] } — so
  // one handler covers gear and currency; `kind` only decides the endpoint and
  // what the result line calls the rows it counted.
  const handleImport = (kind) => (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setImporting(kind); setImportResult(null); setError('');
    const form = new FormData();
    form.append('file', f);
    const url = kind === 'currency'
      ? '/api/admin/currency-awards/import'
      : '/api/admin/loot/awards/import';
    axios.post(url, form)
      .then((res) => { setImportResult({ ...res.data, kind }); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Import failed.'))
      .finally(() => setImporting(null));
  };

  if (!canAny('loot.awards', 'loot.catalog', 'loot.currency', 'loot.requests')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell maxWidth="max-w-4xl">
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      <div className="panel rounded-lg p-4 mb-6 space-y-3">
        {/* Each importer is gated on the capability its own endpoint checks, so
            an officer only sees the half of the ledger they can write to. */}
        {can('loot.awards') && (
          <ImportRow
            label="Upload gear CSV" busy={importing === 'item'} disabled={Boolean(importing)}
            onPick={handleImport('item')}
            columns="item, member, date (optional), awarded_by (optional), build (optional — PvP / Second Build / PvE)"
          />
        )}
        {can('loot.currency') && (
          <ImportRow
            label="Upload Lucent / shard CSV" busy={importing === 'currency'} disabled={Boolean(importing)}
            onPick={handleImport('currency')}
            columns="member, amount, currency (optional — defaults to Lucent), date (optional), reason (optional), awarded_by (optional)"
          />
        )}
        {importResult && (
          <div className="mt-3 text-sm">
            <span className="text-emerald-400">
              {importResult.imported} {importResult.kind === 'currency' ? 'grant' : 'award'}{importResult.imported === 1 ? '' : 's'} imported
            </span>
            {importResult.skipped > 0 && <span className="text-oxblood ml-3">{importResult.skipped} skipped</span>}
            {importResult.errors?.length > 0 && (
              <ul className="mt-2 text-xs text-ash space-y-0.5 max-h-32 overflow-auto">
                {importResult.errors.map((e, i) => <li key={i}>Row {e.row}: {e.reason}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select value={member} onChange={(e) => setMember(e.target.value)}
          className="bg-panel border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
          <option value="">All members</option>
          {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex items-center gap-1">
          {KIND_FILTERS.map(({ key, label }) => (
            <button key={key} onClick={() => setKind(key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                kind === key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-ash text-sm">{filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}</span>
        <div className="flex-1" />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {loading ? (
        <EmptyState>Reading the ledger…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>
          {entries.length === 0 ? 'Nothing has been awarded yet.'
            : member ? 'Nothing matching for this member.'
              : 'Nothing in this view.'}
        </EmptyState>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {filtered.map((a) => {
            const item = a.kind === 'item' ? itemByKey[a.item_key] : null;
            return (
              // Ids come from two different tables, so the key needs the kind.
              <div key={`${a.kind}-${a.id}`} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  {a.kind === 'currency' ? (
                    // Icon beside the text block rather than above the reason,
                    // so the reason indents under the amount instead of under
                    // the icon. Mirrors how ItemTooltip lays out gear rows.
                    <div className="flex items-center gap-2 min-w-0">
                      <CurrencyIcon currency={a.currency} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono text-brassbright">{a.amount.toLocaleString()}</span>
                          <span className="text-bone">{CURRENCY_LABEL[a.currency] || a.currency}</span>
                        </div>
                        {a.reason && <div className="text-ash/70 text-xs italic truncate" title={a.reason}>{a.reason}</div>}
                      </div>
                    </div>
                  ) : item ? (
                    <ItemTooltip item={item}>
                      <span className={`truncate ${gradeStyle(item.grade)?.color || 'text-bone'}`}>{item.name}</span>
                    </ItemTooltip>
                  ) : (
                    <span className="text-bone truncate">{a.item_key}</span>
                  )}
                </div>
                <div className="text-sm text-brass shrink-0 w-40 truncate">{a.display_name || 'Member'}</div>
                {/* Build only means something for gear, but the column keeps a
                    fixed width on every row: sized to content it collapses to
                    the width of a dash on currency rows, and flex-1 above hands
                    that slack to the first column, so the member name lands in
                    a different place depending on the row type. */}
                <div className="flex gap-1 shrink-0 w-32 justify-end" title={a.kind === 'item' ? 'Build this was awarded for' : undefined}>
                  {a.kind === 'item' ? (catalog?.priorities || []).map((p) => {
                    const st = PRIO_STYLE[p];
                    const active = a.priority === p;
                    return (
                      <button
                        key={p} title={p} disabled={savingBuild === a.id}
                        onClick={() => setBuild(a.id, active ? null : p)}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors disabled:opacity-40 ${active ? st.on : st.off}`}
                      >
                        {PRIO_SHORT[p]}
                      </button>
                    );
                  }) : <span className="text-ash/25 text-[10px]">—</span>}
                </div>
                {/* Fixed width for the same reason as the build column — the
                    timestamp is wider for two-digit dates ("Jul 31") than one. */}
                <div className="text-xs text-ash shrink-0 w-32 text-right">
                  {fmtDatetime(a.at)}
                  {a.awarded_by && <div className="text-ash/60">by {a.awarded_by}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

// One importer row: button plus the columns it expects. Two of these sit on the
// page, so the layout lives in one place rather than being copied per ledger.
function ImportRow({ label, columns, busy, disabled, onPick }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className={`inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg text-sm cursor-pointer transition-colors shrink-0 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
        <Upload className="w-4 h-4" /> {busy ? 'Importing…' : label}
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={onPick} disabled={disabled} />
      </label>
      <span className="text-ash text-xs">Columns: {columns}</span>
    </div>
  );
}
