import * as React from 'react';
import type { FsEntry } from '@/types';
import { Button, Input } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fsChmod, fsChown } from '@/api';

interface PermsModalProps {
  serverId: string;
  entry: FsEntry;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function PermsModal({ serverId, entry, onCancel, onSaved }: PermsModalProps) {
  const [mode, setMode] = React.useState(modeToOctal(entry.mode));
  const [owner, setOwner] = React.useState(entry.owner);
  const [group, setGroup] = React.useState(entry.group);
  const [recursive, setRecursive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Only fire chmod if the input changed — saves an audit row when
      // the admin only wants to update ownership.
      if (mode.trim() !== modeToOctal(entry.mode)) {
        await fsChmod(serverId, entry.path, mode.trim());
      }
      if (owner.trim() !== entry.owner || group.trim() !== entry.group || recursive) {
        await fsChown(serverId, entry.path, owner.trim(), group.trim(), recursive);
      }
      await onSaved();
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
          <DialogTitle className="text-sm">{`Permissions — ${entry.name}`}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3 font-mono truncate">{entry.path}</div>
          <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Mode (octal)
          </label>
          <Input
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            placeholder="0755"
            className="text-xs font-mono"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Owner
            </label>
            <Input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="user or uid"
              className="text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Group
            </label>
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="group or gid"
              className="text-xs font-mono"
            />
          </div>
        </div>
        {entry.type === 'dir' && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            Apply ownership recursively (chown -R)
          </label>
        )}
          </div>
          {error && <div className="text-xs text-destructive mt-2">{error}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function modeToOctal(mode: number): string {
  return '0' + mode.toString(8).padStart(3, '0');
}

