import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button, Card } from '@/components/ui/primitives';
import { cancelTransfer, transferStreamURL, type TransferProgress } from '@/api';

interface TransferFooterProps {
  transfers: Record<string, TransferProgress>;
  onUpdate: (p: TransferProgress) => void;
  onDismiss: (id: string) => void;
  onRefreshSource: () => Promise<void>;
}

export function TransferFooter({ transfers, onUpdate, onDismiss, onRefreshSource }: TransferFooterProps) {
  const ids = Object.keys(transfers);
  if (ids.length === 0) return null;
  return (
    <div className="fixed bottom-3 right-3 z-40 flex flex-col gap-2 max-w-md">
      {ids.map((id) => {
        const t = transfers[id];
        if (!t) return null;
        return (
          <TransferRow
            key={id}
            transfer={t}
            onUpdate={onUpdate}
            onDismiss={() => onDismiss(id)}
            onRefreshSource={onRefreshSource}
          />
        );
      })}
    </div>
  );
}

interface TransferRowProps {
  transfer: TransferProgress;
  onUpdate: (p: TransferProgress) => void;
  onDismiss: () => void;
  onRefreshSource: () => Promise<void>;
}

function TransferRow({ transfer, onUpdate, onDismiss, onRefreshSource }: TransferRowProps) {
  // Single SSE subscription per transfer for its lifetime in this row.
  // Both onUpdate and onRefreshSource are stable callbacks from the
  // parent (useCallback with empty/state-free deps + a ref for the
  // pane refresh). Including them in deps keeps the closure fresh
  // without ever tearing the stream down mid-flight.
  React.useEffect(() => {
    const es = new EventSource(transferStreamURL(transfer.id));
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as TransferProgress;
        onUpdate(parsed);
        if (parsed.status === 'completed') {
          void onRefreshSource();
        }
      } catch {
        // Bad payload — ignore; we'll get the next event.
      }
    };
    es.onerror = () => {
      // The gate service closes the stream once the transfer ends, which
      // fires onerror in EventSource. Close cleanly; the last data event
      // already carries the terminal status.
      es.close();
    };
    return () => es.close();
  }, [transfer.id, onUpdate, onRefreshSource]);

  const t = transfer;
  const pct = t.bytesTotal > 0 ? Math.min(100, (t.bytesDone / t.bytesTotal) * 100) : 0;
  const isActive = t.status === 'pending' || t.status === 'running';
  const colorClass =
    t.status === 'completed'
      ? 'bg-primary'
      : t.status === 'failed' || t.status === 'cancelled'
        ? 'bg-destructive'
        : 'bg-primary/80';
  return (
    <Card className="p-3 space-y-1.5 w-80 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[11px] truncate">
          {t.status === 'pending' && 'Starting…'}
          {t.status === 'running' && 'Transferring'}
          {t.status === 'completed' && 'Completed'}
          {t.status === 'failed' && 'Failed'}
          {t.status === 'cancelled' && 'Cancelled'}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            if (isActive) {
              try {
                await cancelTransfer(t.id);
              } catch {
                // Swallow — the row will update via SSE either way.
              }
            } else {
              onDismiss();
            }
          }}
          className="h-5 px-1.5 text-[10px]"
        >
          {isActive ? 'Cancel' : 'Dismiss'}
        </Button>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full transition-all', colorClass)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>
          {formatBytes(t.bytesDone)} {t.bytesTotal > 0 && `/ ${formatBytes(t.bytesTotal)}`}
        </span>
        <span>{t.bytesTotal > 0 ? pct.toFixed(0) + '%' : '—'}</span>
      </div>
      {t.error && <div className="text-[10px] text-destructive">{t.error}</div>}
    </Card>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

