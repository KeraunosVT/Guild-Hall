import { useState, useEffect } from 'react';
import axios from 'axios';
import { Clock } from 'lucide-react';
import LOCATIONS from '../../../shared/eliteLocations.json';

const REFRESH_MS = 60 * 1000;

function fmtCountdown(ms) {
  if (ms <= 0) return 'Up now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export default function EliteTimerBar() {
  const [timers, setTimers] = useState([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () => {
      axios.get('/api/elite-timers').then((res) => setTimers(res.data.timers || [])).catch(() => {});
    };
    load();
    const refresh = setInterval(load, REFRESH_MS);
    return () => clearInterval(refresh);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const byLocation = Object.fromEntries(timers.map((t) => [t.location, t]));

  return (
    <div className="border-b border-line bg-panel/60">
      <div className="max-w-[1600px] mx-auto px-6 py-2 flex items-center justify-center gap-x-5 text-xs overflow-x-auto whitespace-nowrap">
        <span className="eyebrow text-[10px] text-brass flex items-center gap-1.5 shrink-0">
          <Clock className="w-3.5 h-3.5" /> Elites
        </span>
        {Object.keys(LOCATIONS).map((loc) => {
          const t = byLocation[loc];
          const remaining = t ? new Date(t.next_spawn_at).getTime() - now : null;
          const urgent = remaining !== null && remaining > 0 && remaining < 10 * 60 * 1000;
          const up = remaining !== null && remaining <= 0;
          return (
            <span key={loc} className="inline-flex items-center gap-1.5 shrink-0">
              <span className="text-ash">{loc}</span>
              {t ? (
                <span className={`font-mono ${up ? 'text-emerald-400' : urgent ? 'text-oxblood' : 'text-brassbright'}`}>
                  {fmtCountdown(remaining)}
                </span>
              ) : (
                <span className="font-mono text-ash/40">—</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
