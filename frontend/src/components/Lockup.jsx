// The Guild Hall wordmark — the PRODUCT's mark, not a guild's.
//
// Distinct from <Sigil/>, which is the heraldic shield standing in for the
// house you're signed into. This belongs anywhere the page is about Guild Hall
// itself: the login gate, the loading splash before a guild is known. It must
// never appear as if it were a tenant's own emblem.
//
// Inlined rather than <img src="/guildhall-lockup.svg"> on purpose: an SVG
// loaded through <img> is an isolated document that cannot reach the page's
// webfonts, so the wordmark would silently fall back to a system sans and stop
// matching the rest of the type. Inline, it inherits Sora from the page.
//
// The gradient id is namespaced because ids in inline SVG are global to the
// document — a bare id="g" would be captured by whichever copy rendered first.
export default function Lockup({ className = '', title = 'Guild Hall' }) {
  return (
    <svg
      viewBox="0 0 420 90"
      className={className}
      fontFamily="Sora, sans-serif"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id="gh-lockup-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d64545" />
          <stop offset="1" stopColor="#3a1b18" />
        </linearGradient>
      </defs>
      <rect x="9" y="12" width="66" height="66" rx="16" fill="url(#gh-lockup-grad)" />
      <g transform="translate(21 24) scale(0.42)" fill="#ffffff">
        <path d="M50 6 A44 44 0 1 0 94 50 L94 46 L60 46 L60 60 L78 60 A28.5 28.5 0 1 1 50 21.5 A28.3 28.3 0 0 1 69 28.8 L79.5 18.3 A43.8 43.8 0 0 0 50 6 Z" />
        <rect x="38" y="34" width="8.5" height="33" rx="2.2" />
        <rect x="55" y="34" width="8.5" height="33" rx="2.2" />
        <rect x="38" y="46" width="25.5" height="8" rx="2.2" />
      </g>
      <text x="92" y="59" fontSize="38" fontWeight="800" letterSpacing="-0.02em">
        <tspan fill="#ececeb">Guild</tspan><tspan fill="#d64545">Hall</tspan>
      </text>
    </svg>
  );
}
