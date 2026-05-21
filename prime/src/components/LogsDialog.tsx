import * as React from 'react';
import { Button } from './ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export interface LogsDialogProps {
  serverId: string;
  // The container ID + display name to tail, or null to keep dialog closed.
  target: { id: string; name: string } | null;
  onClose: () => void;
}

// Per-line shape emitted by the backend's logs SSE handler.
interface LogEvent {
  stream: 'stdout' | 'stderr' | '_error';
  line: string;
  ts?: string; // RFC3339Nano; may be missing on error events
}

// Cap on lines kept in the in-memory ring. Past this we drop the oldest
// to keep the dialog memory-bounded — a chatty container can produce
// thousands of lines per minute. Virtualized rendering is a future
// enhancement; for now we trade history depth for simplicity.
const MAX_LINES = 5000;

// One ring entry. Keyed by a monotonic counter rather than ts because
// docker timestamps can repeat at sub-microsecond resolution on bursty
// output, and React needs stable unique keys.
interface LogRow {
  k: number;
  stream: LogEvent['stream'];
  line: string;
  ts?: string;
}

/**
 * Live log viewer for one container, streamed over SSE.
 *
 * Two controls in the toolbar:
 *   - Pause / Resume     — closes/reopens the EventSource without losing
 *                          the already-rendered ring buffer.
 *   - Follow tail (auto) — when on, the view sticks to the bottom on
 *                          every new line; when off, you can scroll back
 *                          without being yanked back down.
 *
 * Reconnect resume is handled by the browser's EventSource (it sends
 * Last-Event-ID automatically; the backend uses the nano timestamp to
 * skip lines we already saw).
 */
export const LogsDialog = ({ serverId, target, onClose }: LogsDialogProps) => {
  const [rows, setRows] = React.useState<LogRow[]>([]);
  const [paused, setPaused] = React.useState(false);
  const [followTail, setFollowTail] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const counterRef = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Reset on each open. Without this you'd see the prior container's
  // tail flash before the new stream's lines start arriving.
  React.useEffect(() => {
    if (target) {
      setRows([]);
      setPaused(false);
      setFollowTail(true);
      setError(null);
      counterRef.current = 0;
    }
  }, [target]);

  // Open / re-open the EventSource whenever target or paused changes.
  React.useEffect(() => {
    if (!target || paused) return;
    const url = `/api/servers/${encodeURIComponent(serverId)}/containers/${encodeURIComponent(target.id)}/logs/stream?tail=200`;
    const es = new EventSource(url, { withCredentials: true });

    // Lifecycle guard: between unmount of the old ES and mount of the new
    // one, queued message events from the old socket can still fire after
    // close(). The `cancelled` flag short-circuits them before they reach
    // setState, so we don't get "ghost" lines in the resumed stream.
    let cancelled = false;

    // Batch incoming events through one rAF per frame. A chatty container
    // can emit 100+ lines/sec; without this, every line forces a fresh
    // ring-buffer allocation and a reconciliation pass. Coalescing into
    // ≤60 setRows/sec collapses that work without changing visible
    // behavior (the follow-tail effect still triggers on each commit).
    const pending: LogRow[] = [];
    let rafScheduled = false;
    const flush = () => {
      rafScheduled = false;
      if (cancelled || pending.length === 0) return;
      const batch = pending.splice(0);
      setRows((prev) => {
        const merged = prev.concat(batch);
        return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
      });
    };

    es.onmessage = (ev) => {
      if (cancelled) return;
      try {
        const parsed = JSON.parse(ev.data) as LogEvent;
        counterRef.current += 1;
        // Only include ts when present — exactOptionalPropertyTypes
        // rejects {ts: undefined} against an optional `ts?: string`.
        const row: LogRow = {
          k: counterRef.current,
          stream: parsed.stream,
          line: parsed.line,
          ...(parsed.ts ? { ts: parsed.ts } : {}),
        };
        pending.push(row);
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flush);
        }
      } catch {
        // Skip malformed payloads silently — we'd rather lose one line
        // than tear down the whole stream over a parse blip.
      }
    };

    // EventSource named-event channels for backend error frames.
    es.addEventListener('error', () => {
      if (cancelled) return;
      if (es.readyState === EventSource.CLOSED) {
        setError('Stream closed');
      }
    });

    return () => {
      cancelled = true;
      es.close();
      // Any pending rAF will run but no-op because `cancelled` is set.
    };
  }, [serverId, target, paused]);

  // Stick scroll position to the bottom while follow-tail is on. We do this
  // in an effect on `rows` rather than on every message so React batches
  // multiple lines per frame for free.
  React.useEffect(() => {
    if (!followTail || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [rows, followTail]);

  if (!target) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogDescription>Container logs</DialogDescription>
          <DialogTitle>{target.name}</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-2 flex items-center gap-3">
          <Button
            size="xs"
            variant={paused ? 'default' : 'outline'}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={followTail}
              onChange={(e) => setFollowTail(e.target.checked)}
            />
            Follow tail
          </label>
          <div className="ml-auto text-[10px] text-muted-foreground font-mono">
            {rows.length} {rows.length === MAX_LINES ? '(ring full)' : 'lines'}
          </div>
        </div>

        <div className="px-6 pb-6">
          <div
            ref={scrollRef}
            className="rounded-md border bg-foreground/95 text-background h-[55vh] overflow-auto p-3 font-mono text-[11px] leading-relaxed"
          >
            {rows.length === 0 && !error && (
              <div className="text-background/60 italic">Waiting for output…</div>
            )}
            {rows.map((r) => (
              <div
                key={r.k}
                className={
                  r.stream === 'stderr'
                    ? 'text-red-300'
                    : r.stream === '_error'
                      ? 'text-red-400 italic'
                      : 'text-background'
                }
              >
                {r.line}
              </div>
            ))}
          </div>
          {error && (
            <div className="mt-2 text-[11px] text-destructive font-mono">{error}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
