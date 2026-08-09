import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { X, Check, Ban, Coins, Plus, Pencil, Trash2, RotateCcw, ChevronDown } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import { fmtDatetime } from '../timeUtils';
import CurrencyIcon from '../components/ui/CurrencyIcon';

// Requests move pending -> approved -> paid, with denied as a dead end that can
// be reopened. Only 'paid' has a side effect (it writes the Lucent grant), which
// is why it's reachable from 'approved' rather than straight from 'pending' —
// and why every step except that one is freely reversible. Undoing a payment
// isn't offered here: the grant already exists, so it has to be revoked on the
// Lucent & Shards ledger first or the two would disagree.
const STATUS_META = {
  pending: { label: 'Pending', cls: 'text-brass border-brass/40' },
  approved: { label: 'Approved', cls: 'text-sky-400 border-sky-400/40' },
  paid: { label: 'Paid', cls: 'text-emerald-400 border-emerald-400/40' },
  denied: { label: 'Denied', cls: 'text-ash border-line' },
};
const FILTERS = ['open', 'pending', 'approved', 'paid', 'denied', 'all'];
const FILTER_LABEL = { open: 'Open', all: 'All', ...Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])) };

// The two request types the guild actually runs. request_type stays free text in
// the database — these are the named ones, always offered and always filterable
// even before anything has been logged under them, which a datalist built from
// existing rows can't do on its own.
const TYPES = ['Partial Refund', 'Partial Fund'];
// Matched case-insensitively so "partial fund" typed by hand still lands in the
// right bucket rather than falling through to Other.
const normType = (t) => TYPES.find((k) => k.toLowerCase() === String(t || '').trim().toLowerCase()) || null;
const TYPE_FILTERS = ['all', ...TYPES, 'other'];
const TYPE_FILTER_LABEL = { all: 'All types', other: 'Other' };

const OTHER = '__other__';
const POTENTIAL = '__potential__';

export default function LootRequests() {
  const { user, can } = useAuth();
  const [members, setMembers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [requests, setRequests] = useState([]);
  // Auction-house floors for potentials, refreshed by the standalone scraper.
  const [market, setMarket] = useState({ items: [], fetched_at: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('open');
  const [typeFilter, setTypeFilter] = useState('all');
  const [msg, flash] = useFlash(3500);

  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ amount: '', note: '', request_type: '' });

  const load = () => {
    Promise.all([
      axios.get('/api/admin/members'),
      axios.get('/api/loot/catalog'),
      axios.get('/api/admin/lucent-requests'),
      // Prices are a nice-to-have: a scraper that's off or mid-refresh must not
      // stop requests being logged, so this resolves to empty rather than
      // rejecting the whole Promise.all.
      axios.get('/api/admin/market-potentials').catch(() => ({ data: { items: [], fetched_at: null } })),
    ])
      .then(([mem, cat, reqs, mkt]) => {
        setMembers(mem.data.members || []);
        setCatalog(cat.data.categories || []);
        setRequests(reqs.data.requests || []);
        setMarket({ items: mkt.data.items || [], fetched_at: mkt.data.fetched_at || null });
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load Lucent requests.'));
  };
  useEffect(() => { load(); }, []);

  // Status sorts by where it sits in the workflow, not alphabetically —
  // "approved, denied, paid, pending" tells you nothing, whereas grouping the
  // ones still needing action ahead of the settled ones is the point of sorting
  // by it at all.
  const STATUS_ORDER = { pending: 0, approved: 1, paid: 2, denied: 3 };
  const COMPARE = {
    member: (a, b) => (a.display_name || '').localeCompare(b.display_name || ''),
    item: (a, b) => (a.item_name || '').localeCompare(b.item_name || ''),
    // Untyped rows sort last either way rather than clumping under '' at the top.
    type: (a, b) => (a.request_type || '￿').localeCompare(b.request_type || '￿'),
    amount: (a, b) => a.amount - b.amount,
    status: (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
    date: (a, b) => String(a.requested_at).localeCompare(String(b.requested_at)),
  };

  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });

  // First click on a column picks the direction that's useful for its type:
  // newest and largest first for dates and amounts, A–Z for names. Clicking the
  // same column again flips it.
  const toggleSort = (key) => setSort((s) => (
    s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'date' || key === 'amount' ? 'desc' : 'asc' }
  ));

  // Split out so the type chips can count against it. Counting them against
  // every request instead made a chip read "(9)" while its list showed nothing,
  // because the status filter had already excluded all nine.
  const byStatus = useMemo(() => (
    filter === 'all' ? requests
      : filter === 'open' ? requests.filter((r) => r.status === 'pending' || r.status === 'approved')
        : requests.filter((r) => r.status === filter)
  ), [requests, filter]);

  // 'other' is anything that isn't one of the two named types, including
  // untyped rows — so the three type filters partition the list exactly.
  const ofType = (rows, t) => (
    t === 'all' ? rows
      : t === 'other' ? rows.filter((r) => !normType(r.request_type))
        : rows.filter((r) => normType(r.request_type) === t)
  );

  const shown = useMemo(() => {
    const base = ofType(byStatus, typeFilter);
    const cmp = COMPARE[sort.key] || COMPARE.date;
    // Ties fall back to newest-first so the order is stable and predictable
    // rather than however the rows happened to arrive.
    return [...base].sort((a, b) => {
      const primary = cmp(a, b) * (sort.dir === 'asc' ? 1 : -1);
      return primary || -COMPARE.date(a, b);
    });
  }, [byStatus, typeFilter, sort]);

  // Lucent in the rows currently on screen, split by type. Deliberately computed
  // over `shown` rather than all requests: the number has to answer "what am I
  // looking at", so it moves with both filters. Denied rows are included when
  // they're displayed — a total that quietly disagreed with the list above it
  // would be worse than one that follows it.
  const totals = useMemo(() => {
    const out = { total: 0, byType: Object.fromEntries(TYPES.map((t) => [t, 0])), other: 0 };
    shown.forEach((r) => {
      out.total += r.amount;
      const t = normType(r.request_type);
      if (t) out.byType[t] += r.amount; else out.other += r.amount;
    });
    return out;
  }, [shown]);

  // Lucent already committed but not yet handed over — the number an officer
  // needs before promising anything else.
  const owed = useMemo(
    () => requests.filter((r) => r.status === 'approved').reduce((sum, r) => sum + r.amount, 0),
    [requests],
  );
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  // Priced by potentialId — the stable integer tl-tracker keys off, so a
  // retitled potential still resolves. The label map is a fallback for requests
  // logged as free text before potentials could be picked, which gets those a
  // price too wherever the name happens to line up.
  const priceById = useMemo(
    () => new Map(market.items.filter((i) => i.floor != null).map((i) => [i.potentialId, i])),
    [market],
  );
  const priceByLabel = useMemo(
    () => new Map(market.items.filter((i) => i.floor != null)
      .map((i) => [String(i.label).trim().toLowerCase(), i])),
    [market],
  );
  const priceFor = (r) => priceById.get(r.potential_id)
    || priceByLabel.get(String(r.item_name || '').trim().toLowerCase())
    || null;

  // Only potentials that are actually on the market are offerable — picking one
  // with no floor would promise a price the next screen can't show.
  const pickablePotentials = useMemo(
    () => market.items.filter((i) => i.floor != null)
      .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [market],
  );

  const marketAge = useMemo(() => {
    if (!market.fetched_at) return null;
    const mins = Math.round((Date.now() - Date.parse(market.fetched_at)) / 60000);
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  }, [market]);

  // The two named types first, then anything else already in use. Seeding them
  // means they're suggested from day one rather than only after someone has
  // typed one by hand; the field stays free text either way, and this keeps
  // 'Partial Fund' and 'partial fund' from fragmenting one category.
  const knownTypes = useMemo(() => {
    const used = requests.map((r) => r.request_type).filter(Boolean);
    const extra = [...new Set(used.filter((t) => !normType(t)))].sort();
    return [...TYPES, ...extra];
  }, [requests]);

  const create = (body) => {
    setBusy(true);
    axios.post('/api/admin/lucent-requests', body)
      .then(() => { load(); flash('Request logged.'); })
      .catch((err) => flash(err.response?.data?.error || 'Failed to log request.', false))
      .finally(() => setBusy(false));
  };

  const patch = (id, body, okMsg) => {
    axios.patch(`/api/admin/lucent-requests/${id}`, body)
      .then(() => { setEditingId(null); load(); if (okMsg) flash(okMsg); })
      .catch((err) => flash(err.response?.data?.error || 'Update failed.', false));
  };

  const setStatus = (r, status) => {
    if (status === 'paid' && !window.confirm(
      `Mark paid and record a grant of ${r.amount.toLocaleString()} Lucent to ${r.display_name || r.discord_id}?\n\n`
      + 'This adds a row to the Lucent & Shards ledger.',
    )) return;
    const msg = status === 'paid' ? 'Marked paid — Lucent grant recorded.'
      : status === 'pending' && r.status === 'approved' ? 'Approval undone — back to pending.'
        : status === 'pending' ? 'Reopened.'
          : `Marked ${status}.`;
    patch(r.id, { status }, msg);
  };

  const remove = (r) => {
    if (!window.confirm(`Delete this request for ${r.item_name}?${r.currency_award_id ? '\n\nThe Lucent grant it created stays in the ledger.' : ''}`)) return;
    axios.delete(`/api/admin/lucent-requests/${r.id}`)
      .then(() => { load(); flash('Request deleted.'); })
      .catch((err) => flash(err.response?.data?.error || 'Delete failed.', false));
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setEdit({
      amount: String(r.amount), note: r.note || '', request_type: r.request_type || '',
      item_name: r.item_name || '',
    });
  };

  // Every catalog item and every market-priced potential, as one suggestion
  // list. Flat rather than grouped because a datalist has no optgroups.
  const itemSuggestions = useMemo(() => {
    const names = [];
    catalog.forEach((c) => (c.items || []).forEach((i) => names.push(i.name)));
    pickablePotentials.forEach((p) => names.push(p.label));
    return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [catalog, pickablePotentials]);

  // Turn a typed name back into whatever it actually is: a catalog item, a
  // market potential, or neither. Anything unrecognised stays free text —
  // Lucent buys from the auction house, so plenty of requests name gear the
  // guild's drop table has never listed.
  const resolveItemName = (name) => {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    for (const c of catalog) {
      const hit = (c.items || []).find((i) => String(i.name).toLowerCase() === q);
      if (hit) return { item_key: hit.key, item_name: hit.name, potential_id: null };
    }
    const pot = pickablePotentials.find((p) => String(p.label).toLowerCase() === q);
    if (pot) return { item_key: null, item_name: pot.label, potential_id: pot.potentialId };
    return { item_key: null, item_name: String(name).trim().slice(0, 200), potential_id: null };
  };

  // Only send the item fields when the NAME ACTUALLY CHANGED.
  //
  // Re-resolving on every save would quietly break renames: edit a note on a
  // request whose catalog item has since been renamed, and the stored name no
  // longer matches anything, so it would resolve to free text and drop the
  // item_key — losing the link to the catalog for a save that never touched
  // the item. Untouched name, untouched item fields.
  const saveEdit = (r) => {
    const body = { amount: edit.amount, note: edit.note, request_type: edit.request_type };
    const typed = String(edit.item_name || '').trim();
    if (typed && typed !== String(r.item_name || '').trim()) {
      Object.assign(body, resolveItemName(typed));
    }
    patch(r.id, body, 'Request updated.');
  };

  if (!can('loot.requests')) return <RestrictedGate />;

  return (
    <PageShell maxWidth="max-w-none" paddingX="px-2">
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <Toast msg={msg} />

      <p className="text-sm text-ash mb-5">
        Log what members have asked for so requests don&apos;t live only in Discord. Marking one paid records the
        Lucent grant on the <span className="text-bone">Lucent &amp; Shards</span> ledger, so it&apos;s only entered once.
      </p>

      <datalist id="lucent-request-items">
        {itemSuggestions.map((n) => <option key={n} value={n} />)}
      </datalist>
      <datalist id="lucent-request-types">
        {knownTypes.map((t) => <option key={t} value={t} />)}
      </datalist>

      <div className="panel rounded-lg p-6 space-y-6">
        <RequestForm members={members} catalog={catalog} busy={busy} onCreate={create}
          potentials={pickablePotentials} marketAge={marketAge} />

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors ${
                  filter === f ? 'bg-brass text-ink' : 'text-ash hover:text-bone border border-line'}`}>
                {FILTER_LABEL[f]}
                {f === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {owed > 0 && (
            <span className="text-xs text-ash">
              Approved, not yet paid: <span className="font-mono text-brassbright">{owed.toLocaleString()}</span> Lucent
            </span>
          )}
        </div>

        {/* Type filter — a second axis, so it stacks with the status row above
            rather than replacing it (e.g. pending + Partial Refund). */}
        <div className="flex items-center gap-1 flex-wrap -mt-3">
          {TYPE_FILTERS.map((t) => {
            // Counted within the current status filter, so the badge always
            // matches what clicking it will actually show.
            const count = ofType(byStatus, t).length;
            const total = ofType(requests, t).length;
            const hidden = total - count;
            return (
              <button key={t} onClick={() => setTypeFilter(t)}
                title={hidden > 0 ? `${hidden} more hidden by the ${FILTER_LABEL[filter]} filter` : undefined}
                className={`px-3 py-1 rounded-full text-xs font-medium tracking-wide transition-colors border ${
                  typeFilter === t ? 'bg-panelup text-brassbright border-brass/50'
                    : count === 0 ? 'text-ash/40 border-line/60 hover:text-ash'
                      : 'text-ash hover:text-bone border-line'}`}>
                {TYPE_FILTER_LABEL[t] || t}
                {t !== 'all' ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>

        {shown.length === 0 ? (
          <EmptyView requests={requests} filter={filter} typeFilter={typeFilter}
            hiddenByStatus={ofType(requests, typeFilter).length}
            onShowAll={() => setFilter('all')} />
        ) : (
          <div className="space-y-1.5">
            {/* Widths mirror the row below exactly — the rows are flex divs
                rather than a table, so nothing keeps these in step automatically. */}
            <div className="flex items-center gap-3 px-3 pb-0.5 text-ash">
              <SortHeader col="member" sort={sort} onSort={toggleSort} className="w-44 shrink-0">Member</SortHeader>
              <SortHeader col="type" sort={sort} onSort={toggleSort} className="w-32 shrink-0">Type</SortHeader>
              <SortHeader col="item" sort={sort} onSort={toggleSort} className="w-64 shrink-0">Item</SortHeader>
              <SortHeader col="amount" sort={sort} onSort={toggleSort} className="w-32 shrink-0 justify-end">Lucent</SortHeader>
              <span className="eyebrow text-[10px] w-28 shrink-0 text-right" title={marketAge ? `Auction-house floor, updated ${marketAge}` : 'Auction-house floor'}>
                AH Price
              </span>
              <span className="eyebrow text-[10px] flex-1">Note</span>
              <SortHeader col="status" sort={sort} onSort={toggleSort} className="w-20 shrink-0 justify-center">Status</SortHeader>
              <SortHeader col="date" sort={sort} onSort={toggleSort} className="w-28 shrink-0 justify-end">Requested</SortHeader>
              <span className="w-24 shrink-0" />
            </div>
            {shown.map((r) => {
              const meta = STATUS_META[r.status] || STATUS_META.pending;
              return editingId === r.id ? (
                <div key={r.id} className="flex flex-wrap items-center gap-2 bg-hall border border-brass/50 rounded-lg px-3 py-2 text-sm">
                  <span className="text-bone w-44 shrink-0 truncate">{r.display_name || r.discord_id}</span>
                  <input type="text" value={edit.request_type} maxLength={60} placeholder="Type" list="lucent-request-types"
                    onChange={(e) => setEdit((p) => ({ ...p, request_type: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-32" />
                  <input type="text" value={edit.item_name} maxLength={200} placeholder="Item"
                    list="lucent-request-items" autoComplete="off"
                    title="Catalog items and market-priced potentials are suggested; anything else is kept as free text."
                    onChange={(e) => setEdit((p) => ({ ...p, item_name: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(r); if (e.key === 'Escape') setEditingId(null); }}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-64 shrink-0" />
                  <input type="number" min={1} value={edit.amount} autoFocus
                    onChange={(e) => setEdit((p) => ({ ...p, amount: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-28" />
                  <span className="w-28 shrink-0" />
                  <input type="text" value={edit.note} maxLength={300} placeholder="Note (optional)"
                    onChange={(e) => setEdit((p) => ({ ...p, note: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(r); if (e.key === 'Escape') setEditingId(null); }}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />
                  <button onClick={() => saveEdit(r)} className="text-brass hover:text-brassbright shrink-0" title="Save">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-ash hover:text-bone shrink-0" title="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div key={r.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                  <span className="text-bone w-44 shrink-0 truncate">{r.display_name || r.discord_id}</span>
                  <span className={`w-32 shrink-0 truncate text-xs ${r.request_type ? 'text-brass' : 'text-ash/30'}`} title={r.request_type || ''}>
                    {r.request_type || '—'}
                  </span>
                  <span className="text-bone w-64 shrink-0 truncate" title={r.item_name}>
                    {r.item_name}
                    {!r.item_key && <span className="text-ash/40 text-[10px] ml-1" title="Not in the loot catalog">*</span>}
                  </span>
                  <span className="shrink-0 w-32 inline-flex items-center justify-end gap-2">
                    <CurrencyIcon currency="lucent" />
                    <span className="font-mono text-brassbright">{r.amount.toLocaleString()}</span>
                  </span>
                  {/* Floor, not a valuation — it's the cheapest listing right
                      now, which is what the requester would actually pay. */}
                  {(() => {
                    const m = priceFor(r);
                    return (
                      <span className="w-28 shrink-0 text-right text-xs"
                        title={m ? `Cheapest of ${m.listings} listing${m.listings === 1 ? '' : 's'}${m.sell?.gapHours ? ` · typically clears in ~${m.sell.gapHours}h` : ''}` : 'No auction-house price for this item'}>
                        {m ? (
                          <>
                            <span className="font-mono text-brass">{m.floor.toLocaleString()}</span>
                            <span className="text-ash/40 ml-1">×{m.listings}</span>
                          </>
                        ) : <span className="text-ash/25">—</span>}
                      </span>
                    );
                  })()}
                  <span className={`text-xs flex-1 truncate ${r.note ? 'text-ash/80 italic' : 'text-ash/30'}`} title={r.note || ''}>
                    {r.note || '—'}
                  </span>
                  {/* Fixed-width wrapper: the labels differ in length, so a
                      content-sized pill shifts the date column row to row. */}
                  <span className="w-20 shrink-0 flex justify-center">
                    <span className={`text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </span>
                  <span className="text-ash/60 text-[10px] w-28 text-right shrink-0">{fmtDatetime(r.requested_at)}</span>

                  {/* Also fixed: the button count varies by status, which would
                      otherwise leave every row a different length. */}
                  <div className="flex items-center justify-end gap-1 shrink-0 w-24">
                    {r.status === 'pending' && (
                      <button onClick={() => setStatus(r, 'approved')} className="text-ash hover:text-sky-400" title="Approve">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status === 'approved' && (
                      <button onClick={() => setStatus(r, 'paid')} className="text-ash hover:text-emerald-400" title="Mark paid — records the Lucent grant">
                        <Coins className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {/* Same destination as reopening a denial, so the same icon —
                        both mean "put this back to pending". Safe to offer here
                        because approving has no side effect; only paying does. */}
                    {r.status === 'approved' && (
                      <button onClick={() => setStatus(r, 'pending')} className="text-ash hover:text-brass" title="Unapprove — back to pending">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(r.status === 'pending' || r.status === 'approved') && (
                      <button onClick={() => setStatus(r, 'denied')} className="text-ash hover:text-oxblood" title="Deny">
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status === 'denied' && (
                      <button onClick={() => setStatus(r, 'pending')} className="text-ash hover:text-brass" title="Reopen">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status !== 'paid' && (
                      <button onClick={() => startEdit(r)} className="text-ash hover:text-brass" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => remove(r)} className="text-ash hover:text-oxblood" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Totals for exactly what's listed above. Column widths mirror the
                header and rows so the figure sits under the Lucent column. */}
            <div className="flex items-center gap-3 px-3 pt-2 mt-1 border-t border-line text-sm">
              <span className="w-44 shrink-0 eyebrow text-[10px] text-ash">
                Total · {shown.length} shown
              </span>
              <span className="w-32 shrink-0" />
              <span className="w-64 shrink-0" />
              <span className="shrink-0 w-32 inline-flex items-center justify-end gap-2">
                <CurrencyIcon currency="lucent" />
                <span className="font-mono text-brassbright">{totals.total.toLocaleString()}</span>
              </span>
              <span className="w-28 shrink-0" />
              {/* Per-type split only when the view actually mixes types —
                  repeating one number twice would just be noise. */}
              <span className="text-xs flex-1 text-ash/70 truncate">
                {typeFilter === 'all' && [
                  ...TYPES.filter((t) => totals.byType[t] > 0).map((t) => `${t} ${totals.byType[t].toLocaleString()}`),
                  ...(totals.other > 0 ? [`Other ${totals.other.toLocaleString()}`] : []),
                ].join('  ·  ')}
              </span>
              <span className="w-20 shrink-0" />
              <span className="w-28 shrink-0" />
              <span className="w-24 shrink-0" />
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

// An empty list has three quite different causes, and saying "nothing here" for
// all of them sent someone hunting for a bug that was really the status filter:
// every Partial Refund request happened to be paid or denied, so picking that
// type under the default Open view correctly showed nothing.
function EmptyView({ requests, filter, typeFilter, hiddenByStatus, onShowAll }) {
  if (requests.length === 0) return <p className="text-ash text-sm">No requests logged yet.</p>;

  const typeLabel = TYPE_FILTER_LABEL[typeFilter] || typeFilter;
  if (typeFilter !== 'all' && hiddenByStatus > 0) {
    return (
      <p className="text-ash text-sm">
        No <span className="text-bone">{typeLabel}</span> requests are{' '}
        <span className="text-bone">{(FILTER_LABEL[filter] || filter).toLowerCase()}</span> —
        but there {hiddenByStatus === 1 ? 'is 1' : `are ${hiddenByStatus}`} in other states.{' '}
        <button onClick={onShowAll} className="text-brass hover:text-brassbright transition-colors">
          Show all statuses
        </button>
      </p>
    );
  }
  return <p className="text-ash text-sm">Nothing in this view.</p>;
}

// A clickable column label. The arrow only renders on the active column, so the
// header doesn't read as though everything is sorted at once.
function SortHeader({ col, sort, onSort, className = '', children }) {
  const active = sort.key === col;
  return (
    <button
      type="button" onClick={() => onSort(col)}
      title={`Sort by ${String(children).toLowerCase()}`}
      className={`eyebrow text-[10px] inline-flex items-center gap-1 transition-colors ${
        active ? 'text-brass' : 'text-ash hover:text-bone'} ${className}`}
    >
      {children}
      {active && <ChevronDown className={`w-3 h-3 shrink-0 ${sort.dir === 'asc' ? 'rotate-180' : ''}`} />}
    </button>
  );
}

// Log a request on a member's behalf. Its own component so the in-progress
// selection resets after each submit without touching page state — same reason
// LootCurrency's give form is split out.
function RequestForm({ members, catalog, busy, onCreate, potentials, marketAge }) {
  const [memberId, setMemberId] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [itemKey, setItemKey] = useState('');
  const [otherName, setOtherName] = useState('');
  const [potentialName, setPotentialName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [requestType, setRequestType] = useState('');

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || memberId) return [];
    return members.filter((m) => (m.name || '').toLowerCase().includes(q)).slice(0, 8);
  }, [query, memberId, members]);

  const pick = (m) => { setMemberId(m.id); setQuery(m.name); setOpen(false); };
  const clear = () => { setMemberId(''); setQuery(''); setOpen(false); };

  const onQueryChange = (e) => {
    setQuery(e.target.value);
    setOpen(true);
    if (memberId) setMemberId(''); // typing again invalidates the previous pick
  };

  const onQueryBlur = () => {
    // Let a suggestion's onClick register before closing/validating.
    setTimeout(() => {
      setOpen(false);
      if (memberId) return;
      const q = query.trim().toLowerCase();
      const exact = q && members.find((m) => (m.name || '').toLowerCase() === q);
      if (exact) { setMemberId(exact.id); setQuery(exact.name); }
      else setQuery(''); // unresolved text can't be sent as a target
    }, 150);
  };

  const usingOther = itemKey === OTHER;
  const usingPotential = itemKey === POTENTIAL;

  // The datalist lets anything be typed, so a free-text near-miss resolves to
  // nothing rather than silently pricing the wrong potential.
  const pickedPotential = useMemo(() => {
    const q = potentialName.trim().toLowerCase();
    return potentials.find((p) => String(p.label).toLowerCase() === q) || null;
  }, [potentialName, potentials]);

  const hasItem = usingOther ? otherName.trim() !== ''
    : usingPotential ? Boolean(pickedPotential)
      : itemKey !== '';

  const submit = () => {
    const amt = parseInt(amount, 10);
    if (!memberId || !hasItem || !Number.isFinite(amt) || amt <= 0) return;
    onCreate({
      discord_id: memberId,
      display_name: members.find((m) => m.id === memberId)?.name,
      // A potential isn't a catalog row, so it goes in as its label plus the
      // stable id that makes its price an exact lookup later.
      item_key: (usingOther || usingPotential) ? null : itemKey,
      item_name: usingOther ? otherName.trim() : usingPotential ? pickedPotential.label : undefined,
      potential_id: usingPotential ? pickedPotential.potentialId : null,
      amount: amt,
      note: note.trim(),
      request_type: requestType.trim(),
    });
    // Member stays — a member often asks for more than one thing at a time.
    // Type persists with the member — a run of grants is usually all one kind.
    setItemKey(''); setOtherName(''); setPotentialName(''); setAmount(''); setNote('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[160px]">
        <input
          type="text" value={query} onChange={onQueryChange}
          onFocus={() => setOpen(true)} onBlur={onQueryBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && suggestions.length > 0) { e.preventDefault(); pick(suggestions[0]); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Member…" autoComplete="off"
          className="w-full bg-hall border border-line rounded-lg pl-3 pr-8 py-2 text-sm text-bone focus:outline-none focus:border-brass"
        />
        {memberId && (
          <button type="button" onClick={clear} title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ash hover:text-oxblood">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {open && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-hall border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
            {suggestions.map((m) => (
              <button key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}
                className="w-full text-left px-3 py-1.5 text-sm text-bone hover:bg-panelup transition-colors">
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Catalog first, free text as the fallback — Lucent buys from the auction
          house, so plenty of requests are for gear the guild's drop table
          doesn't cover. */}
      <input type="text" value={requestType} onChange={(e) => setRequestType(e.target.value)} maxLength={60}
        placeholder="Type" list="lucent-request-types"
        title="What kind of request this is — e.g. Enchant, Trait, Archboss. Free text; past entries are suggested."
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-32" />
      <select value={itemKey} onChange={(e) => setItemKey(e.target.value)}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass max-w-[220px]">
        <option value="">Item…</option>
        <option value={OTHER}>— Other (type a name) —</option>
        {potentials.length > 0 && <option value={POTENTIAL}>— Potential (market priced) —</option>}
        {catalog.map((c) => (
          <optgroup key={c.key} label={c.label}>
            {c.items.map((i) => <option key={i.key} value={i.key}>{i.name}</option>)}
          </optgroup>
        ))}
      </select>
      {usingOther && (
        <input type="text" value={otherName} onChange={(e) => setOtherName(e.target.value)} maxLength={200}
          placeholder="Item name" autoFocus
          className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-48" />
      )}
      {usingPotential && (
        <>
          {/* A datalist rather than a 190-option select: typing narrows it, and
              the exact-match rule above means a half-typed name won't submit. */}
          <input type="text" value={potentialName} onChange={(e) => setPotentialName(e.target.value)}
            placeholder="Potential…" list="market-potentials" autoFocus autoComplete="off"
            className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-56" />
          <datalist id="market-potentials">
            {potentials.map((p) => <option key={p.potentialId} value={p.label} />)}
          </datalist>
        </>
      )}

      <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Lucent"
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-28" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
        placeholder="Note (optional)" onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />

      {pickedPotential && (
        <span className="inline-flex items-center gap-2 text-xs text-ash shrink-0"
          title={`Cheapest of ${pickedPotential.listings} listing${pickedPotential.listings === 1 ? '' : 's'}`
            + (pickedPotential.sell?.gapHours ? ` · typically clears in ~${pickedPotential.sell.gapHours}h` : '')
            + (marketAge ? ` · updated ${marketAge}` : '')}>
          <span className="font-mono text-brass">{pickedPotential.floor.toLocaleString()}</span>
          <span className="text-ash/60">floor</span>
          <button type="button" onClick={() => setAmount(String(pickedPotential.floor))}
            className="px-2 py-0.5 rounded border border-line hover:border-brass/60 hover:text-bone transition-colors">
            use
          </button>
        </span>
      )}
      <button type="button" onClick={submit} disabled={busy || !memberId || !hasItem || !amount}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <Plus className="w-4 h-4" /> Log request
      </button>
    </div>
  );
}
