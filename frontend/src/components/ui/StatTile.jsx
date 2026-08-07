// The icon + bold tabular-numeral tile reused verbatim across PlayerProfile
// (summary + gear cards) and GearLevel. Home.jsx's ledger strip is visually
// distinct (bordered-divide, no icon) and still an open question for the
// reskin, so it isn't folded in here.
export default function StatTile({ icon, value, label }) {
  return (
    <div className="panel rounded-lg p-5 text-center">
      {icon && <div className="flex items-center justify-center gap-2 text-brass mb-3">{icon}</div>}
      <div className="font-mono text-3xl text-brassbright tabular-nums">{value ?? '—'}</div>
      <div className="eyebrow text-[10px] text-ash mt-2">{label}</div>
    </div>
  );
}
