import { Coins } from 'lucide-react';
import { CURRENCY_ICON, CURRENCY_LABEL, CURRENCY_IS_SHARD } from '../../currencies';
import { GradeIcon } from '../ItemTooltip';

// Rendered through the same GradeIcon the loot pages use for gear, so a
// currency sits in an identically sized box instead of at a different scale
// from the row above it.
//
// Shards take the epic grade (41), which is what draws the purple backdrop —
// they're real items in game. Lucent gets no grade: same box and border, no
// backdrop, since a purple epic frame behind a gold coin reads as a mistake.
const EPIC = 41;

// Falls back to a coin glyph for any currency whose icon hasn't been mirrored,
// so adding one without an icon degrades instead of breaking.
export default function CurrencyIcon({ currency, size = 36 }) {
  const label = CURRENCY_LABEL[currency] || currency;
  const src = CURRENCY_ICON[currency];
  if (!src) {
    return <Coins className="w-4 h-4 text-brass shrink-0" aria-label={label} />;
  }
  return (
    <span title={label} className="inline-flex shrink-0" aria-label={label}>
      <GradeIcon src={src} grade={CURRENCY_IS_SHARD[currency] ? EPIC : undefined} size={size} />
    </span>
  );
}
