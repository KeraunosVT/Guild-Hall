const STORAGE_KEY = 'theme';

// Explicit user choice (if any) wins; otherwise fall back to the OS
// preference. Doesn't persist anything, so OS-level changes keep being
// followed until the user actually toggles.
export function getInitialTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// persist=true marks this as an explicit user choice, which then overrides
// the OS preference on future visits.
export function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(STORAGE_KEY, theme);
}
