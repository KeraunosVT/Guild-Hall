import { Sword, Target, Heart, Users, ShieldAlert, Pencil, Trash2, Share2, Map as MapIcon } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import weaponToClass from '../../../shared/weaponClasses.json';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { PageShell } from '../components/ui/PageShell';
import { Table, Thead, Tr } from '../components/ui/Table';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

function getClassName(weapon1, weapon2) {
  if (!weapon1) return 'Unknown';
  const w1 = weapon1.trim();
  const w2 = weapon2 ? weapon2.trim() : '';
  let key = (w1 + w2).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];
  key = (w2 + w1).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];
  return `${w1} ${w2}`.trim();
}

export default function MatchStats() {
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [matches, setMatches] = useState([]);
  const [selectedMatchId, setSelectedMatchId] = useState(null);
  const [matchDetail, setMatchDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [mapStats, setMapStats] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [msg, flash] = useFlash();

  const loadMatches = () => {
    setLoading(true);
    setListError(false);
    axios.get('/api/matches/recent?limit=500')
      .then(res => {
        setMatches(res.data);
        const fromUrl = searchParams.get('match');
        setSelectedMatchId(fromUrl || (res.data.length > 0 ? res.data[0].id : null));
      })
      .catch(err => { console.error(err); setListError(true); })
      .finally(() => setLoading(false));
  };

  const loadDetail = (matchId) => {
    if (!matchId) return;
    setMatchDetail(null);
    setDetailError(false);
    axios.get(`/api/match/${matchId}`)
      .then(res => setMatchDetail(res.data))
      .catch(err => { console.error(err); setDetailError(true); });
  };

  useEffect(() => { loadMatches(); }, []);
  useEffect(() => { loadDetail(selectedMatchId); }, [selectedMatchId]);
  useEffect(() => { loadMapStats(); }, []);

  const loadMapStats = () => {
    axios.get('/api/maps/stats').then((res) => setMapStats(res.data.stats || [])).catch(() => {});
  };

  const selectedMatch = matchDetail?.match;
  const players = matchDetail?.players || [];
  const classBreakdown = matchDetail?.classBreakdown || [];
  const teamStats = matchDetail?.teamStats || {};

  // Deep link to the selected match. Built from the canonical route and the id
  // rather than window.location, because picking a match from the dropdown
  // doesn't push a URL — the address bar still says whatever you arrived on.
  // The page already reads ?match= on load, so the link needs nothing new.
  const shareMatch = async () => {
    if (!selectedMatch) return;
    const url = `${window.location.origin}/war-record?match=${selectedMatch.id}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Link copied — paste it anywhere.');
    } catch {
      // The clipboard API needs a secure context and permission; if either is
      // missing, show the link so it can still be copied by hand.
      window.prompt('Copy this link:', url);
    }
  };

  // Admin-only, and irreversible: the player rows go with it via ON DELETE
  // CASCADE, which also moves every one of those players' all-time totals — so
  // the confirm names the match and says how many records go with it.
  const deleteMatch = async () => {
    if (!selectedMatch || deleting) return;
    const label = selectedMatch.title || 'this match';
    const ok = window.confirm(
      `Delete "${label}"?\n\nThis removes ${players.length} player record${players.length === 1 ? '' : 's'} and adjusts their all-time war stats. This cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await axios.delete(`/api/admin/match/${selectedMatch.id}`);
      // Drop it locally and land on whatever took its place, rather than
      // refetching and selecting an id the server no longer has.
      const idx = matches.findIndex((m) => m.id === selectedMatch.id);
      const remaining = matches.filter((m) => m.id !== selectedMatch.id);
      setMatches(remaining);
      setMatchDetail(null);
      setSelectedMatchId(remaining.length ? remaining[Math.min(idx, remaining.length - 1)].id : null);
      // A ?match= pointing at the deleted record would 404 on refresh.
      if (searchParams.get('match')) setSearchParams({});
      loadMapStats(); // map win/loss totals just changed
      flash(`Deleted "${label}".`);
    } catch (err) {
      flash(err.response?.data?.error || 'Delete failed.', false);
    } finally {
      setDeleting(false);
    }
  };

  const topKills = [...players].sort((a, b) => (b.kills || 0) - (a.kills || 0)).slice(0, 10);
  const topDamage = [...players].sort((a, b) => (b.damage_dealt || 0) - (a.damage_dealt || 0)).slice(0, 10);
  const topDamageTaken = [...players].sort((a, b) => (b.damage_taken || 0) - (a.damage_taken || 0)).slice(0, 10);
  const topHealing = [...players].sort((a, b) => (b.healing || 0) - (a.healing || 0)).slice(0, 10);

  return (
    <PageShell maxWidth="max-w-7xl">
      <Toast msg={msg} />

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <label className="eyebrow text-[10px] text-ash shrink-0" htmlFor="engagement-select">Select engagement</label>
        <select
          id="engagement-select"
          value={selectedMatchId || ''}
          onChange={(e) => setSelectedMatchId(e.target.value)}
          className="w-full md:w-96 bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass transition-colors"
        >
          <option value="">— choose —</option>
          {matches.map(m => (
            <option key={m.id} value={m.id}>
              {new Date(m.match_date + 'T12:00:00').toLocaleDateString()} — {m.title}{m.map ? ` (${m.map})` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Per-map win record */}
      {mapStats.length > 0 && (
        <div className="mb-8">
          <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-3 flex items-center gap-3">
            <MapIcon className="w-5 h-5 text-brass" /> Map Record
          </h3>
          <Table minWidth="min-w-[480px]">
            <Thead>
              <th className="text-left p-2.5 font-normal">Map</th>
              <th className="text-center p-2.5 font-normal">Played</th>
              <th className="text-center p-2.5 font-normal">Wins</th>
              <th className="text-center p-2.5 font-normal">Losses</th>
              <th className="text-center p-2.5 font-normal">Draws</th>
              <th className="text-center p-2.5 font-normal">Win %</th>
            </Thead>
            <tbody className="font-mono">
              {mapStats.map((s) => (
                <tr key={s.map} className="border-b border-line/60 last:border-0">
                  <td className="p-2.5 font-sans font-medium text-brassbright">{s.map}</td>
                  <td className="p-2.5 text-center text-bone">{s.played}</td>
                  <td className="p-2.5 text-center text-emerald-400">{s.wins}</td>
                  <td className="p-2.5 text-center text-oxblood">{s.losses}</td>
                  <td className="p-2.5 text-center text-ash">{s.draws}</td>
                  <td className="p-2.5 text-center text-brassbright">{s.winPct}%</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {/* List failure */}
      {listError && (
        <ErrorState
          onRetry={loadMatches}
          title="The record could not be summoned"
          message="The hall may be offline. Try again."
        />
      )}

      {/* Detail failure */}
      {detailError && !listError && (
        <ErrorState
          onRetry={() => loadDetail(selectedMatchId)}
          title="This engagement could not be read"
          message="Something went wrong fetching the details."
        />
      )}

      {/* Loading the chosen engagement */}
      {selectedMatchId && !matchDetail && !detailError && !listError && (
        <EmptyState>Unrolling the scroll…</EmptyState>
      )}

      {/* Empty */}
      {!loading && !listError && matches.length === 0 && (
        <EmptyState>No engagements logged yet. The field awaits.</EmptyState>
      )}

      {selectedMatch && !detailError && (
        <>
          <div className="flex items-center gap-4 mb-1">
            <h2 className="font-display text-3xl text-brassbright tracking-[0.06em]">{selectedMatch.title}</h2>
            {selectedMatch.result && (
              <span className={`px-3 py-1 rounded-lg text-sm font-semibold tracking-wide ${
                selectedMatch.result === 'Win' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
                selectedMatch.result === 'Loss' ? 'bg-oxblooddeep/30 text-oxblood border border-oxblood/50' :
                'bg-amber-500/15 text-amber-400 border border-amber-500/40'
              }`}>
                {selectedMatch.result === 'Win' ? 'Held The Field' :
                 selectedMatch.result === 'Loss' ? 'Lost The Field' :
                 'Contested Field'}
              </span>
            )}
            {selectedMatch.map && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm text-ash border border-line">
                <MapIcon className="w-3.5 h-3.5" /> {selectedMatch.map}
              </span>
            )}
            <button
              onClick={shareMatch}
              className="inline-flex items-center gap-1.5 text-sm text-ash hover:text-brass transition-colors"
              title="Copy a link straight to this match"
            >
              <Share2 className="w-4 h-4" /> Share
            </button>
            {can('match') && (
              <>
                <Link
                  to={`/admin?edit=${selectedMatch.id}`}
                  className="inline-flex items-center gap-1.5 text-sm text-ash hover:text-brass transition-colors"
                  title="Edit this match"
                >
                  <Pencil className="w-4 h-4" /> Edit
                </Link>
                <button
                  onClick={deleteMatch} disabled={deleting}
                  className="inline-flex items-center gap-1.5 text-sm text-ash hover:text-oxblood transition-colors disabled:opacity-40"
                  title="Delete this match and its player records"
                >
                  <Trash2 className="w-4 h-4" /> {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </>
            )}
          </div>
          <p className="text-ash mb-6">
            {new Date(selectedMatch.match_date + 'T12:00:00').toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
            })}
          </p>

          {/* Team cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <TeamStatCard color="Red" stats={teamStats.Red || {}} />
            <TeamStatCard color="Yellow" stats={teamStats.Yellow || {}} />
          </div>

          {/* Differentials */}
          <DifferentialCard red={teamStats.Red || {}} yellow={teamStats.Yellow || {}} />

          {/* Top 10 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <Top10Card title="Most Kills" icon={<Sword className="w-4 h-4" />} data={topKills} field="kills" />
            <Top10Card title="Damage Dealt" icon={<Target className="w-4 h-4" />} data={topDamage} field="damage_dealt" unit="M" />
            <Top10Card title="Damage Taken" icon={<ShieldAlert className="w-4 h-4" />} data={topDamageTaken} field="damage_taken" unit="M" />
            <Top10Card title="Healing" icon={<Heart className="w-4 h-4" />} data={topHealing} field="healing" unit="M" />
          </div>

          {/* Class distribution */}
          <div className="mb-8">
            <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-3 flex items-center gap-3">
              <Users className="w-5 h-5 text-brass" /> Fielded Classes
            </h3>
            <div className="panel rounded-lg p-5">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
                {classBreakdown.length > 0 ? classBreakdown.map((item, i) => {
                  const total = classBreakdown.reduce((a, b) => a + b.count, 0);
                  return (
                    <div key={i} className="flex justify-between items-center bg-hall border border-line rounded-lg px-3 py-2">
                      <span className="font-medium text-brassbright">{item.name}</span>
                      <div className="text-right font-mono">
                        <span className="text-bone">{item.count}</span>
                        <span className="text-xs text-ash ml-2">
                          {((item.count / total) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  );
                }) : (
                  <p className="col-span-full text-center py-8 text-ash">No class data recorded.</p>
                )}
              </div>
            </div>
          </div>

          {/* Full roster */}
          <div>
            <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-3 flex items-center gap-3">
              <Sword className="w-5 h-5 text-brass" /> Full Roster
            </h3>
            <Table maxHeight="max-h-[620px]" minWidth="min-w-[900px]">
              <Thead sticky>
                <th className="text-left p-2.5 font-normal">Rank</th>
                <th className="text-left p-2.5 font-normal">Class</th>
                <th className="text-left p-2.5 font-normal">Guild</th>
                <th className="text-left p-2.5 font-normal">Player</th>
                <th className="text-center p-2.5 font-normal">Kills</th>
                <th className="text-center p-2.5 font-normal">Assists</th>
                <th className="text-center p-2.5 font-normal">Dmg Dealt</th>
                <th className="text-center p-2.5 font-normal">Dmg Taken</th>
                <th className="text-center p-2.5 font-normal">Healing</th>
              </Thead>
              <tbody className="font-mono">
                {players.map((p, i) => (
                  <Tr key={i}>
                    <td className="p-2.5 text-brass">{p.rank}</td>
                    <td className="p-2.5 font-sans font-medium text-brassbright">{getClassName(p.weapon_1, p.weapon_2)}</td>
                    <td className="p-2.5 font-sans text-ash">{p.guild_name}</td>
                    <td className="p-2.5 font-sans font-semibold text-bone">{p.player_name}</td>
                    <td className="p-2.5 text-center text-brassbright">{p.kills || 0}</td>
                    <td className="p-2.5 text-center text-bone">{p.assists || 0}</td>
                    <td className="p-2.5 text-center text-bone">{((p.damage_dealt || 0) / 1e6).toFixed(1)}M</td>
                    <td className="p-2.5 text-center text-bone">{((p.damage_taken || 0) / 1e6).toFixed(1)}M</td>
                    <td className="p-2.5 text-center text-bone">{((p.healing || 0) / 1e6).toFixed(1)}M</td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </PageShell>
  );
}

/* ── sub-components ───────────────────────────────────────────── */

function TeamStatCard({ color, stats }) {
  const isRed = color === 'Red';
  const name = stats.guildName || `${color} Team`;
  return (
    <div className={`rounded-lg p-5 border ${isRed ? 'border-oxblood/50 bg-oxblooddeep/20' : 'border-brass/40 bg-panel'}`}>
      <div className="mb-4 text-center">
        <div className={`eyebrow text-[10px] mb-2 ${isRed ? 'text-oxblood' : 'text-brass'}`}>
          {color} Team
        </div>
        <div className={`font-display text-xl tracking-[0.08em] ${isRed ? 'text-oxblood' : 'text-brassbright'}`}>
          {name}
        </div>
      </div>
      <div className="space-y-2.5 font-mono">
        <Row label="Kills" value={(stats.kills || 0).toLocaleString()} />
        <Row label="Damage Dealt" value={((stats.damage_dealt || 0) / 1e6).toFixed(1) + 'M'} />
        <Row label="Damage Taken" value={((stats.damage_taken || 0) / 1e6).toFixed(1) + 'M'} />
        <Row label="Healing" value={((stats.healing || 0) / 1e6).toFixed(1) + 'M'} />
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="font-sans text-ash text-sm">{label}</span>
      <span className="text-bone">{value}</span>
    </div>
  );
}

function Top10Card({ title, icon, data, field, unit = '' }) {
  return (
    <div className="panel rounded-lg p-5">
      <div className="flex items-center gap-2 text-brass mb-3">
        {icon}
        <h4 className="eyebrow text-[10px] text-bone">{title}</h4>
      </div>
      <div className="space-y-2 text-sm font-mono">
        {data.length > 0 ? data.map((p, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span className="font-sans text-ash truncate">
              <span className="text-brass/60 mr-2">{i + 1}</span>{p.player_name}
            </span>
            <span className="text-brassbright shrink-0">
              {unit ? ((p[field] || 0) / 1e6).toFixed(1) + unit : (p[field] || 0)}
            </span>
          </div>
        )) : (
          <p className="text-ash text-center py-4 font-sans">—</p>
        )}
      </div>
    </div>
  );
}

function DifferentialCard({ red, yellow }) {
  const stats = [
    { label: 'Kills', r: red.kills || 0, y: yellow.kills || 0, fmt: (v) => v.toLocaleString() },
    { label: 'Damage Dealt', r: red.damage_dealt || 0, y: yellow.damage_dealt || 0, fmt: (v) => (v / 1e6).toFixed(1) + 'M' },
    { label: 'Damage Taken', r: red.damage_taken || 0, y: yellow.damage_taken || 0, fmt: (v) => (v / 1e6).toFixed(1) + 'M' },
    { label: 'Healing', r: red.healing || 0, y: yellow.healing || 0, fmt: (v) => (v / 1e6).toFixed(1) + 'M' },
  ];

  return (
    <div className="panel rounded-lg p-5 mb-8">
      <h3 className="eyebrow text-[10px] text-brass mb-3 text-center">Differentials</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map((s) => {
          const diff = s.r - s.y;
          const redWins = diff > 0;
          const even = diff === 0;
          return (
            <div key={s.label} className="text-center">
              <div className="eyebrow text-[10px] text-ash mb-2">{s.label}</div>
              <div className="flex items-center justify-center gap-3 font-mono">
                <span className={`text-sm ${redWins ? 'text-oxblood font-semibold' : 'text-ash'}`}>{s.fmt(s.r)}</span>
                <span className="text-ash/40">vs</span>
                <span className={`text-sm ${!redWins && !even ? 'text-brassbright font-semibold' : 'text-ash'}`}>{s.fmt(s.y)}</span>
              </div>
              <div className={`font-mono text-xs mt-1 ${even ? 'text-ash/50' : redWins ? 'text-oxblood' : 'text-brassbright'}`}>
                {even ? '—' : `${redWins ? red.guildName || 'Red' : yellow.guildName || 'Yellow'} +${s.fmt(Math.abs(diff))}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
