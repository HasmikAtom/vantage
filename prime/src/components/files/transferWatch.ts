import type { TransferProgress } from '@/api';

// Waits for one gate transfer to finish by checking GET /api/transfer/:id
// about once a second. Polling instead of holding the SSE stream open keeps
// many concurrent transfers from exhausting the browser's per-origin
// connection limit on plain-HTTP installs, and a dropped request is just
// retried instead of failing a transfer that is still running.

export interface PollOptions {
  intervalMs?: number;
  // Consecutive failed checks tolerated before giving up.
  maxErrors?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;
}

export async function pollTransfer(
  id: string,
  fetchStatus: (id: string) => Promise<TransferProgress>,
  opts: PollOptions = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 1000;
  const maxErrors = opts.maxErrors ?? 10;
  const sleep = opts.sleep ?? wait;
  let errors = 0;
  for (;;) {
    let p: TransferProgress;
    try {
      p = await fetchStatus(id);
      errors = 0;
    } catch (e) {
      if (isNotFound(e)) {
        // The caller can still check the destination: the copy may have
        // finished before gate forgot about it.
        throw Object.assign(new Error('transfer no longer known to the dashboard (gate restarted?)'), { unknownTransfer: true });
      }
      errors++;
      if (errors >= maxErrors) throw new Error(`lost contact with the transfer: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(interval);
      continue;
    }
    if (p.status === 'completed') return;
    if (p.status === 'failed' || p.status === 'cancelled') throw new Error(p.error ?? p.status);
    await sleep(interval);
  }
}
