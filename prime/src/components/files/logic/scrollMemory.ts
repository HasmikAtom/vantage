// Scroll behaviour for the file list: per-folder scroll memory, which row to
// highlight after going up, and auto-scroll while dragging near an edge.

// When `to` is a folder above `from`, the entry in `to` that leads back down
// to `from` (the folder you came out of); otherwise null.
export function childToward(from: string, to: string): string | null {
  const prefix = to === '/' ? '/' : `${to}/`;
  if (from === to || !from.startsWith(prefix)) return null;
  const next = from.slice(prefix.length).split('/')[0];
  return next ? prefix + next : null;
}

export interface ScrollMemory {
  get(path: string): number;
  set(path: string, top: number): void;
}

// Remembers each folder's scroll position for the session, dropping the
// least recently used folder past `limit`.
export function createScrollMemory(limit = 200): ScrollMemory {
  const tops = new Map<string, number>();
  return {
    get(path) {
      const top = tops.get(path);
      if (top === undefined) return 0;
      tops.delete(path);
      tops.set(path, top);
      return top;
    },
    set(path, top) {
      tops.delete(path);
      tops.set(path, top);
      if (tops.size > limit) {
        const oldest = tops.keys().next().value;
        if (oldest !== undefined) tops.delete(oldest);
      }
    },
  };
}

// Pixels to scroll for one dragover event at pointer y over a list spanning
// top..bottom: within `edge` px of an edge, up to `max` px, faster closer in.
export function edgeScrollDelta(y: number, top: number, bottom: number, edge = 48, max = 24): number {
  if (y < top || y > bottom) return 0;
  if (y < top + edge) return -Math.round((max * (top + edge - y)) / edge);
  if (y > bottom - edge) return Math.round((max * (y - (bottom - edge))) / edge);
  return 0;
}
