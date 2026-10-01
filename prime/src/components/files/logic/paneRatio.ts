// Rules for the split-view divider: the left pane's share of the panes area.

export const PANE_RATIO_DEFAULT = 0.5;
// Narrow enough for a useful split, wide enough that a pane's toolbar fits
// on one line under its path.
export const PANE_MIN_PX = 360;
export const PANE_RATIO_KEY = 'vantage.files.paneRatio';

const round = (r: number) => Math.round(r * 1000) / 1000;

// Clamp so each pane keeps PANE_MIN_PX in a panes area `width` px wide (0 =
// not measured yet: only 10–90 % applies). Too narrow for two minimum panes:
// an even split.
export function clampPaneRatio(ratio: number, width: number): number {
  if (width <= 0) return round(Math.min(0.9, Math.max(0.1, ratio)));
  if (width < 2 * PANE_MIN_PX) return PANE_RATIO_DEFAULT;
  const min = PANE_MIN_PX / width;
  return round(Math.min(1 - min, Math.max(min, ratio)));
}

// The ratio for a pointer at clientX over a panes area starting at `left`.
export function ratioFromPointer(clientX: number, left: number, width: number): number {
  return width > 0 ? (clientX - left) / width : PANE_RATIO_DEFAULT;
}

// A ratio saved in localStorage, or 50/50 if it's missing or bogus.
export function parsePaneRatio(raw: string | null): number {
  if (raw === null || raw.trim() === '') return PANE_RATIO_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : PANE_RATIO_DEFAULT;
}
