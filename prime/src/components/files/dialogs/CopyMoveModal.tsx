import * as React from 'react';
import type { FsEntry } from '@/types';
import { Button, Input } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { joinPath, parentOf } from '../fsPath';

interface CopyMoveModalProps {
  entry: FsEntry;
  mode: 'copy' | 'move';
  onCancel: () => void;
  onSubmit: (destinationPath: string, overwrite: boolean) => void;
}

// CopyMoveModal asks for the full destination path on the same host. The
// default seeds the destination with the source's parent directory and a
// "-copy" suffix on the leaf for the copy case so the user can confirm
// without typing — the common copy-in-place flow.
export function CopyMoveModal({ entry, mode, onCancel, onSubmit }: CopyMoveModalProps) {
  const initial = mode === 'copy'
    ? joinPath(parentOf(entry.path), suggestCopyName(entry.name))
    : entry.path;
  const [dst, setDst] = React.useState(initial);
  const [overwrite, setOverwrite] = React.useState(false);
  const title = mode === 'copy' ? 'Copy to…' : 'Move to…';
  const cta = mode === 'copy' ? 'Copy' : 'Move';
  const canSubmit = dst.trim().startsWith('/') && dst.trim() !== entry.path;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Source
            </div>
            <div className="text-xs font-mono truncate">{entry.path}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Destination
            </div>
            <Input
              autoFocus
              value={dst}
              onChange={(e) => setDst(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) onSubmit(dst.trim(), overwrite);
                if (e.key === 'Escape') onCancel();
              }}
              placeholder="/absolute/host/path"
              className="text-xs font-mono"
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              Full destination path on the host. Parent directory must exist.
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="h-3 w-3"
            />
            Overwrite if a file exists at the destination
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => canSubmit && onSubmit(dst.trim(), overwrite)}
            disabled={!canSubmit}
          >
            {cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// suggestCopyName produces a sensible default leaf name for a copy. For
// "foo.txt" it returns "foo-copy.txt"; for an extension-less leaf it
// appends "-copy".
function suggestCopyName(leaf: string): string {
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0) return leaf + '-copy';
  return leaf.slice(0, dot) + '-copy' + leaf.slice(dot);
}

