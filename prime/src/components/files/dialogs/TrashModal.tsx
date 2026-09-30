import * as React from 'react';
import type { TrashItem } from '@/types';
import { Badge, Button } from '@/components/ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TrashIcon } from '@/components/ui/icons';
import { fsTrashList, fsTrashPermanentDelete, fsTrashRestore } from '@/api';
import { formatSize } from '../fsPath';

interface TrashModalProps {
  serverId: string;
  canAdmin: boolean;
  onClose: () => void;
  onRestored: () => Promise<void>;
}

export function TrashModal({ serverId, canAdmin, onClose, onRestored }: TrashModalProps) {
  const [items, setItems] = React.useState<TrashItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fsTrashList(serverId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Trash bin</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3">
            Items move here when deleted. Auto-purged after 7 days.
          </div>
          {error && <div className="text-xs text-destructive mb-2">{error}</div>}
          {loading ? (
            <div className="text-xs text-muted-foreground">loading…</div>
          ) : items.length === 0 ? (
            <div className="text-xs text-muted-foreground">Empty.</div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Original path</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Deleted</TableHead>
                    <TableHead className="w-40 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TrashRow
                      key={it.id}
                      serverId={serverId}
                      item={it}
                      canAdmin={canAdmin}
                      onChanged={async () => {
                        await refresh();
                        await onRestored();
                      }}
                      onError={setError}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TrashRowProps {
  serverId: string;
  item: TrashItem;
  canAdmin: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

function TrashRow({ serverId, item, canAdmin, onChanged, onError }: TrashRowProps) {
  const [busy, setBusy] = React.useState(false);
  const deletedAgo = formatRelative(item.deletedAt);
  return (
    <TableRow>
      <TableCell className="font-mono text-[11px] truncate max-w-[360px]">
        {item.originalPath}
        <Badge variant="muted" className="ml-1.5 rounded-sm">{item.type}</Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatSize(item.size, item.type)}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground">
        {deletedAgo}
        {item.deletedBy && <span className="ml-1 text-muted-foreground/60">by {item.deletedBy}</span>}
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                try {
                  await fsTrashRestore(serverId, item.id, false);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes('already exists')) {
                    if (!confirm(`${item.originalPath} already exists at destination. Overwrite?`)) {
                      return;
                    }
                    await fsTrashRestore(serverId, item.id, true);
                  } else {
                    throw e;
                  }
                }
                await onChanged();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !canAdmin}
            title={!canAdmin ? 'Admin role required' : 'Permanently delete (no undo)'}
            onClick={async () => {
              if (!confirm(`Permanently delete ${item.originalPath}? This cannot be undone.`)) return;
              setBusy(true);
              try {
                await fsTrashPermanentDelete(serverId, item.id);
                await onChanged();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            className="text-destructive hover:text-destructive"
          >
            <TrashIcon size={11} />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function formatRelative(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

