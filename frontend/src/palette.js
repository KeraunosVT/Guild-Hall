const STORAGE_KEY = 'palette';
export const PALETTES = ['dispatch', 'ironverdigris', 'throneliberty'];
const DEFAULT_PALETTE = 'dispatch';

export function getInitialPalette() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return PALETTES.includes(stored) ? stored : DEFAULT_PALETTE;
}

export function applyPalette(palette) {
  document.documentElement.dataset.palette = palette;
  localStorage.setItem(STORAGE_KEY, palette);
}
