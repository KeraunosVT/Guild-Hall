import { useState, useEffect } from 'react';
import axios from 'axios';
import { UploadCloud, Loader2, Check, Sword, Shield, Gem, BarChart3 } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import StatTile from '../components/ui/StatTile';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

export default function GearLevel() {
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();

  const load = () => {
    setLoading(true);
    axios.get('/api/gear-ilvl/mine')
      .then((res) => setEntry(res.data.entry))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const upload = (file) => {
    if (!file) return;
    setUploading(true); setError('');
    const form = new FormData();
    form.append('image', file);
    axios.post('/api/gear-ilvl', form)
      .then((res) => { setEntry(res.data.entry); flash('Gear level updated.'); })
      .catch((err) => setError(err.response?.data?.error || 'Could not read that screenshot.'))
      .finally(() => setUploading(false));
  };

  const cards = entry ? [
    { label: 'Weapon', value: entry.weapon, icon: <Sword className="w-4 h-4" /> },
    { label: 'Armor', value: entry.armor, icon: <Shield className="w-4 h-4" /> },
    { label: 'Accessory', value: entry.accessory, icon: <Gem className="w-4 h-4" /> },
    { label: 'Average', value: entry.average, icon: <BarChart3 className="w-4 h-4" /> },
  ] : [];

  return (
    <PageShell maxWidth="max-w-2xl">
      <p className="text-sm text-ash mb-5">Upload a screenshot of the in-game "Equipment Level" window (the popup showing Equipment Lv. / Max Weapon / Max Armor / Max Accessory). A new upload replaces whatever you had on file.</p>

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading ? (
        <div className="py-16 text-center text-ash">Loading…</div>
      ) : (
        <>
          {entry ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {cards.map((c) => (
                <StatTile key={c.label} icon={c.icon} value={c.value || '—'} label={c.label} />
              ))}
            </div>
          ) : (
            <div className="panel rounded-lg p-8 text-center text-ash mb-8">Nothing on file yet — upload a screenshot below.</div>
          )}

          <label className={`block panel rounded-lg border-dashed border-2 border-line hover:border-brass/50 transition-colors p-10 text-center ${uploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => upload(e.target.files[0])} />
            {uploading ? (
              <span className="inline-flex items-center gap-2 text-ash"><Loader2 className="w-5 h-5 animate-spin" /> Reading screenshot…</span>
            ) : (
              <>
                <UploadCloud className="w-8 h-8 text-brass mx-auto mb-4" />
                <div className="text-ash">Click to choose a gear screenshot</div>
              </>
            )}
          </label>
          {entry?.submitted_at && (
            <p className="text-ash/60 text-xs mt-4 text-center inline-flex items-center gap-1.5 justify-center w-full">
              <Check className="w-3.5 h-3.5" /> Last updated {new Date(entry.submitted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
        </>
      )}
    </PageShell>
  );
}
