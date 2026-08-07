// The two tab shapes actually in use: a pill/segmented control (Roster's
// Totals/Averages) and a flat bar (LOA's Submit/My LOAs/Board). The boolean
// two-state toggles elsewhere (Members/All, PVP/PVE) have their own
// per-state coloring and aren't this component.
export default function Tabs({ variant = 'pill', items, active, onChange }) {
  if (variant === 'flat') {
    return (
      <div className="flex gap-1 mb-6">
        {items.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${active === key ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 shrink-0">
      {items.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all cursor-pointer ${active === key ? 'bg-brass text-ink' : 'text-ash'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
