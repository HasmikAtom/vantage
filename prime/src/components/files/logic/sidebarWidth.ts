// Width rules for the resizable Files sidebar.

export const SIDEBAR_DEFAULT = 224;
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_WIDTH_KEY = 'vantage.files.sidebarWidth';

// Room the file list keeps beside the sidebar: one pane, or two in split view.
const MAIN_MIN = 360;
const SPLIT_MAIN_MIN = 720; // two panes at PANE_MIN_PX

// Clamp a requested width to 160–480 px and to what the card can spare.
export function clampSidebarWidth(width: number, containerWidth: number, split: boolean): number {
  const room = containerWidth - (split ? SPLIT_MAIN_MIN : MAIN_MIN);
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, room));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
}

// A width saved in localStorage, or the default if it's missing or bogus.
export function parseSidebarWidth(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return SIDEBAR_DEFAULT;
  const n = Number(raw);
  return n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
}
