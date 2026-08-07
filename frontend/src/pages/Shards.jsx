import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import SHARDS from '../../../shared/shards.json';
import BOSS_WEAPONS from '../../../shared/archbossWeapons.json';
import { Check, Loader2, AlertCircle, RefreshCw, Pencil } from 'lucide-react';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';

const MAX = SHARDS.max;
const TYPES = SHARDS.types;
const BUILDS = ['PvP', 'PvE'];
const VALID_BOSS_WEAPONS = new Set(
  Object.entries(BOSS_WEAPONS).flatMap(([boss, list]) => list.map((w) => `${boss}|${w}`))
);

const normalizeShards = (s) => {
  const out = {};
  TYPES.forEach((t) => { out[t.key] = Math.max(0, Math.min(MAX, Number(s?.[t.key]) || 0)); });
  out.weapons = Array.isArray(s?.weapons)
    ? s.weapons
        .filter((w) => w && VALID_BOSS_WEAPONS.has(`${w.boss}|${w.weapon}`))
        .map((w) => ({ boss: w.boss, weapon: w.weapon, build: BUILDS.includes(w.build) ? w.build : '' }))
    : [];
  return out;
};
const rowTotal = (s) => TYPES.reduce((a, t) => a + (Number(s[t.key]) || 0), 0);

export default function Shards() {
  const { user, can } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState({}); // memberId -> 'saving'|'saved'|'error'
  const [dirty, setDirty] = useState({});   // memberId -> bool
  const [weaponModalId, setWeaponModalId] = useState(null);

  const canEdit = (id) => user && (can('loot.awards') || user.id === id);

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/members')
      .then((res) => setMembers((res.data.members || []).map((m) => ({ ...m, shards: normalizeShards(m.shards) }))))
      .catch((err) => setError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const updateShard = (id, key, raw) => {
    const v = Math.max(0, Math.min(MAX, parseInt(raw, 10) || 0));
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, shards: { ...m.shards, [key]: v } } : m)));
    setDirty((d) => ({ ...d, [id]: true }));
  };

  const persist = (member) => {
    setDirty((d) => ({ ...d, [member.id]: false }));
    setStatus((s) => ({ ...s, [member.id]: 'saving' }));
    axios.put(`/api/shards/${member.id}`, { shards: member.shards, display_name: member.name })
      .then(() => {
        setStatus((s) => ({ ...s, [member.id]: 'saved' }));
        setTimeout(() => setStatus((s) => ({ ...s, [member.id]: undefined })), 1800);
      })
      .catch((err) => {
        setStatus((s) => ({ ...s, [member.id]: 'error' }));
        setError(err.response?.data?.error || 'Save failed.');
      });
  };

  const saveRow = (member) => {
    if (!dirty[member.id]) return;
    persist(member);
  };

  const saveWeapons = (id, weapons) => {
    setWeaponModalId(null);
    setMembers((prev) => {
      const next = prev.map((m) => (m.id === id ? { ...m, shards: { ...m.shards, weapons } } : m));
      persist(next.find((m) => m.id === id));
      return next;
    });
  };

  // Self pinned to top, then alphabetical; then filtered.
  const ordered = useMemo(() => {
    const sorted = [...members].sort((a, b) => {
      if (user && a.id === user.id) return -1;
      if (user && b.id === user.id) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    const f = filter.toLowerCase();
    return sorted.filter((m) => (m.name || '').toLowerCase().includes(f));
  }, [members, filter, user]);

  const totals = useMemo(() => {
    const t = {};
    TYPES.forEach((ty) => { t[ty.key] = members.reduce((a, m) => a + (Number(m.shards[ty.key]) || 0), 0); });
    return t;
  }, [members]);

  const weaponModalMember = weaponModalId ? members.find((m) => m.id === weaponModalId) : null;

  return (
    <PageShell maxWidth="max-w-[1400px]">
      <p className="text-sm text-ash mb-5">
        {can('loot.awards')
          ? 'Track every member’s shard requests. You can edit any row.'
          : 'Track your shard requests. You can edit your own row; others are read-only.'} Max {MAX} of each.
        <span className="block text-bone font-bold uppercase mt-1.5">Put how many you need, not how many you have AND keep it updated</span>
      </p>

      <div className="flex items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass shrink-0"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {error && (
        <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>
      )}

      {loading ? (
        <EmptyState>Reading the vault…</EmptyState>
      ) : ordered.length === 0 ? (
        <EmptyState>No members found.</EmptyState>
      ) : (
        <div className="panel rounded-lg overflow-auto max-h-[70vh]">
          <table className="w-full min-w-[1160px] text-sm border-separate border-spacing-0">
            <thead>
              <tr className="eyebrow text-[10px] text-ash">
                <th className="sticky top-0 z-10 bg-panel p-4 text-left font-normal border-b border-line">Member</th>
                {TYPES.map((t) => <th key={t.key} className="sticky top-0 z-10 bg-panel p-4 text-center font-normal border-b border-line">{t.label}</th>)}
                <th className="sticky top-0 z-10 bg-panel p-4 text-center font-normal border-b border-line">Total</th>
                <th className="sticky top-0 z-10 bg-panel p-4 text-left font-normal border-b border-line">Weapons</th>
                <th className="sticky top-0 z-10 bg-panel p-3 w-8 border-b border-line"></th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => {
                const mine = user && m.id === user.id;
                const editable = canEdit(m.id);
                const weapons = m.shards.weapons || [];
                return (
                  <tr key={m.id} className={`[&>td]:border-b [&>td]:border-line/60 ${mine ? 'bg-brass/5' : ''}`}>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        {m.avatar
                          ? <img src={m.avatar} alt="" className="w-6 h-6 rounded-full border border-line shrink-0" />
                          : <span className="w-6 h-6 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[10px] text-brass">{(m.name || '?').slice(0, 1).toUpperCase()}</span>}
                        <span className="text-bone truncate max-w-[160px]">{m.name}</span>
                        {mine && <span className="text-[9px] eyebrow text-brass border border-brass/40 rounded-full px-1.5 py-0.5">You</span>}
                      </div>
                    </td>
                    {TYPES.map((t) => (
                      <td key={t.key} className="p-3 text-center">
                        {editable ? (
                          <input
                            type="number" min={0} max={MAX} value={m.shards[t.key]}
                            onChange={(e) => updateShard(m.id, t.key, e.target.value)}
                            onBlur={() => saveRow(m)}
                            className="w-16 bg-hall border border-line rounded px-2 py-1.5 text-center font-mono text-bone focus:outline-none focus:border-brass"
                          />
                        ) : (
                          <span className="font-mono text-ash">{m.shards[t.key]}</span>
                        )}
                      </td>
                    ))}
                    <td className="p-3 text-center font-mono text-brassbright">{rowTotal(m.shards)}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-[320px] max-w-[420px]">
                        {weapons.length === 0 && <span className="text-ash/50 text-xs">none set</span>}
                        {weapons.map((w, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-hall border border-line rounded-full px-2 py-0.5 text-ash" title={w.boss}>
                            {w.weapon}
                            {w.build && <span className={w.build === 'PvP' ? 'text-oxblood' : 'text-emerald-400'}>· {w.build}</span>}
                          </span>
                        ))}
                        {editable && (
                          <button onClick={() => setWeaponModalId(m.id)} className="text-brass hover:text-brassbright shrink-0" title="Edit weapon wishlist">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      {status[m.id] === 'saving' && <Loader2 className="w-4 h-4 text-ash animate-spin inline" />}
                      {status[m.id] === 'saved' && <Check className="w-4 h-4 text-emerald-400 inline" />}
                      {status[m.id] === 'error' && <AlertCircle className="w-4 h-4 text-oxblood inline" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-line bg-panelup/60">
                <td className="p-4 eyebrow text-[10px] text-brass">Guild Total</td>
                {TYPES.map((t) => <td key={t.key} className="p-4 text-center font-mono text-brassbright">{totals[t.key]}</td>)}
                <td className="p-4 text-center font-mono text-brassbright">{TYPES.reduce((a, t) => a + totals[t.key], 0)}</td>
                <td></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {weaponModalMember && (
        <WeaponModal
          member={weaponModalMember}
          onClose={() => setWeaponModalId(null)}
          onSave={(weapons) => saveWeapons(weaponModalMember.id, weapons)}
        />
      )}
    </PageShell>
  );
}

// Modal for picking specific archboss weapons (with a per-weapon PvP/PvE tag).
// Keeps its own draft state so nothing is written until "Save".
function WeaponModal({ member, onClose, onSave }) {
  const [picks, setPicks] = useState(() => member.shards.weapons || []);

  const findPick = (boss, weapon) => picks.find((p) => p.boss === boss && p.weapon === weapon);

  const toggle = (boss, weapon) => {
    setPicks((prev) => findPick(boss, weapon)
      ? prev.filter((p) => !(p.boss === boss && p.weapon === weapon))
      : [...prev, { boss, weapon, build: '' }]);
  };

  const setBuild = (boss, weapon, build) => {
    setPicks((prev) => prev.map((p) => (p.boss === boss && p.weapon === weapon)
      ? { ...p, build: p.build === build ? '' : build }
      : p));
  };

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" scrollable>
      <div className="eyebrow text-brass text-[11px] mb-3">Weapon Wishlist</div>
      <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-4">{member.name}</h2>

        <div className="space-y-5">
          {Object.entries(BOSS_WEAPONS).map(([boss, weaponList]) => (
            <div key={boss}>
              <div className="text-brass text-sm font-semibold mb-2">{boss}</div>
              <div className="space-y-1.5">
                {weaponList.map((weapon) => {
                  const pick = findPick(boss, weapon);
                  return (
                    <div key={weapon} className="flex items-center gap-2">
                      <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer select-none">
                        <input type="checkbox" checked={!!pick} onChange={() => toggle(boss, weapon)} className="accent-brass shrink-0" />
                        <span className="text-sm text-bone truncate">{weapon}</span>
                      </label>
                      {pick && (
                        <div className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 shrink-0">
                          {BUILDS.map((b) => (
                            <button key={b} type="button" onClick={() => setBuild(boss, weapon, b)}
                              className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide transition-colors ${
                                pick.build === b ? (b === 'PvP' ? 'bg-oxblood text-bone' : 'bg-emerald-500 text-ink') : 'text-ash hover:text-bone'
                              }`}
                            >
                              {b.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

      <div className="flex justify-end gap-3 mt-6">
        <Button variant="neutral" size="none" className="px-4 py-2" onClick={onClose}>Cancel</Button>
        <Button size="none" className="px-5 py-2" onClick={() => onSave(picks)}>Save</Button>
      </div>
    </Modal>
  );
}
