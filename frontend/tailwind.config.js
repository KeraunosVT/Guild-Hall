/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ink:        'rgb(var(--color-ink) / <alpha-value>)',
        hall:       'rgb(var(--color-ink) / <alpha-value>)', // collapsed onto ink — Dispatch's flat 3-surface model has no 4th "floor tone"
        panel:      'rgb(var(--color-panel) / <alpha-value>)',
        panelup:    'rgb(var(--color-panelup) / <alpha-value>)',
        line:       'rgb(var(--color-line) / <alpha-value>)',
        brass:      'rgb(var(--color-brass) / <alpha-value>)',       // brand accent
        brassbright:'rgb(var(--color-brassbright) / <alpha-value>)', // accent hover/emphasis
        oxblood:    'rgb(var(--color-oxblood) / <alpha-value>)',     // danger/error — kept distinct from brand accent
        oxblooddeep:'rgb(var(--color-oxblooddeep) / <alpha-value>)',
        bone:       'rgb(var(--color-bone) / <alpha-value>)',
        ash:        'rgb(var(--color-ash) / <alpha-value>)',
      },
      fontFamily: {
        // Reference the palette-driven CSS vars (set in index.css) instead of a
        // fixed face, so font-display/font-sans switch with the active theme.
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans:    ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
