import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import weaponToClass from '../../../shared/weaponClasses.json';
import { UploadCloud, Plus, Trash2, X, Image as ImageIcon, FileSpreadsheet, Loader2, Check, AlertCircle, RotateCw, Map as MapIcon } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { Table, Thead } from '../components/ui/Table';

const WEAPONS = ['SnS', 'Greatsword', 'Dagger', 'Crossbow', 'Longbow', 'Staff', 'Wand', 'Spear', 'Orb', 'Gauntlet'];
const STAT_COLS = ['kills', 'assists', 'damage_dealt', 'damage_taken', 'healing'];

// Class options + reverse map (class -> [weapon_1, weapon_2]), derived from the
// shared weapon→class table so the DB keeps storing weapons.
const CLASS_LIST = [...new Set(Object.values(weaponToClass))].sort();
const CLASS_TO_WEAPONS = (() => {
  const map = {};
  const splitKey = (key) => {
    for (const w1 of WEAPONS) {
      if (key.startsWith(w1)) {
        const rest = key.slice(w1.length);
        if (WEAPONS.includes(rest)) return [w1, rest];
      }
    }
    return null;
  };
  for (const [key, cls] of Object.entries(weaponToClass)) {
    const pair = splitKey(key);
    if (pair && !map[cls]) map[cls] = pair;
  }
  return map;
})();
const weaponsToClass = (w1, w2) => {
  const a = (w1 || '').trim();
  const b = (w2 || '').trim();
  return weaponToClass[a + b] || weaponToClass[b + a] || '';
};

const emptyRow = () => ({
  rank: '', weapon_1: '', weapon_2: '', guild_name: '', player_name: '',
  team_color: '', kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0,
});

export default function Admin() {
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [items, setItems] = useState([]); // {id,file,status:'idle'|'processing'|'done'|'failed',players,error,retryable}
  const [title, setTitle] = useState('');
  const [matchDate, setMatchDate] = useState('');
  const [result, setResult] = useState('');
  const [map, setMap] = useState('');
  const [maps, setMaps] = useState([]);
  const [showMapAdmin, setShowMapAdmin] = useState(false);
  const [newMapName, setNewMapName] = useState('');
  const [players, setPlayers] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [running, setRunning] = useState(false);   // a parse pass is in progress
  const [merging, setMerging] = useState(false);    // building the review set
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [mappedNames, setMappedNames] = useState(null); // Set of normalized known names
  const [editingMatchId, setEditingMatchId] = useState(null);
  const [loadingEdit, setLoadingEdit] = useState(false);

  // Load known names so the review table can flag unrecognized ones.
  useEffect(() => {
    axios.get('/api/admin/identities')
      .then((res) => {
        const s = new Set();
        (res.data.identities || []).forEach((it) => {
          if (it.display_name) s.add(it.display_name.trim().toLowerCase());
          (Array.isArray(it.ingame_names) ? it.ingame_names : []).forEach((n) => s.add((n || '').trim().toLowerCase()));
        });
        setMappedNames(s);
      })
      .catch(() => setMappedNames(new Set()));
  }, []);

  const loadMaps = () => {
    axios.get('/api/maps').then((res) => setMaps(res.data.maps || [])).catch(() => {});
  };
  useEffect(() => { loadMaps(); }, []);

  const addMap = () => {
    if (!newMapName.trim()) return;
    axios.post('/api/admin/maps', { name: newMapName.trim() })
      .then(() => { setNewMapName(''); loadMaps(); })
      .catch((err) => setError(err.response?.data?.error || 'Failed to add map.'));
  };
  const deleteMap = (id) => {
    axios.delete(`/api/admin/maps/${id}`)
      .then(loadMaps)
      .catch((err) => setError(err.response?.data?.error || 'Failed to delete map.'));
  };

  // Load existing match when ?edit=<id> is in the URL.
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId) return;
    setLoadingEdit(true);
    setError('');
    axios.get(`/api/admin/match/${editId}`)
      .then((res) => {
        const m = res.data.match;
        setEditingMatchId(editId);
        setTitle(m.title || '');
        setMatchDate(m.match_date ? m.match_date.slice(0, 10) : '');
        setResult(m.result || '');
        setMap(m.map || '');
        setPlayers(res.data.players || []);
        setWarnings([]);
        setDone(null);
        setItems([]);
      })
      .catch((err) => {
        setError(err.response?.data?.error || 'Failed to load match for editing.');
      })
      .finally(() => setLoadingEdit(false));
  }, [searchParams]);

  const isUnknown = (name) => {
    if (!mappedNames) return false; // don't flag until loaded
    const n = (name || '').trim().toLowerCase();
    return n && !mappedNames.has(n);
  };

  if (!can('match')) {
    return <RestrictedGate />;
  }

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    setItems((prev) => {
      const have = new Set(prev.map((it) => it.id));
      const next = incoming
        .map((f) => ({ id: f.name + f.size, file: f, status: 'idle', players: [], error: '', retryable: false }))
        .filter((it) => !have.has(it.id));
      return [...prev, ...next];
    });
    setError('');
  };
  const removeFile = (id) => setItems((prev) => prev.filter((it) => it.id !== id));
  const setItem = (id, patch) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  // Parse a single file; mark it done with its rows, or failed (retryable when
  // the reader is just busy).
  const processOne = async (id, file) => {
    setItem(id, { status: 'processing', error: '' });
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await axios.post('/api/admin/match/parse-one', form);
      setItem(id, { status: 'done', players: res.data.players || [], error: '' });
    } catch (err) {
      setItem(id, {
        status: 'failed',
        error: err.response?.data?.error || 'Could not read that file.',
        retryable: err.response?.data?.retryable !== false,
      });
    }
  };

  // Process a set of items with limited concurrency (gentler on the reader).
  const runPool = async (targets, limit = 2) => {
    if (targets.length === 0) return;
    setRunning(true); setError('');
    const q = [...targets];
    const worker = async () => { while (q.length) { const it = q.shift(); await processOne(it.id, it.file); } };
    await Promise.all(Array.from({ length: Math.min(limit, q.length) }, worker));
    setRunning(false);
  };

  const parseAll = () => runPool(items.filter((it) => it.status === 'idle' || it.status === 'failed'));
  const retryFailed = () => runPool(items.filter((it) => it.status === 'failed'));
  const retryOne = (id) => { const it = items.find((x) => x.id === id); if (it) runPool([it], 1); };

  // Merge every successfully-read file into the reviewed set.
  const goReview = async () => {
    const done = items.filter((it) => it.status === 'done');
    if (done.length === 0) return;
    setMerging(true); setError(''); setDone(null);
    try {
      const res = await axios.post('/api/admin/match/merge', { players: done.flatMap((it) => it.players), fileCount: done.length });
      setPlayers(res.data.players || []);
      setWarnings(res.data.warnings || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not build the review.');
    } finally {
      setMerging(false);
    }
  };

  const updateCell = (i, key, value) =>
    setPlayers((prev) => prev.map((p, idx) => (idx === i ? { ...p, [key]: value } : p)));
  const updateClass = (i, className) => {
    const pair = CLASS_TO_WEAPONS[className] || ['', ''];
    setPlayers((prev) => prev.map((p, idx) => (idx === i ? { ...p, weapon_1: pair[0], weapon_2: pair[1] } : p)));
  };
  const addRow = () => setPlayers((prev) => [...(prev || []), emptyRow()]);
  const removeRow = (i) => setPlayers((prev) => prev.filter((_, idx) => idx !== i));

  const commit = async () => {
    setCommitting(true); setError('');
    try {
      let res;
      if (editingMatchId) {
        res = await axios.put(`/api/admin/match/${editingMatchId}`, { title, match_date: matchDate, result, map, players });
      } else {
        res = await axios.post('/api/admin/match/commit', { title, match_date: matchDate, result, map, players });
      }
      setDone(editingMatchId ? { ...res.data, edited: true } : res.data);
      setPlayers(null); setItems([]); setTitle(''); setMatchDate(''); setResult(''); setMap(''); setWarnings([]);
      if (editingMatchId) {
        setEditingMatchId(null);
        setSearchParams({});
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the match.');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <PageShell maxWidth="max-w-7xl">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h1 className="font-display text-2xl text-bone tracking-[0.06em]">{editingMatchId ? 'Edit Match' : 'Upload a Match'}</h1>
          <p className="text-ash text-sm mt-1">
            {editingMatchId
              ? 'Revise the record — update any row, then save your changes.'
              : 'Read results screenshots or a CSV, review every row, then commit it to the record.'}
          </p>
        </div>
        <button
          onClick={() => setShowMapAdmin((v) => !v)}
          className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors shrink-0"
        >
          <MapIcon className="w-4 h-4" /> {showMapAdmin ? 'Close map manager' : 'Manage maps'}
        </button>
      </div>

      {showMapAdmin && (
        <div className="mt-4 panel rounded-lg p-5">
          <div className="eyebrow text-brass text-[10px] mb-3">Wargame Maps</div>
          <div className="flex gap-2 mb-3">
            <input value={newMapName} onChange={(e) => setNewMapName(e.target.value)} placeholder="Map name"
              onKeyDown={(e) => { if (e.key === 'Enter') addMap(); }}
              className="bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
            <button onClick={addMap} disabled={!newMapName.trim()}
              className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-1.5">
            {maps.length === 0 ? (
              <p className="text-ash text-sm">No maps yet. Add your wargame maps above.</p>
            ) : maps.map((m) => (
              <div key={m.id} className="flex items-center justify-between bg-hall border border-line rounded-lg px-3 py-2">
                <span className="text-bone text-sm">{m.name}</span>
                <button onClick={() => deleteMap(m.id)} className="text-ash hover:text-oxblood"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rule-fade my-6" />

      {done && (
        <div className="mb-6 panel rounded-lg p-5 border-brass/40">
          <div className="font-display text-brassbright text-lg tracking-[0.06em] mb-1">
            {done.edited ? 'Record updated' : 'Logged to the record'}
          </div>
          <p className="text-ash">
            {done.edited ? `${done.updated} players updated.` : `${done.inserted} players saved.`}
            {' '}<Link to="/war-record" className="text-brass hover:text-brassbright">View the war record →</Link>
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 px-4 py-3 border border-oxblood/50 bg-oxblooddeep/20 rounded-lg text-bone">{error}</div>
      )}

      {loadingEdit && (
        <div className="py-20 text-center text-ash flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading match…
        </div>
      )}

      {/* Step 1 — upload */}
      {!players && !loadingEdit && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-3">
            <label className="block panel rounded-lg border-dashed border-2 border-line hover:border-brass/50 transition-colors cursor-pointer p-10 text-center">
              <input
                type="file" accept="image/*,.csv" multiple className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <UploadCloud className="w-8 h-8 text-brass mx-auto mb-4" />
              <div className="text-ash">
                Click to choose screenshots (select several at once) or a CSV
              </div>
            </label>

            {items.length > 0 && (
              <div className="space-y-3">
                {(running || items.some((it) => it.status === 'done' || it.status === 'failed')) && (
                  <div>
                    <div className="flex justify-between text-xs text-ash mb-1.5">
                      <span>
                        {items.filter((it) => it.status === 'done').length} of {items.length} read
                        {items.some((it) => it.status === 'failed') ? ` · ${items.filter((it) => it.status === 'failed').length} failed` : ''}
                      </span>
                      {running && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Reading…</span>}
                    </div>
                    <div className="h-1.5 bg-hall rounded-full overflow-hidden flex">
                      <div className="bg-brass transition-all" style={{ width: `${(items.filter((it) => it.status === 'done').length / items.length) * 100}%` }} />
                      <div className="bg-oxblood transition-all" style={{ width: `${(items.filter((it) => it.status === 'failed').length / items.length) * 100}%` }} />
                    </div>
                  </div>
                )}

                <div className="panel rounded-lg divide-y divide-line">
                  {items.map((it) => (
                    <div key={it.id} className="flex items-center gap-3 px-3 py-2">
                      {/\.csv$/i.test(it.file.name) ? <FileSpreadsheet className="w-4 h-4 text-brass shrink-0" /> : <ImageIcon className="w-4 h-4 text-brass shrink-0" />}
                      <span className="text-sm text-bone truncate flex-1">{it.file.name}</span>

                      {it.status === 'processing' && <span className="text-xs text-ash inline-flex items-center gap-1 shrink-0"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading…</span>}
                      {it.status === 'done' && <span className="text-xs text-emerald-400 inline-flex items-center gap-1 shrink-0"><Check className="w-3.5 h-3.5" /> {it.players.length} row{it.players.length === 1 ? '' : 's'}</span>}
                      {it.status === 'failed' && (
                        <span className="text-xs text-oxblood inline-flex items-center gap-1.5 shrink-0" title={it.error}>
                          <AlertCircle className="w-3.5 h-3.5" /> Failed
                          {it.retryable && (
                            <button onClick={() => retryOne(it.id)} disabled={running} className="inline-flex items-center gap-0.5 text-brass hover:text-brassbright disabled:opacity-40">
                              <RotateCw className="w-3 h-3" /> Retry
                            </button>
                          )}
                        </span>
                      )}

                      {it.status !== 'processing' && (
                        <button onClick={() => removeFile(it.id)} className="text-ash hover:text-oxblood shrink-0" aria-label="Remove"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>

                {items.some((it) => it.status === 'failed') && !running && (
                  <button onClick={retryFailed} className="text-sm text-brass hover:text-brassbright inline-flex items-center gap-1.5">
                    <RotateCw className="w-4 h-4" /> Retry {items.filter((it) => it.status === 'failed').length} failed
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-1.5">Match title</label>
              <input
                value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Castle Siege — Abyssal"
                className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
              />
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-1.5">Match date</label>
              <input
                type="date" value={matchDate} onChange={(e) => setMatchDate(e.target.value)}
                className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
              />
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-1.5">Result</label>
              <select
                value={result} onChange={(e) => setResult(e.target.value)}
                className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
              >
                <option value="">— set result —</option>
                <option value="Win">Win</option>
                <option value="Loss">Loss</option>
                <option value="Draw">Draw</option>
              </select>
            </div>
            <div>
              <label className="eyebrow text-[10px] text-ash block mb-1.5">Map</label>
              <select
                value={map} onChange={(e) => setMap(e.target.value)}
                className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
              >
                <option value="">— set map —</option>
                {maps.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              {items.some((it) => it.status === 'idle') && (
                <button
                  onClick={parseAll} disabled={running || merging}
                  className="w-full px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {running ? 'Reading…' : `Read ${items.filter((it) => it.status === 'idle').length} file${items.filter((it) => it.status === 'idle').length === 1 ? '' : 's'}`}
                </button>
              )}

              {items.some((it) => it.status === 'done') && (
                <button
                  onClick={goReview} disabled={running || merging}
                  className="w-full px-6 py-2.5 border border-brass/50 text-brassbright hover:bg-panelup font-semibold rounded-lg transition-colors disabled:opacity-40"
                >
                  {merging ? 'Preparing…' : `Continue to review (${items.filter((it) => it.status === 'done').length} file${items.filter((it) => it.status === 'done').length === 1 ? '' : 's'}) →`}
                </button>
              )}

              {items.length === 0 && (
                <button disabled className="w-full px-6 py-2.5 bg-brass text-ink font-semibold rounded-lg opacity-40 cursor-not-allowed">Read files</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step 2 — review & edit */}
      {players && (
        <div>
          {warnings.length > 0 && (
            <div className="mb-4 px-4 py-3 border border-brass/40 bg-panel rounded-lg text-sm text-bone">
              <div className="eyebrow text-[10px] text-brass mb-2">Check before saving</div>
              <ul className="list-disc pl-5 space-y-1 text-ash">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {editingMatchId && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-1.5">Match title</label>
                <input
                  value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Castle Siege — Abyssal"
                  className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                />
              </div>
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-1.5">Match date</label>
                <input
                  type="date" value={matchDate} onChange={(e) => setMatchDate(e.target.value)}
                  className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                />
              </div>
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-1.5">Result</label>
                <select
                  value={result} onChange={(e) => setResult(e.target.value)}
                  className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                >
                  <option value="">— set result —</option>
                  <option value="Win">Win</option>
                  <option value="Loss">Loss</option>
                  <option value="Draw">Draw</option>
                </select>
              </div>
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-1.5">Map</label>
                <select
                  value={map} onChange={(e) => setMap(e.target.value)}
                  className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
                >
                  <option value="">— set map —</option>
                  {maps.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-2xl text-bone tracking-[0.08em]">
              {editingMatchId ? 'Edit' : 'Review'} — {players.length} players
            </h2>
            <button onClick={addRow} className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright">
              <Plus className="w-4 h-4" /> Add row
            </button>
          </div>

          <div className="mb-6">
          <Table maxHeight="max-h-[640px]" minWidth="min-w-[1000px]">
            <Thead sticky>
              <th className="p-2.5 text-left font-normal w-16">Rank</th>
              <th className="p-2.5 text-left font-normal">Class</th>
              <th className="p-2.5 text-left font-normal">Guild</th>
              <th className="p-2.5 text-left font-normal">Name</th>
              <th className="p-2.5 text-left font-normal">Team</th>
              <th className="p-2.5 text-left font-normal">Kills</th>
              <th className="p-2.5 text-left font-normal">Assists</th>
              <th className="p-2.5 text-left font-normal">Dmg Dealt</th>
              <th className="p-2.5 text-left font-normal">Dmg Taken</th>
              <th className="p-2.5 text-left font-normal">Healing</th>
              <th className="p-2.5 w-10"></th>
            </Thead>
              <tbody>
                {players.map((p, i) => {
                  const cls = weaponsToClass(p.weapon_1, p.weapon_2);
                  return (
                    <tr key={i} className="border-b border-line/60">
                      <td className="p-1.5"><NumCell value={p.rank} onChange={(v) => updateCell(i, 'rank', v)} w="w-14" /></td>
                      <td className="p-1.5">
                        <select
                          value={cls} onChange={(e) => updateClass(i, e.target.value)}
                          className={`bg-hall border rounded px-2 py-1.5 focus:outline-none focus:border-brass w-40 ${cls ? 'border-line text-bone' : 'border-oxblood/60 text-oxblood'}`}
                        >
                          <option value="">— set class —</option>
                          {CLASS_LIST.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="p-1.5"><TextCell value={p.guild_name} onChange={(v) => updateCell(i, 'guild_name', v)} /></td>
                      <td className="p-1.5">
                        <div className="flex items-center gap-1.5">
                          <TextCell value={p.player_name} onChange={(v) => updateCell(i, 'player_name', v)} />
                          {isUnknown(p.player_name) && (
                            <span title="Unrecognized name — map it on the Names page after saving" className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                          )}
                        </div>
                      </td>
                      <td className="p-1.5">
                        <select
                          value={p.team_color} onChange={(e) => updateCell(i, 'team_color', e.target.value)}
                          className="bg-hall border border-line rounded px-2 py-1.5 text-bone focus:outline-none focus:border-brass w-24"
                        >
                          <option value="">—</option>
                          <option value="Yellow">Yellow</option>
                          <option value="Red">Red</option>
                        </select>
                      </td>
                      {STAT_COLS.map((col) => (
                        <td key={col} className="p-1.5"><NumCell value={p[col]} onChange={(v) => updateCell(i, col, v)} /></td>
                      ))}
                      <td className="p-1.5 text-center">
                        <button onClick={() => removeRow(i)} className="text-ash hover:text-oxblood" aria-label="Remove row">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
          </Table>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={commit} disabled={committing || players.length === 0}
              className="px-8 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40"
            >
              {committing ? 'Saving…' : editingMatchId ? `Save ${players.length} players` : `Commit ${players.length} players`}
            </button>
            <button
              onClick={() => {
                setPlayers(null); setWarnings([]);
                if (editingMatchId) { setEditingMatchId(null); setSearchParams({}); setTitle(''); setMatchDate(''); setResult(''); setMap(''); }
              }}
              className="px-6 py-3 text-ash hover:text-bone transition-colors"
            >
              {editingMatchId ? 'Cancel edit' : 'Discard'}
            </button>
            <span className="text-sm text-ash">{title || 'Untitled match'}{matchDate ? ` · ${matchDate}` : ''}</span>
          </div>
        </div>
      )}
    </PageShell>
  );
}

function TextCell({ value, onChange }) {
  return (
    <input
      value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      className="bg-hall border border-line rounded px-2 py-1.5 text-bone focus:outline-none focus:border-brass w-full min-w-[120px]"
    />
  );
}

function NumCell({ value, onChange, w = 'w-24' }) {
  return (
    <input
      type="number" value={value ?? 0} onChange={(e) => onChange(e.target.value)}
      className={`bg-hall border border-line rounded px-2 py-1.5 text-bone font-mono focus:outline-none focus:border-brass ${w}`}
    />
  );
}
