import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { summarize, type ItemState, type ItemStatus } from '../logic/bulk';

const STATUS_CLASS: Record<ItemStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-primary',
  done: 'text-primary',
  skipped: 'text-muted-foreground',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

interface BulkProgressDialogProps {
  title: string;
  states: readonly ItemState[];
  finished: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function BulkProgressDialog({ title, states, finished, onCancel, onRetry, onClose }: BulkProgressDialogProps) {
  const s = summarize(states);
  const parts = (['done', 'failed', 'skipped', 'cancelled', 'running', 'queued'] as const)
    .filter((k) => s[k] > 0)
    .map((k) => `${s[k]} ${k}`);
  return (
    <Dialog open onOpenChange={(o) => !o && (finished ? onClose() : onCancel())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 px-6 pb-4 text-xs">
          <div className="text-muted-foreground">{parts.join(' · ')}</div>
          <ul className="max-h-64 space-y-0.5 overflow-auto font-mono text-[11px]">
            {states.map((st) => (
              <li key={st.item.id} className="flex gap-2">
                <span className={cn('w-16 shrink-0', STATUS_CLASS[st.status])}>{st.status}</span>
                <span className="truncate">{st.item.label}</span>
                {st.error && <span className="truncate text-destructive">— {st.error}</span>}
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          {!finished ? (
            <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          ) : (
            <>
              {s.failed > 0 && (
                <Button size="sm" variant="outline" onClick={onRetry}>Retry failed</Button>
              )}
              <Button size="sm" onClick={onClose}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
