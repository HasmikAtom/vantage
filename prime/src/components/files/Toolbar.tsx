import * as React from 'react';
import { Button, Input } from '@/components/ui/primitives';
import { ContextMenu, type MenuEntry } from '@/components/ui/context-menu';
import { FileTextIcon, FolderIcon, UploadIcon } from '@/components/ui/icons';

interface ToolbarProps {
  canControl: boolean;
  query: string;
  onQuery(q: string): void;
  showHidden: boolean;
  onShowHidden(v: boolean): void;
  onNew(what: 'folder' | 'file'): void;
  onUploadFiles(): void;
  onUploadFolder(): void;
}

export function Toolbar(p: ToolbarProps) {
  const [menu, setMenu] = React.useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const close = React.useCallback(() => setMenu(null), []);
  const openAt = (e: React.MouseEvent<HTMLButtonElement>, items: MenuEntry[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };
  const why = p.canControl ? {} : { title: 'Operator role required' };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
      <Button
        size="xs"
        variant="outline"
        disabled={!p.canControl}
        {...why}
        onClick={(e) =>
          openAt(e, [
            { kind: 'item', label: 'Folder', icon: <FolderIcon size={12} />, shortcut: 'Ctrl+Shift+N', onSelect: () => p.onNew('folder') },
            { kind: 'item', label: 'File', icon: <FileTextIcon size={12} />, onSelect: () => p.onNew('file') },
          ])
        }
      >
        New ▾
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={!p.canControl}
        {...why}
        onClick={(e) =>
          openAt(e, [
            { kind: 'item', label: 'Files…', icon: <UploadIcon size={12} />, onSelect: p.onUploadFiles },
            { kind: 'item', label: 'Folder…', icon: <FolderIcon size={12} />, onSelect: p.onUploadFolder },
          ])
        }
      >
        <UploadIcon size={11} /> Upload ▾
      </Button>
      <div className="ml-auto flex items-center gap-2">
        <Input
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          placeholder="Filter this folder"
          className="h-7 w-44 text-xs"
        />
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={p.showHidden}
            onChange={(e) => p.onShowHidden(e.target.checked)}
            className="h-3 w-3"
          />
          Show hidden
        </label>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />}
    </div>
  );
}
