import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Users, Shield, Swords, Heart, CalendarDays, Clock, Package } from 'lucide-react';
import { GUILD } from '../guild';
import { fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight } from '../timeUtils';
import ErrorState from '../components/ui/ErrorState';
import StatTile from '../components/ui/StatTile';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';

// Pure calendar-date arithmetic, anchored to UTC throughout so it's immune to
// the viewer's own browser timezone (see the LOA fmtTime bug this app used to
// have) — only todayInGuildTz() needs to know about the guild's real timezone.
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Walks forward by guild night, not calendar day, so the 12:30am event shows
// as the tail of the night it belongs to instead of that morning's first item.
// `date` stays the calendar date the event actually occurs on, which is what
// the countdown has to tick against — a night's 12:30am event is on the day
// after the night itself.
function nextOccurrences(schedule, todayStr, count = 3) {
  const out = [];
  for (let i = 0; i < 14 && out.length < count; i++) {
    const nightStr = addDaysToDateStr(todayStr, i);
    const dow = new Date(nightStr + 'T12:00:00').getDay();
    eventsForGuildDay(schedule, dow).forEach((s) => out.push({
      ...s,
      date: isAfterMidnight(s.event_time) ? addDaysToDateStr(nightStr, 1) : nightStr,
    }));
  }
  return out.slice(0, count);
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'Up now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Home() {
  const [stats, setStats] = useState({});
  const [recentMatches, setRecentMatches] = useState([]);
  const [wdl, setWdl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [latestMembers, setLatestMembers] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [eliteTimers, setEliteTimers] = useState([]);
  const [eliteLocations, setEliteLocations] = useState([]);
  const [topWishlist, setTopWishlist] = useState([]);
  const [now, setNow] = useState(() => Date.now());

  const fetchData = async () => {
    setLoading(true);
    setError(false);
    try {
      const [statsRes, matchesRes, last10Res] = await Promise.all([
        axios.get('/api/stats/summary'),
        axios.get('/api/matches/recent?limit=6'),
        axios.get('/api/matches/recent?limit=20'),
      ]);
      setStats(statsRes.data);
      setRecentMatches(matchesRes.data);
      const last10 = last10Res.data || [];
      const w = last10.filter((m) => m.result === 'Win').length;
      const d = last10.filter((m) => m.result === 'Draw').length;
      const l = last10.filter((m) => m.result === 'Loss').length;
      if (w + d + l > 0) setWdl({ w, d, l });
    } catch (err) {
      console.error(err);
      setError(true);
    } finally {
      setLoading(false);
    }

    // Supplementary dashboard panels — each fails independently so one bad
    // endpoint doesn't take down the whole page.
    axios.get('/api/members').then((res) => {
      const withDate = (res.data.members || []).filter((m) => m.joinedAt);
      withDate.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
      setLatestMembers(withDate.slice(0, 4));
    }).catch(() => {});

    axios.get('/api/event-schedule').then((res) => {
      setUpcoming(nextOccurrences(res.data.schedule || [], todayInGuildTz()));
    }).catch(() => {});

    axios.get('/api/elite-timers').then((res) => {
      setEliteTimers(res.data.timers || []);
      setEliteLocations(res.data.locations || []);
    }).catch(() => {});

    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/loot')]).then(([catRes, lootRes]) => {
      const itemByKey = Object.fromEntries(
        (catRes.data.categories || []).flatMap((c) => c.items.map((i) => [i.key, i]))
      );
      const counts = lootRes.data.counts || {};
      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([key, count]) => ({ item: itemByKey[key], count }))
        .filter((row) => row.item);
      setTopWishlist(top);
    }).catch(() => {});
  };

  useEffect(() => { fetchData(); }, []);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const ledger = [
    { label: 'Active Members', value: stats.activeMembers ?? '—', icon: <Users className="w-4 h-4" /> },
    { label: 'Tanks',          value: stats.tanks ?? '—',         icon: <Shield className="w-4 h-4" /> },
    { label: 'DPS',            value: stats.dps ?? '—',           icon: <Swords className="w-4 h-4" /> },
    { label: 'Healers',        value: stats.healers ?? '—',       icon: <Heart className="w-4 h-4" /> },
  ];

  const eliteByLocation = Object.fromEntries(eliteTimers.map((t) => [t.location, t]));

  return (
    <div>
      {/* ── BANNER HERO ─────────────────────────────────────────── */}
      <section className="border-b border-line">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-16 flex flex-col items-center text-center">
          <div className="rise rise-1 eyebrow text-brass text-[11px] mb-5">
            Throne &amp; Liberty
          </div>
          <h1 className="rise rise-1 font-display font-bold text-bone text-5xl md:text-7xl tracking-[0.08em] leading-tight">
            {GUILD.house}
          </h1>
        </div>
      </section>

      {error ? (
        <div className="max-w-6xl mx-auto px-6 py-16">
          <ErrorState
            title="The record is sealed"
            message="The standing could not be read from the records. The hall may be offline — try again."
            onRetry={fetchData}
          />
        </div>
      ) : (
        <>
          {/* ── STANDING OF THE HOUSE ─────────────────────────────── */}
          <section className="border-b border-line bg-hall">
            <div className="max-w-6xl mx-auto px-6 py-10">
              <div className="eyebrow text-ash text-[11px] text-center mb-7">
                Standing of the House
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {ledger.map((item) => (
                  <StatTile key={item.label} icon={item.icon} value={loading ? '·' : item.value} label={item.label} />
                ))}
              </div>
            </div>
          </section>

          <section className="max-w-6xl mx-auto px-6 py-16 space-y-6">
            {/* ── WAR RECORD + UPCOMING EVENTS ───────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="panel rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                  <div className="flex items-baseline gap-3">
                    <h2 className="font-display text-lg text-bone tracking-[0.08em]">War Record</h2>
                    {wdl && (
                      <span className="text-xs text-ash font-mono">
                        Last 20: <span className="text-emerald-400">{wdl.w}</span>/<span className="text-amber-400">{wdl.d}</span>/<span className="text-oxblood">{wdl.l}</span>
                      </span>
                    )}
                  </div>
                  <Link to="/war-record" className="text-xs text-brass hover:text-brassbright transition-colors shrink-0">
                    Full record →
                  </Link>
                </div>
                {loading ? (
                  <div className="py-14 text-center text-ash text-sm">Reading the record…</div>
                ) : recentMatches.length === 0 ? (
                  <div className="py-14 text-center text-ash text-sm">No engagements logged yet.</div>
                ) : (
                  <div className="divide-y divide-line">
                    {recentMatches.slice(0, 3).map((m) => (
                      <EngagementRow key={m.id} match={m} />
                    ))}
                  </div>
                )}
              </div>

              <div className="panel rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                  <h2 className="font-display text-lg text-bone tracking-[0.08em] flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-brass" /> Upcoming Events
                  </h2>
                </div>
                {upcoming.length === 0 ? (
                  <div className="py-14 text-center text-ash text-sm">Nothing scheduled.</div>
                ) : (
                  <div className="divide-y divide-line">
                    {upcoming.map((ev, i) => (
                      <div key={i} className="flex items-center justify-between px-5 py-3">
                        <span className="text-sm text-bone truncate">{ev.name}</span>
                        <span className="text-xs text-ash font-mono shrink-0 ml-3">
                          {new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {ev.event_time ? ` · ${fmtTimeEst(ev.event_time)}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── LATEST MEMBERS / ELITE TIMERS / TOP WISHLISTED ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="panel rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-line">
                  <h2 className="font-display text-base text-bone tracking-[0.06em] flex items-center gap-2">
                    <Users className="w-4 h-4 text-brass" /> Latest Members
                  </h2>
                </div>
                {latestMembers.length === 0 ? (
                  <div className="py-10 text-center text-ash text-sm">No new members yet.</div>
                ) : (
                  <div className="divide-y divide-line">
                    {latestMembers.map((m) => (
                      <div key={m.id} className="flex items-center justify-between px-5 py-3">
                        <span className="text-sm text-bone truncate">{m.name}</span>
                        {m.pvp_role && (
                          <span className={`text-xs font-semibold shrink-0 ml-3 ${
                            m.pvp_role === 'Tank' ? 'text-sky-400' : m.pvp_role === 'Healer' ? 'text-emerald-400' : 'text-oxblood'
                          }`}>
                            {m.pvp_role}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="panel rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-line">
                  <h2 className="font-display text-base text-bone tracking-[0.06em] flex items-center gap-2">
                    <Clock className="w-4 h-4 text-brass" /> Elite Timers
                  </h2>
                </div>
                {eliteLocations.length === 0 ? (
                  <div className="py-10 text-center text-ash text-sm">No timers reported yet.</div>
                ) : (
                  <div className="divide-y divide-line">
                    {eliteLocations.slice(0, 4).map((loc) => {
                      const t = eliteByLocation[loc];
                      const remaining = t ? new Date(t.next_spawn_at).getTime() - now : null;
                      const urgent = remaining !== null && remaining > 0 && remaining < 10 * 60 * 1000;
                      const up = remaining !== null && remaining <= 0;
                      return (
                        <div key={loc} className="flex items-center justify-between px-5 py-3">
                          <span className="text-sm text-bone truncate">{loc}</span>
                          {t ? (
                            <span className={`text-xs font-mono shrink-0 ml-3 ${up ? 'text-emerald-400' : urgent ? 'text-oxblood' : 'text-brassbright'}`}>
                              {fmtCountdown(remaining)}
                            </span>
                          ) : (
                            <span className="text-xs font-mono text-ash/40 shrink-0 ml-3">—</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="panel rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                  <h2 className="font-display text-base text-bone tracking-[0.06em] flex items-center gap-2">
                    <Package className="w-4 h-4 text-brass" /> Top Wishlisted
                  </h2>
                  <Link to="/loot" className="text-xs text-brass hover:text-brassbright transition-colors shrink-0">
                    View all →
                  </Link>
                </div>
                {topWishlist.length === 0 ? (
                  <div className="py-10 text-center text-ash text-sm">Nothing wishlisted yet.</div>
                ) : (
                  <div className="divide-y divide-line">
                    {topWishlist.map(({ item, count }) => (
                      <div key={item.key} className="flex items-center justify-between px-5 py-3 gap-3">
                        <ItemTooltip item={item}>
                          <span className={`text-sm truncate ${gradeStyle(item.grade)?.color || 'text-bone'}`}>{item.name}</span>
                        </ItemTooltip>
                        <span className="text-xs font-mono text-ash shrink-0">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function EngagementRow({ match }) {
  const result = match.result;
  // Older rows carry whatever name we fought under at the time, so match
  // against every alias rather than just the current tag.
  const held = result ? result === 'Win' : GUILD.aliases.includes(match.winningGuild);
  const decided = result ? result !== 'Draw' : match.killDifference > 0;

  const date = match.match_date
    ? new Date(match.match_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';

  return (
    <Link
      to={`/war-record?match=${match.id}`}
      className="group flex items-center gap-4 px-5 py-3 hover:bg-panelup transition-colors"
    >
      <div className="w-14 shrink-0 font-mono text-xs text-ash">{date}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-bone truncate group-hover:text-brassbright transition-colors">
          {match.title || 'Wargame engagement'}
        </div>
      </div>
      <div className="shrink-0 text-right">
        {decided ? (
          <span className={`text-xs font-semibold ${held ? 'text-emerald-400' : 'text-oxblood'}`}>
            {held ? 'Held' : 'Lost'}
          </span>
        ) : (
          <span className="text-xs font-semibold text-amber-400">Contested</span>
        )}
      </div>
    </Link>
  );
}
