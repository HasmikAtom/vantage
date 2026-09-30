import type { FsEntry } from '@/types';
import type { SizeMap } from './sizes';

export type SortKey = 'name' | 'size' | 'mtime' | 'owner' | 'mode';

export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortSpec = { key: 'name', dir: 'asc' };

const KEYS: readonly SortKey[] = ['name', 'size', 'mtime', 'owner', 'mode'];

export function parseSort(raw: string | null): SortSpec {
  if (!raw) return DEFAULT_SORT;
  try {
    const v = JSON.parse(raw) as { key?: unknown; dir?: unknown };
    if (KEYS.includes(v.key as SortKey) && (v.dir === 'asc' || v.dir === 'desc')) {
      return { key: v.key as SortKey, dir: v.dir };
    }
  } catch {
    // fall through
  }
  return DEFAULT_SORT;
}

export function toggleSort(cur: SortSpec, key: SortKey): SortSpec {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

export function filterEntries(
  entries: readonly FsEntry[],
  opts: { showHidden: boolean; query: string },
): FsEntry[] {
  const q = opts.query.trim().toLowerCase();
  return entries.filter(
    (e) => (opts.showHidden || !e.name.startsWith('.')) && (q === '' || e.name.toLowerCase().includes(q)),
  );
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sizeOf(e: FsEntry, sizes: SizeMap): number | null {
  if (e.type !== 'dir') return e.size;
  const s = sizes.get(e.path);
  return s && s.state === 'done' ? s.bytes : null;
}

// sortEntries keeps folders first, then orders by the chosen column with
// the name as tie-breaker. Folders whose size is unknown sort last in a
// size sort regardless of direction.
export function sortEntries(entries: readonly FsEntry[], spec: SortSpec, sizes: SizeMap): FsEntry[] {
  const sign = spec.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const ad = a.type === 'dir';
    const bd = b.type === 'dir';
    if (ad !== bd) return ad ? -1 : 1;
    let c = 0;
    switch (spec.key) {
      case 'size': {
        const as = sizeOf(a, sizes);
        const bs = sizeOf(b, sizes);
        if (as === null && bs !== null) return 1;
        if (bs === null && as !== null) return -1;
        c = (as ?? 0) - (bs ?? 0);
        break;
      }
      case 'mtime':
        c = a.mtime - b.mtime;
        break;
      case 'owner':
        c = collator.compare(a.owner, b.owner);
        break;
      case 'mode':
        c = (a.mode & 0o7777) - (b.mode & 0o7777);
        break;
      case 'name':
        break;
    }
    if (c !== 0) return c * sign;
    const n = collator.compare(a.name, b.name);
    return spec.key === 'name' ? n * sign : n;
  });
}
