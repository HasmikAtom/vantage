import * as React from 'react';
import type { FsEntry } from '@/types';
import { cn } from '@/lib/utils';
import { Button, Input } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createTransfer, fetchServers, type ServerSummary, type TransferProgress } from '@/api';
import { formatSize, joinPath, parentOf } from '../fsPath';
import { DestinationBrowser } from './DestinationBrowser';

interface SendToModalProps {
  sourceServerId: string;
  entry: FsEntry;
  canPreserveOwnership: boolean;
  onCancel: () => void;
  onStarted: (initial: TransferProgress) => void;
}

export function SendToModal({
  sourceServerId,
  entry,
  canPreserveOwnership,
  onCancel,
  onStarted,
}: SendToModalProps) {
  const [servers, setServers] = React.useState<ServerSummary[]>([]);
  const [dstServer, setDstServer] = React.useState('');
  // Default the destination to /tmp/<basename> rather than the source's
  // full path: /tmp is universally writable, the filename is preserved,
  // and the user has to consciously pick a real destination (vs.
  // unintentionally mirroring a path that may not exist on the other
  // host). Same-fleet "sync" use cases just edit the field.
  const [dstPath, setDstPath] = React.useState(`/tmp/${entry.name}`);
  const [mode, setMode] = React.useState<'copy' | 'move'>('copy');
  const [overwrite, setOverwrite] = React.useState(false);
  const [preserveOwnership, setPreserveOwnership] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const list = await fetchServers();
        const others = list.filter((s) => s.id !== sourceServerId);
        setServers(others);
        if (others.length > 0 && others[0]) setDstServer(others[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [sourceServerId]);

  const submit = async () => {
    if (!dstServer || !dstPath.startsWith('/')) {
      setError('Destination server and absolute path required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { id } = await createTransfer({
        srcServer: sourceServerId,
        srcPath: entry.path,
        dstServer,
        dstPath,
        mode,
        overwrite,
        preserveSourceOwnership: preserveOwnership,
      });
      onStarted({
        id,
        bytesTotal: entry.size,
        bytesDone: 0,
        status: 'pending',
        error: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Send "${entry.name}" to another server`}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3 font-mono truncate">
            from {entry.path} · {formatSize(entry.size, entry.type)}
          </div>
      {servers.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No other servers registered. Add one in Settings first.
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Destination server
            </label>
            <select
              value={dstServer}
              onChange={(e) => setDstServer(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Destination path
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                value={dstPath}
                onChange={(e) => setDstPath(e.target.value)}
                placeholder="/absolute/path/on/destination"
                className="text-xs font-mono flex-1"
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setBrowseOpen(true)}
                disabled={!dstServer}
                title={!dstServer ? 'Pick a destination server first' : 'Browse the destination server'}
              >
                Browse…
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground/70 mt-1">
              Absolute path on the destination host. The parent directory must already exist.
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
              />
              Copy
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'move'}
                onChange={() => setMode('move')}
              />
              Move <span className="text-muted-foreground/60">(delete source on success)</span>
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite if destination already exists
          </label>
          <label
            className={cn(
              'flex items-center gap-1.5 text-xs',
              canPreserveOwnership ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
            )}
            title={!canPreserveOwnership ? 'Admin role required (chmod/chown on destination)' : undefined}
          >
            <input
              type="checkbox"
              checked={preserveOwnership && canPreserveOwnership}
              disabled={!canPreserveOwnership}
              onChange={(e) => setPreserveOwnership(e.target.checked)}
            />
            Preserve source ownership & mode
            <span className="text-muted-foreground/60">(uid/gid + chmod)</span>
          </label>
        </div>
      )}
          {error && <div className="text-xs text-destructive mt-2">{error}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || servers.length === 0 || !dstServer || !dstPath}
          >
            {busy ? 'Starting…' : 'Start transfer'}
          </Button>
        </DialogFooter>
        {browseOpen && dstServer && (
          <DestinationBrowser
            serverId={dstServer}
            serverName={servers.find((s) => s.id === dstServer)?.name ?? 'destination'}
            initialPath={parentOfMaybe(dstPath) || '/tmp'}
            sourceName={entry.name}
            onCancel={() => setBrowseOpen(false)}
            onPick={(folder) => {
              setBrowseOpen(false);
              setDstPath(joinPath(folder, entry.name));
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// parentOfMaybe handles the case where dstPath has no usable parent
// (e.g. an empty string or a single segment) and returns "" so the
// browser falls back to its initialPath default.
function parentOfMaybe(p: string): string {
  if (!p || !p.startsWith('/')) return '';
  return parentOf(p);
}

