// Threat ratings and their colours, shared by the threat board and the wargame
// fill pages (which show an opponent's rating wherever they name one).
//
// Raw Tailwind hues rather than theme tokens, on purpose: six ratings need six
// separable colours, and the palette tokens are built around one accent. The
// order is the ramp, strongest first.
export const STATUSES = [
  { key: 'Threat', short: 'Threat', dot: 'bg-fuchsia-400', text: 'text-fuchsia-300', tint: 'bg-fuchsia-500/10' },
  // Orange, not amber. Competitive and Potential sit next to each other in the
  // ramp, and amber-400 was only ~8° of hue from yellow-300 — close enough that
  // the two tiers read as one at chip size. Orange puts ~24° between them, and
  // it is nearer the source sheet's own #FF9900 besides.
  { key: 'Competitive', short: 'Competitive', dot: 'bg-orange-400', text: 'text-orange-300', tint: 'bg-orange-500/10' },
  { key: 'Potential', short: 'Potential', dot: 'bg-yellow-300', text: 'text-yellow-200', tint: 'bg-yellow-500/10' },
  { key: 'Rebuild/TBD', short: 'Rebuild / TBD', dot: 'bg-sky-400', text: 'text-sky-300', tint: 'bg-sky-500/10' },
  { key: 'Not Competitive', short: 'Not competitive', dot: 'bg-emerald-400', text: 'text-emerald-300', tint: 'bg-emerald-500/10' },
  { key: 'Disbanded/Merged', short: 'Disbanded', dot: 'bg-zinc-500', text: 'text-ash', tint: 'bg-zinc-500/10' },
];

export const STATUS_META = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
