import * as React from 'react';
import { fsList } from '@/api';
import type { FsListResponse } from '@/types';

// Listing cache shared by the main list and the sidebar tree. The main
// list shows a cached listing immediately and always revalidates; the tree
// uses the cache as-is. Mutations call invalidateListings().

const cache = new Map<string, FsListResponse>();
const key = (serverId: string, path: string) => `${serverId}\u0000${path}`;

export function fetchListing(serverId: string, path: string, force = false): Promise<FsListResponse> {
  const hit = cache.get(key(serverId, path));
  if (hit && !force) return Promise.resolve(hit);
  return fsList(serverId, path).then((r) => {
    cache.set(key(serverId, path), r);
    return r;
  });
}

export function invalidateListings(serverId: string, dirs: readonly string[]): void {
  for (const d of dirs) cache.delete(key(serverId, d));
}

export interface DirListing {
  data: FsListResponse | null;
  loading: boolean;
  error: unknown;
  reload: () => Promise<void>;
}

export function useDirListing(serverId: string, path: string): DirListing {
  const [data, setData] = React.useState<FsListResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const my = ++seq.current;
    const cached = cache.get(key(serverId, path));
    setData(cached ?? null);
    setLoading(true);
    setError(null);
    try {
      const r = await fetchListing(serverId, path, true);
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) {
        setData(null);
        setError(e);
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [serverId, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}
