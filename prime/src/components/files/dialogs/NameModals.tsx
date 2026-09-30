import * as React from 'react';
import type { FsEntry } from '@/types';
import { Button, Input } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface NewFolderModalProps {
  parent: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
  what?: 'folder' | 'file';
}

export function NewFolderModal({ parent, onCancel, onSubmit, what = 'folder' }: NewFolderModalProps) {
  const [name, setName] = React.useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{what === 'file' ? 'New file' : 'New folder'}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-2">in {parent}</div>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSubmit(name.trim());
              if (e.key === 'Escape') onCancel();
            }}
            placeholder={`${what} name`}
            className="text-xs"
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => name.trim() && onSubmit(name.trim())} disabled={!name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameModalProps {
  entry: FsEntry;
  onCancel: () => void;
  onSubmit: (newName: string) => void;
}

export function RenameModal({ entry, onCancel, onSubmit }: RenameModalProps) {
  const [name, setName] = React.useState(entry.name);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Rename</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-2 font-mono truncate">{entry.path}</div>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && name !== entry.name) onSubmit(name.trim());
              if (e.key === 'Escape') onCancel();
            }}
            className="text-xs"
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => name.trim() && onSubmit(name.trim())}
            disabled={!name.trim() || name === entry.name}
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

