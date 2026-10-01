import type { TransferProgress } from '@/api';

// Waits for one gate transfer to finish by following its SSE stream
// (/api/transfer/:id/stream). The server closes the stream after the
// terminal event, which fires an error event we must ignore.

export interface EventSourceLike {
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export function openEventSource(url: string): EventSourceLike {
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

export function awaitTransfer(url: string, open: (url: string) => EventSourceLike = openEventSource): Promise<void> {
  return new Promise((resolve, reject) => {
    const es = open(url);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      es.close();
      if (err) reject(err);
      else resolve();
    };
    es.onmessage = (ev) => {
      let p: TransferProgress;
      try {
        p = JSON.parse(ev.data) as TransferProgress;
      } catch {
        return;
      }
      if (p.status === 'completed') finish();
      else if (p.status === 'failed' || p.status === 'cancelled') finish(new Error(p.error ?? p.status));
    };
    es.onerror = () => finish(new Error('lost connection to the transfer'));
  });
}
