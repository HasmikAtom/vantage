// Height that lets the Files card fill the window below where it starts, so
// the page itself doesn't scroll — only the file list and sidebar inside it.
export const FILL_MIN = 360;

export function fillHeight(windowHeight: number, cardTop: number, bottomGap: number, min = FILL_MIN): number {
  return Math.max(min, Math.floor(windowHeight - cardTop - bottomGap));
}
