// URL hash + browser-history model for explorer navigation.
//
// Every folder change is a real history entry (#files:<path>) so the
// browser Back button, the mouse back button, and the explorer's ←/→ all
// agree. history.state carries {filesIdx}; the model tracks how far back
// and forward the explorer's own entries go so ←/→ never leave the app.

export function hashFor(path: string): string {
  return '#files:' + path.split('/').map(encodeURIComponent).join('/');
}

export function pathFromHash(hash: string): string | null {
  const m = hash.match(/^#files:(\/.*)$/);
  if (!m || !m[1]) return null;
  try {
    return m[1].split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

export interface NavModel {
  idx: number;
  max: number;
}

export function navInit(stateIdx: unknown): NavModel {
  const i = typeof stateIdx === 'number' && stateIdx >= 0 ? stateIdx : 0;
  return { idx: i, max: i };
}

export function navPush(m: NavModel): NavModel {
  return { idx: m.idx + 1, max: m.idx + 1 };
}

export function navPop(m: NavModel, stateIdx: unknown): NavModel {
  if (typeof stateIdx !== 'number') return m;
  return { idx: stateIdx, max: Math.max(m.max, stateIdx) };
}

export const canBack = (m: NavModel): boolean => m.idx > 0;
export const canForward = (m: NavModel): boolean => m.idx < m.max;
