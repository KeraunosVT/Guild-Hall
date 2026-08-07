// Original heraldic mark for the house — a heater shield with twin chevrons
// and a central mullet. Inherits color via currentColor; size via props.
export default function Sigil({ className = '', strokeWidth = 2.4 }) {
  return (
    <svg
      viewBox="0 0 100 120"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      strokeLinecap="round"
      role="img"
      aria-label="House sigil"
    >
      <path d="M50 5 L93 17 V58 C93 86 74 103 50 115 C26 103 7 86 7 58 V17 Z" />
      <path
        d="M50 14 L85 24 V58 C85 81 69 95 50 106 C31 95 15 81 15 58 V24 Z"
        opacity="0.4"
        strokeWidth={strokeWidth * 0.7}
      />
      <path d="M24 52 L50 33 L76 52" />
      <path d="M30 70 L50 55 L70 70" opacity="0.85" />
      <path d="M50 80 L54 89 L50 99 L46 89 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
