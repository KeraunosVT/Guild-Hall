import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { ChevronDown, RefreshCw, Gavel, X, ScrollText, UserPlus } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { fmtDatetime } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

const PRIO_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };
const PRIO_DOT = { 'PvP': 'bg-oxblood', 'Second Build': 'bg-brass', 'PvE': 'bg-emerald-500' };
const PRIO_TEXT = { 'PvP': 'text-oxblood', 'Second Build': 'text-brass', 'PvE': 'text-emerald-400' };
const PRIO_ON = {
  'PvP': 'bg-oxblood text-bone border-transparent',
  'Second Build': 'bg-brass text-ink border-transparent',
  'PvE': 'bg-emerald-500 text-ink border-transparent',
};

export default function LootTally() {
  const { user, can } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [counts, setCounts] = useState({});
  const [tally, setTally] = useState({});
  const [awards, setAwards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [pending, setPending] = useState(null); // { item, watcher }
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [members, setMembers] = useState([]);
  const [pickBusy, setPickBusy] = useState(false);

  const toggleCat = (key) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/loot/catalog'), axios.get('/api/loot'), axios.get('/api/admin/loot/awards'),
      axios.get('/api/admin/members'),
    ])
      .then(([catRes, loot, aw, mem]) => {
        setCatalog(catRes.data);
        setCounts(loot.data.counts || {});
        setTally(loot.data.tally || {});
        setAwards(aw.data.awards || []);
        setMembers(mem.data.members || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the tally.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const PRIO_INDEX = useMemo(() => catalog ? Object.fromEntries(catalog.priorities.map((p, i) => [p, i])) : {}, [catalog]);

  const allItems = useMemo(() => catalog ? catalog.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.label }))) : [], [catalog]);
  const itemByKey = useMemo(() => Object.fromEntries(allItems.map((i) => [i.key, i])), [allItems]);

  const awardsByItem = useMemo(() => {
    const m = {};
    awards.forEach((a) => { (m[a.item_key] = m[a.item_key] || []).push(a); });
    return m;
  }, [awards]);
  const awardFor = (itemKey, discordId, priority) =>
    (awardsByItem[itemKey] || []).find((a) => a.discord_id === discordId && a.priority === priority);

  // Reverse-index the per-item tally into per-member picks, so the wishlist manager
  // can show/edit a member's full list without a separate endpoint.
  const picksByMember = useMemo(() => {
    const m = {};
    Object.entries(tally).forEach(([itemKey, watchers]) => {
      watchers.forEach((w) => { (m[w.discord_id] = m[w.discord_id] || {})[itemKey] = { priority: w.priority, added_at: w.added_at }; });
    });
    return m;
  }, [tally]);

  const groupedRows = useMemo(() => {
    if (!catalog) return [];
    const f = filter.toLowerCase();
    return catalog.categories
      .map((cat) => {
        const items = (cat.items || [])
          .map((it) => {
            const awarded = awardsByItem[it.key] || [];
            // A watcher only drops off the pending list once THIS build has been
            // awarded to them — an award for a different build (or an older award
            // with no recorded build) leaves their wishlist entry open.
            const watchers = [...(tally[it.key] || [])]
              .filter((w) => !awarded.some((a) => a.discord_id === w.discord_id && a.priority === w.priority))
              .sort((a, b) => (PRIO_INDEX[a.priority] - PRIO_INDEX[b.priority]) || (a.name || '').localeCompare(b.name || ''));
            const byPrio = {};
            catalog.priorities.forEach((p) => { byPrio[p] = 0; });
            watchers.forEach((w) => { if (byPrio[w.priority] != null) byPrio[w.priority]++; });
            return { ...it, category: cat.label, total: watchers.length, watchers, byPrio, awarded };
          })
          .filter((it) => it.name.toLowerCase().includes(f) || cat.label.toLowerCase().includes(f));
        return { ...cat, items };
      })
      .filter((cat) => cat.items.length > 0 && (!category || cat.label === category));
  }, [counts, tally, awardsByItem, filter, category, catalog, PRIO_INDEX]);


  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const confirmAward = () => {
    if (!pending) return;
    setBusy(true);
    axios.post('/api/admin/loot/awards', {
      item_key: pending.item.key, discord_id: pending.watcher.discord_id, display_name: pending.watcher.name,
      priority: pending.watcher.priority,
    })
      .then(() => { setPending(null); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Award failed.'))
      .finally(() => setBusy(false));
  };

  const revoke = (id) => {
    axios.delete(`/api/admin/loot/awards/${id}`).then(load).catch((err) => setError(err.response?.data?.error || 'Revoke failed.'));
  };

  const saveMemberPicks = async (discordId, picks) => {
    const member = members.find((m) => m.id === discordId);
    setPickBusy(true);
    try {
      await axios.put(`/api/loot/${discordId}`, { picks, display_name: member?.name });
      load();
      return true;
    } catch (err) { flash(err.response?.data?.error || 'Failed to update wishlist.', false); return false; }
    finally { setPickBusy(false); }
  };

  // Flatten a member's picks back to { itemKey: priority } for the save payload —
  // sending plain strings tells the backend to leave each item's existing added_at alone.
  const flatPicks = (discordId) =>
    Object.fromEntries(Object.entries(picksByMember[discordId] || {}).map(([k, v]) => [k, v.priority]));

  const addPickForItem = (itemKey, discordId, priority) => {
    const current = flatPicks(discordId);
    if (current[itemKey] === priority) return;
    const member = members.find((m) => m.id === discordId);
    const item = itemByKey[itemKey];
    saveMemberPicks(discordId, { ...current, [itemKey]: priority })
      .then((ok) => { if (ok) flash(`Added "${item?.name}" to ${member?.name || "their"}'s wishlist.`); });
  };

  const removePickForItem = (itemKey, discordId) => {
    const next = flatPicks(discordId);
    delete next[itemKey];
    const member = members.find((m) => m.id === discordId);
    const item = itemByKey[itemKey];
    saveMemberPicks(discordId, next).then((ok) => { if (ok) flash(`Removed "${item?.name}" from ${member?.name || "their"}'s wishlist.`); });
  };

  if (!can('loot.awards')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell>
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <Toast msg={msg} />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Main list */}
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search items…"
              className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass flex-1 min-w-[160px]" />
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="bg-panel border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
              <option value="">All categories</option>
              {(catalog?.categories || []).map((c) => <option key={c.key} value={c.label}>{c.label}</option>)}
            </select>
            <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /></button>
          </div>

          {loading ? (
            <div className="py-20 text-center text-ash">Counting the claims…</div>
          ) : groupedRows.length === 0 ? (
            <div className="py-20 text-center text-ash">No items match.</div>
          ) : (
            <div className="space-y-8">
              {groupedRows.map((cat) => (
                <section key={cat.key}>
                  <button onClick={() => toggleCat(cat.key)} className="flex items-center gap-2 mb-3 group w-full text-left">
                    <ChevronDown className={`w-4 h-4 text-ash transition-transform ${collapsed.has(cat.key) ? '-rotate-90' : ''}`} />
                    <h2 className="font-display text-lg text-bone tracking-[0.08em] group-hover:text-brassbright transition-colors">{cat.label}</h2>
                    <span className="text-xs text-ash font-mono">{cat.items.length}</span>
                  </button>
                  {!collapsed.has(cat.key) && <div className="panel rounded-lg divide-y divide-line">
              {cat.items.map((it) => {
                const isOpen = open.has(it.key);
                const watchingIds = new Set(it.watchers.map((w) => w.discord_id));
                const eligibleMembers = [...members]
                  .filter((m) => !watchingIds.has(m.id))
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                return (
                  <div key={it.key}>
                    <button onClick={() => toggle(it.key)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-panelup transition-colors">
                      <div className="min-w-0 flex-1">
                        <ItemTooltip item={it}>
                          <span className={`truncate ${gradeStyle(it.grade)?.color || 'text-bone'}`}>{it.name}</span>
                        </ItemTooltip>
                      </div>
                      <div className="hidden sm:flex items-center gap-2 shrink-0">
                        {(catalog?.priorities || []).map((p) => (
                          <span key={p} className={`inline-flex items-center gap-1 text-xs font-mono ${it.byPrio[p] ? PRIO_TEXT[p] : 'text-ash/30'}`} title={p}>
                            <span className={`w-2 h-2 rounded-full ${it.byPrio[p] ? PRIO_DOT[p] : 'bg-line'}`} />{it.byPrio[p]}
                          </span>
                        ))}
                      </div>
                      <div className="w-8 text-right font-mono text-brassbright shrink-0">{it.total}</div>
                      <ChevronDown className={`w-4 h-4 shrink-0 transition-transform text-ash ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-3 space-y-1.5">
                        {it.watchers.length === 0 && (
                          <div className="text-ash/50 text-xs py-1">No one has wishlisted this.</div>
                        )}
                        {it.watchers.map((w) => {
                          const award = awardFor(it.key, w.discord_id, w.priority);
                          return (
                            <div key={w.discord_id} className="flex items-center gap-2 text-sm">
                              <span className={`w-2 h-2 rounded-full ${PRIO_DOT[w.priority] || 'bg-line'} shrink-0`} />
                              <span className="text-bone">{w.name}</span>
                              <span className="text-ash text-xs">· {PRIO_SHORT[w.priority] || w.priority}</span>
                              {w.added_at && <span className="text-ash/60 text-[10px]">· added {fmtDatetime(w.added_at)}</span>}
                              <div className="flex-1" />
                              {award ? (
                                <span className="inline-flex items-center gap-1 text-xs text-brass">
                                  <Gavel className="w-3 h-3" /> Awarded
                                  <button onClick={() => revoke(award.id)} className="ml-1 text-ash hover:text-oxblood" title="Revoke"><X className="w-3 h-3" /></button>
                                </span>
                              ) : (
                                <button onClick={() => setPending({ item: it, watcher: w })}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-brass/50 text-brassbright hover:bg-panelup rounded-lg transition-colors">
                                  <Gavel className="w-3 h-3" /> Award
                                </button>
                              )}
                              <button onClick={() => removePickForItem(it.key, w.discord_id)} disabled={pickBusy}
                                className="text-ash hover:text-oxblood disabled:opacity-40" title="Remove from their wishlist"
                                aria-label={`Remove ${w.name} from wishlist for ${it.name}`}>
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          );
                        })}
                        <AddPickRow itemName={it.name} members={eligibleMembers} priorities={catalog?.priorities || []}
                          busy={pickBusy} onAdd={(discordId, prio) => addPickForItem(it.key, discordId, prio)} />
                      </div>
                    )}
                  </div>
                );
              })}
                  </div>}
                </section>
              ))}
            </div>
          )}
        </div>

        {/* Awarded tracker sidebar */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="panel rounded-lg p-4">
            <div className="eyebrow text-[10px] text-brass flex items-center gap-2 mb-4"><ScrollText className="w-3.5 h-3.5" /> Awarded ({awards.length})</div>
            {awards.length === 0 ? (
              <p className="text-ash text-sm">Nothing awarded yet. Expand an item and award it to a member.</p>
            ) : (
              <div className="space-y-3 max-h-[640px] overflow-auto pr-1">
                {awards.map((a) => (
                  <div key={a.id} className="flex items-start gap-2 border-b border-line/50 pb-3 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-bone truncate">{itemByKey[a.item_key]?.name || a.item_key}</div>
                      <div className="flex items-center gap-1.5 text-xs text-brass truncate">
                        {a.priority && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIO_DOT[a.priority] || 'bg-line'}`} />}
                        <span className="truncate">{a.display_name || 'Member'}</span>
                        <span className="text-ash/70 shrink-0">{a.priority ? `· ${PRIO_SHORT[a.priority] || a.priority}` : '· build unset'}</span>
                      </div>
                      <div className="text-[10px] text-ash mt-0.5">{fmtDatetime(a.awarded_at)}{a.awarded_by ? ` · by ${a.awarded_by}` : ''}</div>
                    </div>
                    <button onClick={() => revoke(a.id)} className="text-ash hover:text-oxblood shrink-0" title="Revoke"><X className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Confirmation modal */}
      {pending && (
        <Modal onClose={() => !busy && setPending(null)}>
          <div className="flex items-center gap-2 text-brass eyebrow text-[11px] mb-3"><Gavel className="w-4 h-4" /> Loot Council</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-2">Award this item?</h2>
          <p className="text-ash text-sm mb-1">Award <span className="text-bone font-medium">{pending.item.name}</span> to <span className="text-bone font-medium">{pending.watcher.name}</span>.</p>
          <p className="text-ash text-sm mb-6">It will be marked <span className="text-brass">Loot Counciled</span> on the tally and on their wishlist.</p>
          <div className="flex justify-end gap-3">
            <Button variant="neutral" size="none" className="px-4 py-2" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
            <Button size="none" className="px-5 py-2" disabled={busy} onClick={confirmAward}>
              <Gavel className="w-4 h-4" /> {busy ? 'Awarding…' : 'Award'}
            </Button>
          </div>
        </Modal>
      )}
    </PageShell>
  );
}

// Inline "add a member to this item's wishlist" control, used inside each expanded item.
// Kept as its own component so its in-progress selection doesn't leak between items.
function AddPickRow({ itemName, members, priorities, busy, onAdd }) {
  const [memberId, setMemberId] = useState('');
  const [prio, setPrio] = useState('');

  const submit = () => {
    if (!memberId || !prio) return;
    onAdd(memberId, prio);
    setMemberId(''); setPrio('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2 mt-1 border-t border-line/50">
      <select value={memberId} onChange={(e) => setMemberId(e.target.value)}
        className="bg-hall border border-line rounded-lg px-2 py-1.5 text-xs text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]">
        <option value="">— add member —</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      {priorities.map((p) => (
        <button key={p} type="button" onClick={() => setPrio(p)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${prio === p ? PRIO_ON[p] : 'border-line text-ash hover:text-bone'}`}>
          {PRIO_SHORT[p]}
        </button>
      ))}
      <button type="button" onClick={submit} disabled={!memberId || !prio || busy}
        title={`Add to wishlist for ${itemName}`}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <UserPlus className="w-3.5 h-3.5" /> Add
      </button>
    </div>
  );
}
