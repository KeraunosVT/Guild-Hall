import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, UserPlus, Check, X, Trash2 } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

const NEW = '__new__';

export default function Names() {
  const { user, can } = useAuth();
  const [unmapped, setUnmapped] = useState([]);
  const [identities, setIdentities] = useState([]);
  const [members, setMembers] = useState([]);
  const [choice, setChoice] = useState({});       // name -> identityId | '__new__'
  const [nameDraft, setNameDraft] = useState({}); // identityId -> in-progress display name edit
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);
  const [busy, setBusy] = useState('');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerDiscordId, setNewPlayerDiscordId] = useState('');
  const [addingPlayer, setAddingPlayer] = useState(false);

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/admin/unmapped-names'),
      axios.get('/api/admin/members'),
    ])
      .then(([namesRes, membersRes]) => {
        const um = (namesRes.data.unmapped || []).sort((a, b) => a.name.localeCompare(b.name));
        setUnmapped(um);
        setIdentities(namesRes.data.identities || []);
        setMembers(membersRes.data.members || []);
        const c = {};
        um.forEach((u) => { c[u.name] = u.suggestion ? u.suggestion.id : NEW; });
        setChoice(c);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load names.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (!can('names')) {
    return <RestrictedGate />;
  }

  const removeRow = (name) => setUnmapped((prev) => prev.filter((u) => u.name !== name));

  const assign = async (u) => {
    const sel = choice[u.name];
    setBusy(u.name);
    try {
      if (sel === NEW) {
        const res = await axios.post('/api/admin/identities', { display_name: u.name, ingame_names: [u.name] });
        setIdentities((prev) => [...prev, { id: res.data.id, display_name: u.name, ingame_names: [u.name] }]
          .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')));
        flash(`Created "${u.name}".`);
      } else {
        await axios.post(`/api/admin/identities/${sel}/aliases`, { name: u.name });
        const tgt = identities.find((i) => i.id === sel);
        setIdentities((prev) => prev.map((i) => i.id === sel
          ? { ...i, ingame_names: [...(i.ingame_names || []), u.name] } : i));
        flash(`"${u.name}" → ${tgt?.display_name}.`);
      }
      removeRow(u.name);
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
    finally { setBusy(''); }
  };

  const removeAlias = async (identity, name) => {
    try {
      await axios.delete(`/api/admin/identities/${identity.id}/aliases`, { data: { name } });
      setIdentities((prev) => prev.map((i) => i.id === identity.id
        ? { ...i, ingame_names: (i.ingame_names || []).filter((n) => n !== name) } : i));
      flash(`Removed "${name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
  };

  const moveAlias = async (fromIdentity, name, toId) => {
    try {
      await axios.delete(`/api/admin/identities/${fromIdentity.id}/aliases`, { data: { name } });
      await axios.post(`/api/admin/identities/${toId}/aliases`, { name });
      setIdentities((prev) => prev.map((i) => {
        if (i.id === fromIdentity.id) return { ...i, ingame_names: (i.ingame_names || []).filter((n) => n !== name) };
        if (i.id === toId) return { ...i, ingame_names: [...(i.ingame_names || []), name] };
        return i;
      }));
      const target = identities.find((i) => i.id === toId);
      flash(`Moved "${name}" → ${target?.display_name}.`);
    } catch (err) { flash(err.response?.data?.error || 'Move failed.', false); }
  };

  const renameIdentity = async (identity, name) => {
    setNameDraft((d) => { const { [identity.id]: _, ...rest } = d; return rest; });
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === identity.display_name) return;
    try {
      await axios.put(`/api/admin/identities/${identity.id}`, { display_name: trimmed });
      setIdentities((prev) => prev.map((i) => i.id === identity.id ? { ...i, display_name: trimmed } : i));
      flash(`Renamed to "${trimmed}".`);
    } catch (err) { flash(err.response?.data?.error || 'Rename failed.', false); }
  };

  const linkDiscord = async (identity, discordId) => {
    try {
      await axios.put(`/api/admin/identities/${identity.id}/discord`, { discord_id: discordId || null });
      setIdentities((prev) => prev.map((i) => i.id === identity.id ? { ...i, discord_id: discordId || null } : i));
      const member = members.find((m) => m.id === discordId);
      flash(discordId ? `Linked to ${member?.name || discordId}.` : 'Discord link removed.');
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
  };

  const deleteIdentity = async (identity) => {
    if (!window.confirm(`Delete "${identity.display_name}"? Its in-game names will become unmapped again.`)) return;
    try {
      await axios.delete(`/api/admin/identities/${identity.id}`);
      setIdentities((prev) => prev.filter((i) => i.id !== identity.id));
      flash(`Deleted "${identity.display_name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Delete failed.', false); }
  };

  // Create a player directly — for a new member who hasn't shown up in any
  // wargame yet, so there's no unmapped in-game name to hang the "Create" flow
  // off of. Uses the same two backend calls the Unmapped flow already makes
  // (create identity, then optionally link Discord), just triggered by hand.
  const addPlayer = async () => {
    const name = newPlayerName.trim();
    if (!name) return;
    setAddingPlayer(true);
    try {
      const res = await axios.post('/api/admin/identities', { display_name: name });
      if (newPlayerDiscordId) await axios.put(`/api/admin/identities/${res.data.id}/discord`, { discord_id: newPlayerDiscordId });
      setIdentities((prev) => [...prev, { id: res.data.id, display_name: name, ingame_names: [], discord_id: newPlayerDiscordId || null }]
        .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')));
      flash(`Added "${name}".`);
      setNewPlayerName(''); setNewPlayerDiscordId('');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to add player.', false);
    } finally {
      setAddingPlayer(false);
    }
  };

  const linkedDiscordIds = useMemo(() => new Set(identities.map((i) => i.discord_id).filter(Boolean)), [identities]);

  const sortedIdentities = useMemo(
    () => [...identities].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')),
    [identities]
  );

  return (
    <PageShell>
      <Toast msg={msg} />

      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-2xl text-bone tracking-[0.08em]">
          Unmapped {!loading && !error && <span className="text-ash text-base">({unmapped.length})</span>}
        </h2>
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <EmptyState>Reading the rolls…</EmptyState>
      ) : unmapped.length === 0 ? (
        <div className="panel rounded-lg p-10 text-center">
          <div className="font-display text-brassbright text-lg tracking-[0.06em] mb-1">All names are mapped</div>
          <p className="text-ash">Every in-game name in the record belongs to a known player.</p>
        </div>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {unmapped.map((u) => (
            <div key={u.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0">
                <span className="font-medium text-bone">{u.name}</span>
                <span className="font-mono text-xs text-ash ml-2">{u.matches} match{u.matches === 1 ? '' : 'es'}</span>
                {u.suggestion && (
                  <span className="text-xs text-brass ml-2">· looks like {u.suggestion.display_name}</span>
                )}
              </div>
              <div className="flex-1" />
              <select
                value={choice[u.name] ?? NEW}
                onChange={(e) => setChoice((c) => ({ ...c, [u.name]: e.target.value }))}
                className="bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass max-w-[220px]"
              >
                <option value={NEW}>➕ New player ({u.name})</option>
                {sortedIdentities.map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}
              </select>
              <button
                onClick={() => assign(u)} disabled={busy === u.name}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg text-sm transition-colors disabled:opacity-40"
              >
                {choice[u.name] === NEW ? <UserPlus className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                {choice[u.name] === NEW ? 'Create' : 'Assign'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add a player directly — for a new member who hasn't played a wargame
          yet, so there's no unmapped in-game name to build them from below. */}
      {!loading && (
        <div className="mt-14">
          <h2 className="font-display text-2xl text-bone tracking-[0.08em] mb-2">Add a Player</h2>
          <p className="text-ash text-sm mb-4">For a new member who hasn't attended a wargame yet. Once they play, assign their in-game name to this player from the Unmapped list above instead of creating a duplicate.</p>
          <div className="panel rounded-lg p-4 flex flex-wrap items-center gap-3">
            <input
              value={newPlayerName} onChange={(e) => setNewPlayerName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPlayer(); }}
              placeholder="Display name"
              className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[160px]"
            />
            <select
              value={newPlayerDiscordId} onChange={(e) => setNewPlayerDiscordId(e.target.value)}
              className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-48"
            >
              <option value="">No Discord link yet</option>
              {members.filter((m) => !linkedDiscordIds.has(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button
              onClick={addPlayer} disabled={!newPlayerName.trim() || addingPlayer}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              <UserPlus className="w-4 h-4" /> {addingPlayer ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {/* Existing identities */}
      {!loading && sortedIdentities.length > 0 && (
        <div className="mt-14">
          <h2 className="font-display text-2xl text-bone tracking-[0.08em] mb-5">Players ({sortedIdentities.length})</h2>
          <div className="panel rounded-lg divide-y divide-line">
            {sortedIdentities.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <input
                  value={nameDraft[i.id] ?? i.display_name}
                  onChange={(e) => setNameDraft((d) => ({ ...d, [i.id]: e.target.value }))}
                  onBlur={(e) => renameIdentity(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="bg-transparent font-semibold text-bone w-40 truncate border-b border-transparent focus:outline-none focus:border-brass"
                />
                <div className="flex flex-wrap gap-2 flex-1">
                  {(i.ingame_names || []).length === 0
                    ? <span className="text-xs text-ash/60">no aliases</span>
                    : (i.ingame_names || []).map((n) => (
                      <span key={n} className="inline-flex items-center gap-1 text-xs bg-hall border border-line rounded-full pl-3 pr-1.5 py-1 text-ash">
                        {n}
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) moveAlias(i, n, e.target.value); e.target.value = ''; }}
                          className="bg-transparent text-ash text-[10px] border-none focus:outline-none cursor-pointer"
                          title={`Move "${n}" to another player`}
                        >
                          <option value="" disabled>⇄</option>
                          {sortedIdentities.filter((o) => o.id !== i.id).map((o) => (
                            <option key={o.id} value={o.id} className="bg-panelup text-bone">{o.display_name}</option>
                          ))}
                        </select>
                        <button onClick={() => removeAlias(i, n)} className="text-ash hover:text-oxblood" aria-label={`Remove ${n}`}><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                </div>
                <select
                  value={i.discord_id || ''}
                  onChange={(e) => linkDiscord(i, e.target.value)}
                  className={`bg-hall border rounded px-2 py-1 text-xs focus:outline-none focus:border-brass w-40 shrink-0 ${i.discord_id ? 'border-brass/40 text-brass' : 'border-line text-ash'}`}
                >
                  <option value="">No Discord link</option>
                  {members
                    .filter((m) => m.id === i.discord_id || !linkedDiscordIds.has(m.id))
                    .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <button onClick={() => deleteIdentity(i)} className="text-ash hover:text-oxblood shrink-0" aria-label={`Delete ${i.display_name}`} title="Delete player">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}
