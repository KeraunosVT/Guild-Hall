import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { Plus, Pencil, Trash2, Upload, X } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

// Split out of LootTally.jsx's "Manage items" toggle panel so it's a real,
// linkable page under the Loot Council sidebar dropdown instead of a
// same-page toggle — this only ever touches the catalog, never the
// tally/awards data LootTally itself needs, so it's fully self-contained.
export default function LootItems() {
  const { user, can } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);

  const [newCatName, setNewCatName] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemCat, setNewItemCat] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [qlSearch, setQlSearch] = useState('');
  const [qlResults, setQlResults] = useState([]);
  const [qlSearching, setQlSearching] = useState(false);
  const [qlAddCat, setQlAddCat] = useState('');

  const load = () => {
    axios.get('/api/loot/catalog')
      .then((res) => setCatalog(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the catalog.'));
  };
  useEffect(() => { load(); }, []);

  if (!can('loot.catalog')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell>
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <Toast msg={msg} />

      {catalog && (
        <div className="panel rounded-lg p-6 space-y-6">
          {/* Add category */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Add category</label>
            <div className="flex gap-2">
              <input value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="e.g. Boots"
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <button
                onClick={() => {
                  if (!newCatName.trim()) return;
                  axios.post('/api/admin/loot/categories', { label: newCatName.trim() })
                    .then(() => { setNewCatName(''); load(); })
                    .catch((err) => setError(err.response?.data?.error || 'Failed to add category.'));
                }}
                disabled={!newCatName.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Add item */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Add item</label>
            <div className="flex gap-2">
              <select value={newItemCat} onChange={(e) => setNewItemCat(e.target.value)}
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— category —</option>
                {catalog.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder="Item name"
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <button
                onClick={() => {
                  if (!newItemCat || !newItemName.trim()) return;
                  axios.post('/api/admin/loot/items', { category: newItemCat, name: newItemName.trim() })
                    .then(() => { setNewItemName(''); load(); })
                    .catch((err) => setError(err.response?.data?.error || 'Failed to add item.'));
                }}
                disabled={!newItemCat || !newItemName.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Item database */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Item Database</label>

            {/* Sync reference data */}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={() => {
                  setImporting(true); setImportResult(null); setError('');
                  axios.post('/api/admin/loot/import-questlog')
                    .then(() => {
                      const poll = setInterval(() => {
                        axios.get('/api/admin/loot/import-status').then((res) => {
                          if (!res.data.running) {
                            clearInterval(poll);
                            setImporting(false);
                            if (res.data.error) setError('Sync failed: ' + res.data.error);
                            else setImportResult(res.data.result);
                          }
                        }).catch(() => {});
                      }, 3000);
                    })
                    .catch((err) => { setError(err.response?.data?.error || 'Failed to start sync.'); setImporting(false); });
                }}
                disabled={importing}
                className="px-4 py-2 border border-brass/50 text-brassbright hover:bg-panelup rounded-lg text-sm transition-colors disabled:opacity-40"
              >
                {importing ? 'Syncing…' : 'Sync Item Database'}
              </button>
              <span className="text-ash text-xs">{importing ? 'This may take a few minutes' : 'Pull latest Epic+ items from game data'}</span>
              {importResult && (
                <span className="text-emerald-400 text-xs">
                  {importResult.imported} new, {importResult.skipped || 0} existing ({(importResult.duration_ms / 1000).toFixed(0)}s)
                </span>
              )}
            </div>

            {/* Search and add */}
            <div className="flex gap-2 mb-3">
              <input value={qlSearch} onChange={(e) => setQlSearch(e.target.value)} placeholder="Search items…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && qlSearch.trim()) {
                    setQlSearching(true);
                    axios.get('/api/admin/loot/questlog-search', { params: { q: qlSearch.trim() } })
                      .then((res) => setQlResults(res.data.items || []))
                      .catch(() => setQlResults([]))
                      .finally(() => setQlSearching(false));
                  }
                }}
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <select value={qlAddCat} onChange={(e) => setQlAddCat(e.target.value)}
                className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— category —</option>
                {(catalog?.categories || []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <button
                onClick={() => {
                  if (!qlSearch.trim()) return;
                  setQlSearching(true);
                  axios.get('/api/admin/loot/questlog-search', { params: { q: qlSearch.trim() } })
                    .then((res) => setQlResults(res.data.items || []))
                    .catch(() => setQlResults([]))
                    .finally(() => setQlSearching(false));
                }}
                disabled={qlSearching || !qlSearch.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
                {qlSearching ? '…' : 'Search'}
              </button>
            </div>
            {qlResults.length > 0 && (
              <div className="space-y-1 max-h-[300px] overflow-auto">
                {qlResults.map((it) => {
                  const g = it.grade >= 51 ? 'text-amber-400' : it.grade >= 41 ? 'text-purple-400' : 'text-bone';
                  return (
                    <div key={it.id} className="flex items-center gap-2 bg-hall border border-line rounded-lg px-3 py-2">
                      {it.icon && <img src={it.icon} alt="" className="w-8 h-8 rounded border border-line object-cover shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm truncate ${g}`}>{it.name}</div>
                        <div className="text-[10px] text-ash">{it.sub_category}</div>
                      </div>
                      <button
                        onClick={() => {
                          if (!qlAddCat) { setError('Select a category first.'); return; }
                          axios.post('/api/admin/loot/add-from-questlog', { questlog_id: it.id, category: qlAddCat })
                            .then(() => { load(); flash(`Added "${it.name}".`); })
                            .catch((err) => setError(err.response?.data?.error || 'Failed to add.'));
                        }}
                        disabled={!qlAddCat}
                        className="px-3 py-1 text-xs bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 shrink-0">
                        Add
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Existing items by category */}
          <div className="space-y-4">
            {catalog.categories.map((cat) => (
              <div key={cat.key}>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-display text-bone tracking-wide">{cat.label}</h4>
                  <button
                    onClick={() => {
                      if (!confirm(`Delete the "${cat.label}" category and all its items?`)) return;
                      axios.delete(`/api/admin/loot/categories/${cat.key}`)
                        .then(load)
                        .catch((err) => setError(err.response?.data?.error || 'Failed to delete category.'));
                    }}
                    className="text-ash hover:text-oxblood" title="Delete category"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="space-y-1">
                  {cat.items.map((item) => (
                    <div key={item.key} className="bg-hall border border-line rounded-lg px-3 py-1.5">
                      {editingItem === item.key ? (
                        <div className="space-y-2 py-1">
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Item name"
                            className="bg-panel border border-line rounded px-2 py-1 text-bone focus:outline-none focus:border-brass w-full text-sm" />
                          <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description (optional)" rows={2}
                            className="bg-panel border border-line rounded px-2 py-1 text-bone focus:outline-none focus:border-brass w-full text-sm resize-none" />
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-1.5 text-xs text-brass hover:text-brassbright cursor-pointer">
                              <Upload className="w-3.5 h-3.5" /> Upload icon
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                const f = e.target.files[0];
                                if (!f) return;
                                const form = new FormData();
                                form.append('image', f);
                                axios.post(`/api/admin/loot/items/${item.key}/image`, form)
                                  .then(() => load())
                                  .catch((err) => setError(err.response?.data?.error || 'Upload failed.'));
                              }} />
                            </label>
                            {item.image_url && <img src={item.image_url} alt="" className="w-6 h-6 rounded border border-line object-cover" />}
                            {!item.questlog_data && (
                              <button onClick={() => {
                                const name = item.name || editName;
                                axios.get('/api/admin/loot/questlog-search', { params: { q: name } })
                                  .then((res) => {
                                    const items = res.data.items || [];
                                    if (items.length === 0) { setError(`No match for "${name}". Sync the item database first.`); return; }
                                    const match = items.find((r) => r.name.toLowerCase() === name.toLowerCase()) || items[0];
                                    return axios.put(`/api/admin/loot/link-questlog/${item.key}`, { questlog_id: match.id })
                                      .then(() => { load(); flash(`Linked "${match.name}".`); });
                                  })
                                  .catch((err) => setError(err.response?.data?.error || err.message || 'Link failed.'));
                              }} className="text-brass hover:text-brassbright text-xs">Auto-link</button>
                            )}
                            {item.questlog_data && (
                              <button onClick={() => {
                                axios.put(`/api/admin/loot/unlink-questlog/${item.key}`)
                                  .then(() => { load(); flash('Unlinked.'); })
                                  .catch((err) => setError(err.response?.data?.error || 'Unlink failed.'));
                              }} className="text-emerald-400 hover:text-oxblood text-[10px] inline-flex items-center gap-0.5">linked <X className="w-2.5 h-2.5" /></button>
                            )}
                            <div className="flex-1" />
                            <button onClick={() => {
                              axios.put(`/api/admin/loot/items/${item.key}`, { name: editName.trim(), description: editDesc })
                                .then(() => { setEditingItem(null); load(); })
                                .catch((err) => setError(err.response?.data?.error || 'Failed to save.'));
                            }} className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold">Save</button>
                            <button onClick={() => setEditingItem(null)} className="text-ash hover:text-bone text-xs">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {item.image_url && <img src={item.image_url} alt="" className="w-6 h-6 rounded border border-line object-cover shrink-0" />}
                          <span className="text-bone text-sm flex-1">{item.name}</span>
                          {item.description && <span className="text-ash text-[10px] shrink-0">has desc</span>}
                          <button onClick={() => { setEditingItem(item.key); setEditName(item.name); setEditDesc(item.description || ''); }}
                            className="text-ash hover:text-brass" title="Edit">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => {
                            if (!confirm(`Delete "${item.name}"?`)) return;
                            axios.delete(`/api/admin/loot/items/${item.key}`)
                              .then(load)
                              .catch((err) => setError(err.response?.data?.error || 'Failed to delete item.'));
                          }} className="text-ash hover:text-oxblood" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {cat.items.length === 0 && <p className="text-ash text-xs pl-1">No items — add one above or delete this category.</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}
