import { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Search, Link2, Link2Off, Crown, Pencil } from 'lucide-react';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Tabs from '../components/ui/Tabs';
import { useFlash } from '../components/ui/useFlash';

// The Americas threat board — a PUBLIC page, belonging to no guild. It renders
// outside Gate and outside Layout (see App.jsx), which is why it carries its own
// page chrome below instead of inheriting the sidebar: a visitor with no session
// has no house for a sidebar to describe.
//
// The board is seeded from the community spreadsheet (shared/threatBoard.json)
// and then maintained here: ratings, transfer cooldowns, names and which cluster
// a guild sits on after a server transfer are all editable, as is the alliance
// map. One board for everyone, and only Guild Hall staff may change it — a
// platform role, not a guild capability, so no house can grant it to itself.
// See backend/staff.js and migrations/saas_007.
//
// TWO AXES, TWO VISUAL CHANNELS. Threat rating owns colour, because there are
// six ratings and colour is the only channel that separates six things at a
// glance. Alliance therefore cannot also be colour without the two becoming
// unreadable together, so it owns structure instead: a rail down the left of a
// bonded pair, and the pair rendered as one block. Keep it that way when
// editing — the moment alliance borrows a hue, the board stops being scannable.
const STATUSES = [
  { key: 'Threat', short: 'Threat', dot: 'bg-fuchsia-400', text: 'text-fuchsia-300', tint: 'bg-fuchsia-500/10' },
  { key: 'Competitive', short: 'Competitive', dot: 'bg-amber-400', text: 'text-amber-300', tint: 'bg-amber-500/10' },
  { key: 'Potential', short: 'Potential', dot: 'bg-yellow-300', text: 'text-yellow-200', tint: 'bg-yellow-500/10' },
  { key: 'Rebuild/TBD', short: 'Rebuild / TBD', dot: 'bg-sky-400', text: 'text-sky-300', tint: 'bg-sky-500/10' },
  { key: 'Not Competitive', short: 'Not competitive', dot: 'bg-emerald-400', text: 'text-emerald-300', tint: 'bg-emerald-500/10' },
  { key: 'Disbanded/Merged', short: 'Disbanded', dot: 'bg-zinc-500', text: 'text-ash', tint: 'bg-zinc-500/10' },
];
const RANK = Object.fromEntries(STATUSES.map((s, i) => [s.key, i]));
const META = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
const DEAD = 'Disbanded/Merged';

// Strongest first, cluster leaders above everything.
const byStrength = (a, b) => (b.king ? 1 : 0) - (a.king ? 1 : 0)
  || RANK[a.status] - RANK[b.status]
  || a.name.localeCompare(b.name);

// A column is a list of units: a bonded pair whose halves are BOTH visible here,
// or a lone guild. Order, in priority:
//
//   1. the crown — whoever holds the cluster leads it, bonded or not, because
//      it is the guild every other guild on the column is measured against;
//   2. alliances — the thing a reader opens this page to find, so a pair does
//      not sit down the column behind guilds that matter less;
//   3. everything else, strongest first.
//
// The crown rule wins outright: without it a pair of two Not-Competitive guilds
// would outrank the guild that actually holds the server. When the crown IS
// bonded, its pair already leads the pairs and rule 1 changes nothing.
//
// A pair split across clusters, or with one half hidden by a filter, degrades to
// two singles that each still name their partner on the chip.
export function unitsFor(list, partnerOf) {
  // Keyed by id, not name: two guilds on different servers may share a name,
  // so a name identifies nothing on its own.
  const byId = new Map(list.map((g) => [g.id, g]));

  const used = new Set();
  const pairs = [];
  const singles = [];
  for (const g of list) {
    if (used.has(g)) continue;
    const partnerId = partnerOf(g.id);
    const mate = partnerId ? byId.get(partnerId) : null;
    if (mate && mate !== g && !used.has(mate)) {
      used.add(g);
      used.add(mate);
      pairs.push([g, mate].sort(byStrength));
    } else {
      used.add(g);
      singles.push([g]);
    }
  }
  const lead = (u, v) => byStrength(u[0], v[0]);
  const ordered = [...pairs.sort(lead), ...singles.sort(lead)];

  // Rule 1, applied last so it beats the pairs-first grouping above. Searched
  // rather than assumed: a filtered view may not contain the crown at all.
  const crown = ordered.findIndex((u) => u.some((g) => g.king));
  if (crown > 0) ordered.unshift(...ordered.splice(crown, 1));
  return ordered;
}

function GuildChip({ guild, partner, picking, canEdit, onPick, onEdit }) {
  const m = META[guild.status];
  const dead = guild.status === DEAD;
  return (
    <div
      className={`group flex items-stretch rounded-lg border overflow-hidden transition-colors ${m.tint} ${
        picking ? 'border-brass ring-1 ring-brass' : 'border-transparent hover:border-line'
      }`}
    >
      <button
        type="button"
        onClick={() => canEdit && onPick(guild)}
        disabled={!canEdit}
        title={canEdit ? `${guild.name} — click to pair` : guild.name}
        className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className={`text-[13px] font-medium break-words leading-snug ${dead ? 'text-ash line-through' : 'text-bone'}`}>
            {guild.name}
          </span>
          {/* Only when the ally is NOT rendered beside this chip — otherwise the
              rail already says it and the name is noise. */}
          {partner && (
            <span className="text-[10px] text-ash leading-snug break-words">
              <span className="text-bone">⇄</span> {partner}
            </span>
          )}
        </span>
        {guild.king && <Crown className="w-3 h-3 text-brass shrink-0" title="Top guild on this cluster" />}
        {guild.cd && guild.cd !== 'No CD' && (
          <span className="shrink-0 font-mono text-[9px] px-1 py-px rounded border border-line text-ash">{guild.cd}</span>
        )}
      </button>
      {/* Two targets rather than a mode switch: the chip body pairs, the pencil
          edits. Faint until hover or focus so 130 of them don't shout. */}
      {canEdit && (
        <button
          type="button"
          onClick={() => onEdit(guild)}
          title={`Edit ${guild.name}`}
          aria-label={`Edit ${guild.name}`}
          className="w-6 shrink-0 flex items-center justify-center text-line hover:text-brassbright focus:text-brassbright group-hover:text-ash transition-colors"
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// Rating, transfer cooldown, name, and which cluster a guild sits on after a
// server transfer. Every field is sent only when it actually changed, so a save
// that touches one dropdown is a one-field patch.
function GuildEditor({ guild, data, onClose, onSaved, flash }) {
  const [name, setName] = useState(guild.name);
  const [cluster, setCluster] = useState(guild.cluster);
  const [status, setStatus] = useState(guild.status);
  const [cd, setCd] = useState(guild.cd || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = name.trim();
  const patch = {};
  if (trimmed && trimmed !== guild.name) patch.name = trimmed;
  if (cluster !== guild.cluster) patch.cluster = cluster;
  if (status !== guild.status) patch.status = status;
  if (cd !== (guild.cd || '')) patch.cd = cd;
  const dirty = Object.keys(patch).length > 0;

  const partnerId = data.allies[guild.id];
  const partner = data.guilds.find((g) => g.id === partnerId);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await axios.patch(`/api/threat-board/guild/${guild.id}`, patch);
      await onSaved();
      flash(patch.name ? `${guild.name} is now ${patch.name}.` : `${guild.name} updated.`);
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save.');
      setSaving(false);
    }
  }

  const field = 'w-full bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass';

  return (
    <Modal onClose={onClose} maxWidth="max-w-md">
      <h2 className="font-display text-lg text-bone mb-1">Edit guild</h2>
      <p className="text-ash text-xs mb-5">
        {guild.cluster}
        {partner && <> · allied with <span className="text-bone">{partner.name}</span></>}
      </p>

      <div className="space-y-4">
        <div>
          <label htmlFor="tb-name" className="eyebrow text-[10px] text-ash block mb-1.5">Name</label>
          <input id="tb-name" value={name} onChange={(e) => setName(e.target.value)} className={field}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          {patch.name && (
            <p className="text-[11px] text-ash mt-1.5">
              Renaming carries the alliance with it — no bond is lost.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="tb-status" className="eyebrow text-[10px] text-ash block mb-1.5">Threat rating</label>
          <select id="tb-status" value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
            {(data.statuses || STATUSES.map((s) => s.key)).map((s) => (
              <option key={s} value={s}>{META[s]?.short || s}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="tb-cluster" className="eyebrow text-[10px] text-ash block mb-1.5">Server cluster</label>
          <select id="tb-cluster" value={cluster} onChange={(e) => setCluster(e.target.value)} className={field}>
            {data.clusters.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
          </select>
          {patch.cluster && (
            <p className="text-[11px] text-ash mt-1.5">
              Moves to {patch.cluster}. A cross-cluster alliance still shows on both columns.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="tb-cd" className="eyebrow text-[10px] text-ash block mb-1.5">Server transfer cooldown</label>
          <select id="tb-cd" value={cd} onChange={(e) => setCd(e.target.value)} className={field}>
            <option value="">— not recorded —</option>
            {(data.cds || ['30 Days', '15 Days', 'No CD']).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="text-oxblood text-sm mt-4">{error}</p>}

      <div className="flex justify-end gap-2 mt-6">
        <Button variant="neutral" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}

// Page chrome for a page with no guild behind it. Deliberately thin: a
// wordmark home, and a way in for whoever turns out to run the place.
function PublicShell({ children }) {
  const { user, login } = useAuth();
  return (
    <div className="min-h-screen bg-ink text-bone flex flex-col">
      <header className="border-b border-line flex items-center gap-3 px-6 h-14 shrink-0">
        <a href="/" className="flex items-center gap-3 text-bone hover:text-brassbright transition-colors">
          <Sigil className="w-6 h-8 text-brass shrink-0" />
          <span className="font-display text-sm tracking-[0.18em]">GUILD HALL</span>
        </a>
        <span className="text-line">/</span>
        <span className="eyebrow text-[10px] text-ash">Americas Threat Board</span>
        <div className="ml-auto">
          {user
            ? <a href="/" className="text-sm text-ash hover:text-brassbright transition-colors">Open the hall →</a>
            : (
              <button onClick={login} className="text-sm text-ash hover:text-brassbright transition-colors">
                Sign in
              </button>
            )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export default function ThreatBoard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [msg, flash] = useFlash();

  const [q, setQ] = useState('');
  const [cluster, setCluster] = useState('all');
  const [view, setView] = useState('board');
  const [hideDead, setHideDead] = useState(true);
  const [picking, setPicking] = useState(null);
  const [editing, setEditing] = useState(null);

  // The server's answer, not a local guess: it is the one that also decides
  // whether the write endpoints will accept anything. `stale` means the board
  // is being served from the shipped seed because the table is empty or the
  // database is unreachable — readable, but nothing on it can be saved.
  const canEdit = !!data?.canEdit && !data?.stale;

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/threat-board');
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load the threat board.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Escape cancels a half-finished pairing — the mode changes what a click
  // means, so there has to be an obvious way out of it.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e) => { if (e.key === 'Escape') setPicking(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picking]);

  const allies = data?.allies || {};
  const partnerOf = useCallback((id) => allies[id] || null, [allies]);
  // Ids are what the data is keyed by; names are what people read. These two
  // are the only bridge between them, so the rest of the page stays on ids.
  const nameOf = useCallback(
    (id) => data?.guilds.find((g) => g.id === id)?.name || null,
    [data],
  );
  const partnerName = useCallback((id) => nameOf(partnerOf(id)), [nameOf, partnerOf]);

  const pairCount = useMemo(() => Object.keys(allies).length / 2, [allies]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const serversOf = (label) => data.clusters.find((c) => c.label === label)?.servers || '';
    return data.guilds.filter((g) => {
      if (hideDead && g.status === DEAD) return false;
      if (cluster !== 'all' && g.cluster !== cluster) return false;
      if (needle && !g.name.toLowerCase().includes(needle)
        && !serversOf(g.cluster).toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, q, cluster, hideDead]);

  // `picking` holds the guild itself, not an id, so the bar can name it and the
  // chips can compare identity without a second lookup.
  async function pick(guild) {
    if (!picking) { setPicking(guild); return; }
    if (picking.id === guild.id) { setPicking(null); return; }
    const first = picking;
    setPicking(null);
    try {
      const res = await axios.post('/api/threat-board/ally', { a: first.id, b: guild.id });
      await load();
      // The server answers with the names it freed, since ids mean nothing to
      // whoever is reading the message.
      const freed = res.data.freed || [];
      const names = freed.map((id) => nameOf(id)).filter(Boolean);
      flash(names.length
        ? `${first.name} and ${guild.name} are allied. Released ${names.join(' and ')}.`
        : `${first.name} and ${guild.name} are allied.`);
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to save the alliance.', false);
    }
  }

  async function breakAlly(guild) {
    try {
      const res = await axios.delete(`/api/threat-board/ally/${guild.id}`);
      await load();
      flash(res.data.partner
        ? `${guild.name} and ${res.data.partner} are no longer allied.`
        : 'No alliance to break.');
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to break the alliance.', false);
    }
  }

  if (loading) {
    return <PublicShell><PageShell maxWidth="max-w-[1600px]"><EmptyState>Reading the board…</EmptyState></PageShell></PublicShell>;
  }
  if (error) {
    return <PublicShell><PageShell maxWidth="max-w-[1600px]"><EmptyState>{error}</EmptyState></PageShell></PublicShell>;
  }

  const totals = {};
  for (const g of data.guilds) totals[g.status] = (totals[g.status] || 0) + 1;

  return (
    <PublicShell>
    <PageShell maxWidth="max-w-[1600px]">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <div className="eyebrow text-[10px] text-ash">Throne &amp; Liberty · Americas</div>
          <h1 className="font-display text-3xl text-bone tracking-tight mt-1">Threat Board</h1>
          <p className="text-ash text-sm mt-2 max-w-xl">
            Every guild on the five Americas clusters, rated by how much of a fight they put up.
            A guild holds one alliance at a time, so pairing two releases whoever they were bound to.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl text-brassbright tabular-nums">{pairCount}</div>
          <div className="eyebrow text-[10px] text-ash">
            {pairCount === 1 ? 'Alliance' : 'Alliances'} mapped
          </div>
        </div>
      </div>

      {/* Threat mix across the whole board */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        {STATUSES.map((s) => (
          <div key={s.key} className="panel rounded-lg px-3 py-2.5">
            <div className={`font-mono text-xl tabular-nums ${s.text}`}>{totals[s.key] || 0}</div>
            <div className="text-[10px] text-ash mt-0.5">{s.short}</div>
          </div>
        ))}
      </div>

      <div className="panel rounded-lg p-3 flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search guilds…" aria-label="Search guilds"
            className="w-full bg-hall border border-line rounded-lg pl-9 pr-3 py-2 text-sm text-bone focus:outline-none focus:border-brass"
          />
        </div>
        <select
          value={cluster} onChange={(e) => setCluster(e.target.value)} aria-label="Filter by cluster"
          className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass"
        >
          <option value="all">All clusters</option>
          {data.clusters.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
        </select>
        <Tabs
          items={[{ key: 'board', label: 'Board' }, { key: 'pairs', label: 'Alliances' }]}
          active={view} onChange={setView}
        />
        <label className="flex items-center gap-2 text-sm text-ash cursor-pointer select-none">
          <input type="checkbox" checked={hideDead} onChange={(e) => setHideDead(e.target.checked)} className="accent-brass" />
          Hide disbanded
        </label>
        <span className="ml-auto text-xs text-ash tabular-nums">{visible.length} of {data.guilds.length}</span>
      </div>

      {data.stale && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          Showing the board as last imported — live data is unavailable, so editing is off.
        </div>
      )}

      {msg && (
        <div className={`mb-3 text-sm ${msg.ok ? 'text-brassbright' : 'text-oxblood'}`}>{msg.text}</div>
      )}

      {canEdit && (
        <div className={`mb-4 rounded-lg border px-4 py-2.5 text-xs flex items-center gap-3 flex-wrap ${
          picking ? 'border-brass bg-panelup text-bone' : 'border-line bg-panel text-ash'
        }`}>
          {picking ? (
            <>
              <Link2 className="w-3.5 h-3.5 text-brass" />
              <span>Pairing <strong className="text-bone">{picking.name}</strong> — click its ally.</span>
              <Button variant="ghost" size="none" className="text-xs" onClick={() => setPicking(null)}>Cancel (Esc)</Button>
            </>
          ) : (
            <>
              <Link2 className="w-3.5 h-3.5" />
              <span>Click a guild, then click its ally to bond them.</span>
            </>
          )}
        </div>
      )}

      {view === 'board' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 items-start">
          {data.clusters
            .filter((c) => cluster === 'all' || cluster === c.label)
            .map((c) => {
              const mine = unitsFor(visible.filter((g) => g.cluster === c.label), partnerOf);
              const active = data.guilds.filter((g) => g.cluster === c.label && g.status !== DEAD);
              return (
                <section key={c.label} className="panel rounded-lg overflow-hidden">
                  <div className="px-3.5 pt-3.5 pb-3 bg-panelup border-b border-line">
                    <div className="font-display text-bone text-[15px] tracking-[0.06em]">{c.label}</div>
                    <div className="text-[11px] text-ash mt-1 leading-snug">{c.servers}</div>
                    {/* Composition of the cluster, not of the filtered view */}
                    <div className="flex h-1 rounded-full overflow-hidden bg-line mt-2.5" title={`${active.length} active guilds`}>
                      {STATUSES.filter((s) => s.key !== DEAD).map((s) => {
                        const n = active.filter((g) => g.status === s.key).length;
                        return n ? <span key={s.key} className={s.dot} style={{ flex: n }} /> : null;
                      })}
                    </div>
                  </div>
                  {/* gap-2.5 between units, gap-px inside a pair: the pair reads
                      as one block and every unit gets room around it. */}
                  <div className="p-2 flex flex-col gap-2.5">
                    {mine.length === 0 && <div className="px-2 py-4 text-xs text-ash italic">No guilds match.</div>}
                    {mine.map((unit) => (
                      unit.length === 2 ? (
                        <div key={unit[0].id} className="flex flex-col gap-px border-l-2 border-bone rounded-l-sm pl-0.5">
                          {unit.map((g) => (
                            <GuildChip
                              key={g.id} guild={g} partner={null}
                              picking={picking === g.id} canEdit={canEdit} onPick={pick} onEdit={setEditing}
                            />
                          ))}
                        </div>
                      ) : (
                        <GuildChip
                          key={unit[0].id} guild={unit[0]} partner={partnerName(unit[0].id)}
                          picking={picking === unit[0].id} canEdit={canEdit} onPick={pick} onEdit={setEditing}
                        />
                      )
                    ))}
                  </div>
                </section>
              );
            })}
        </div>
      ) : (
        <AllianceList
          data={data} allies={allies} q={q} cluster={cluster}
          canEdit={canEdit} onBreak={breakAlly}
        />
      )}

      <div className="panel rounded-lg p-4 mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="eyebrow text-[10px] text-ash w-full">Threat — strongest first</div>
        {STATUSES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-2 text-xs text-ash">
            <span className={`w-4 h-2.5 rounded-sm ${s.dot}`} />{s.short}
          </span>
        ))}
        <div className="eyebrow text-[10px] text-ash w-full mt-1">Bonds</div>
        <span className="inline-flex items-center gap-2 text-xs text-ash">
          <span className="w-1 h-3.5 rounded-sm bg-bone" />⇄ Allied — one partner per guild, listed below the crown
        </span>
      </div>

      <p className="text-xs text-ash mt-4">
        <Crown className="w-3 h-3 inline text-brass" /> marks the guild holding each cluster; it leads its column.
        Ratings are imported from the{' '}
        <a href={data.source} target="_blank" rel="noopener noreferrer" className="text-brass hover:text-brassbright">
          community threat spreadsheet
        </a>{' '}
        (seeded {data.importedAt}) and maintained since by Guild Hall staff.
      </p>

      {editing && (
        <GuildEditor
          guild={editing} data={data} flash={flash}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </PageShell>
    </PublicShell>
  );
}

// Every mapped pair, strongest first — the direct answer to "who fights
// alongside whom", and where a Threat bonded to another Threat stands out.
function AllianceList({ data, allies, q, cluster, canEdit, onBreak }) {
  const rows = useMemo(() => {
    const byId = new Map(data.guilds.map((g) => [g.id, g]));
    const seen = new Set();
    const out = [];
    for (const [a, b] of Object.entries(allies)) {
      if (seen.has(a) || seen.has(b)) continue;
      seen.add(a); seen.add(b);
      const ga = byId.get(a); const gb = byId.get(b);
      if (!ga || !gb) continue;
      out.push(RANK[ga.status] <= RANK[gb.status] ? [ga, gb] : [gb, ga]);
    }
    const needle = q.trim().toLowerCase();
    return out
      .filter(([x, y]) => (cluster === 'all' || x.cluster === cluster || y.cluster === cluster)
        && (!needle || x.name.toLowerCase().includes(needle) || y.name.toLowerCase().includes(needle)))
      .sort(([x], [y]) => byStrength(x, y));
  }, [data, allies, q, cluster]);

  if (!rows.length) {
    return (
      <EmptyState>
        No alliances mapped yet.{canEdit ? ' On the Board, click a guild and then click its ally.' : ''}
      </EmptyState>
    );
  }

  const Cell = ({ g }) => (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${META[g.status].tint} ${META[g.status].text}`}>
      {META[g.status].short}
    </span>
  );

  return (
    <div className="panel rounded-lg overflow-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead className="border-b border-line">
          <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">
            <th className="p-4 font-normal text-left">Guild</th>
            <th className="p-4 font-normal text-left">Threat</th>
            <th className="p-4 font-normal w-10" />
            <th className="p-4 font-normal text-left">Allied with</th>
            <th className="p-4 font-normal text-left">Threat</th>
            <th className="p-4 font-normal text-left">Cluster</th>
            {canEdit && <th className="p-4 font-normal w-12" />}
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a.id} className="border-b border-line/60 hover:bg-panelup transition-colors">
              <td className="p-4 text-bone">
                {a.name}{a.king && <Crown className="w-3 h-3 inline ml-1 text-brass" />}
              </td>
              <td className="p-4"><Cell g={a} /></td>
              <td className="p-4 text-center text-bone">⇄</td>
              <td className="p-4 text-bone">
                {b.name}{b.king && <Crown className="w-3 h-3 inline ml-1 text-brass" />}
              </td>
              <td className="p-4"><Cell g={b} /></td>
              <td className="p-4 text-ash text-xs">
                {a.cluster}
                {a.cluster !== b.cluster && (
                  <span className="ml-1.5 px-1.5 py-px rounded border border-amber-500/40 text-amber-300 text-[10px]">
                    ↔ {b.cluster}
                  </span>
                )}
              </td>
              {canEdit && (
                <td className="p-4">
                  <button
                    type="button" onClick={() => onBreak(a)}
                    title={`Break the alliance between ${a.name} and ${b.name}`}
                    aria-label={`Break the alliance between ${a.name} and ${b.name}`}
                    className="text-ash hover:text-oxblood transition-colors"
                  >
                    <Link2Off className="w-4 h-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
