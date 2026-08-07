import Sigil from '../Sigil';

// The admin-gate screen — identical copy in every one of its 6+ call sites
// today, hence the default reason text rather than requiring callers to pass one.
export default function RestrictedGate({ reason = 'The war table is open to officers of the house alone.' }) {
  return (
    <div className="max-w-2xl mx-auto px-6 py-24 text-center">
      <Sigil className="w-12 h-16 text-oxblood mx-auto mb-6" />
      <h1 className="font-display text-2xl text-bone tracking-[0.08em] mb-3">Restricted</h1>
      <p className="text-ash">{reason}</p>
    </div>
  );
}
