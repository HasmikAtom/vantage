import type { FsListResponse } from '@/types';

// seedListing picks what the list shows while a (re)load is in flight.
// Reloading the folder already on screen keeps it — mutations clear the
// cache first, and blanking the list would wipe selection, focus and
// scroll position. Navigating shows the cached listing, or nothing.
export function seedListing(
  shown: { key: string; data: FsListResponse | null },
  nextKey: string,
  cached: FsListResponse | undefined,
): FsListResponse | null {
  if (shown.key === nextKey && shown.data) return shown.data;
  return cached ?? null;
}
