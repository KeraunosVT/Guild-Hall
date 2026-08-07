import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import weaponToClass from '../../../shared/weaponClasses.json';
import { Check } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';

// Build variants that share a weapon pair with an existing class, so they have
// no entry of their own in weaponClasses.json — Wand/Orb and Wand/Longbow are
// both healer-leaning by default, and a member running one as DPS needs to be
// able to say so. Only the picker on this page offers these; Admin's class list
// stays keyed to real weapon combos, since it labels scoreboard rows.
const EXTRA_CLASSES = ['Oracle (DPS)', 'Seeker (DPS)'];
const CLASS_LIST = [...new Set([...Object.values(weaponToClass), ...EXTRA_CLASSES])].sort();
const RANK_LABELS = ['Primary', 'Secondary', 'Tertiary'];

function ClassPicker({ title, hint, picks, setPicks }) {
  const update = (i, value) => {
    setPicks((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  return (
    <div>
      <label className="eyebrow text-[10px] text-ash block mb-2">{title}</label>
      <div className="space-y-2">
        {RANK_LABELS.map((label, i) => {
          const taken = picks.filter((p, idx) => idx !== i && p);
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="text-ash text-xs w-20 shrink-0">{label}</span>
              <select value={picks[i] || ''} onChange={(e) => update(i, e.target.value)}
                className="w-full bg-hall border border-line rounded-lg px-4 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— not set —</option>
                {CLASS_LIST.filter((c) => !taken.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          );
        })}
      </div>
      <p className="text-ash text-xs mt-2">{hint}</p>
    </div>
  );
}

export default function Classes() {
  const { user } = useAuth();
  const [pvpClasses, setPvpClasses] = useState(['', '', '']);
  const [pveClasses, setPveClasses] = useState(['', '', '']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    axios.get('/api/my-classes')
      .then((res) => {
        const pad = (arr) => [arr?.[0] || '', arr?.[1] || '', arr?.[2] || ''];
        setPvpClasses(pad(res.data.pvp_classes));
        setPveClasses(pad(res.data.pve_classes));
      })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      await axios.put('/api/my-classes', {
        pvp_classes: pvpClasses.filter(Boolean),
        pve_classes: pveClasses.filter(Boolean),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    finally { setSaving(false); }
  };

  return (
    <PageShell maxWidth="max-w-2xl">
      <p className="text-sm text-ash mb-5">Rank up to 3 classes per mode so officers can plan parties around your build.</p>

      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <div className="space-y-8">
          <div className="panel rounded-lg p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <ClassPicker title="PvP Classes" hint="Ranked classes you run in wargames and PvP content."
                picks={pvpClasses} setPicks={setPvpClasses} />
              <ClassPicker title="PvE Classes" hint="Ranked classes you run in dungeons and PvE content."
                picks={pveClasses} setPicks={setPveClasses} />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Button size="none" className="px-6 py-3" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {saved && (
              <span className="text-emerald-400 inline-flex items-center gap-1 text-sm">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
