/**
 * The progress view of a transfer that the SPA may see, and the
 * owner-checked lookup used by GET /api/transfer/:id. Kept free of the
 * auth/registry imports so it can be unit-tested on its own.
 */

export interface TransferSnapshot {
  id: string;
  bytesTotal: number;
  bytesDone: number;
  status: string;
  error: string | null;
}

interface SnapshotSource extends TransferSnapshot {
  userId: string;
}

export function snapshotOf(s: TransferSnapshot): TransferSnapshot {
  return { id: s.id, bytesTotal: s.bytesTotal, bytesDone: s.bytesDone, status: s.status, error: s.error };
}

// Unknown ids and other users' transfers look the same (null → 404), so
// ids cannot be probed across users.
export function snapshotFor(
  store: ReadonlyMap<string, SnapshotSource>,
  id: string,
  userId: string,
): TransferSnapshot | null {
  const s = store.get(id);
  if (!s || s.userId !== userId) return null;
  return snapshotOf(s);
}
