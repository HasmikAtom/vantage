import type * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { MoreIcon, TrashIcon } from '@/components/ui/icons';
import { formatBytes } from './fsPath';

interface StatusBarProps {
  count: number;
  selectedCount: number;
  selectedBytes: number;
  sizeUnknown: boolean;
  clipboardNote: string | null;
  canControl: boolean;
  onTrash(): void;
  onMore(e: React.MouseEvent<HTMLButtonElement>): void;
}

export function StatusBar(p: StatusBarProps) {
  return (
    <div className="flex items-center gap-2 border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
      <span>
        {p.selectedCount > 0
          ? `${p.selectedCount} selected · ${formatBytes(p.selectedBytes)}${p.sizeUnknown ? '+' : ''}`
          : `${p.count} items`}
      </span>
      {p.clipboardNote && <span className="rounded bg-muted px-1.5">{p.clipboardNote}</span>}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={p.selectedCount === 0 || !p.canControl}
          onClick={p.onTrash}
          className="text-destructive hover:text-destructive"
        >
          <TrashIcon size={11} /> Trash
        </Button>
        <Button size="xs" variant="ghost" disabled={p.selectedCount === 0} onClick={p.onMore} title="More actions">
          <MoreIcon size={12} />
        </Button>
      </div>
    </div>
  );
}
