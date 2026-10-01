import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button, Input } from '@/components/ui/primitives';
import { ContextMenu, type MenuEntry } from '@/components/ui/context-menu';
import { ColumnsIcon, FileTextIcon, FolderIcon, UploadIcon } from '@/components/ui/icons';

interface ToolbarProps {
  canControl: boolean;
  query: string;
  onQuery(q: string): void;
  showHidden: boolean;
  onShowHidden(v: boolean): void;
  onNew(what: 'folder' | 'file'): void;
  onUploadFiles(): void;
  onUploadFolder(): void;
  split: boolean;
  canSplit: boolean;
  onToggleSplit(): void;
  onHelp(): void;
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
    // Rendered inside the address bar's row (see AddressBar children).
    // In a split pane it takes its own line under the path.
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1.5', p.split && 'w-full')}>
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
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
        {(p.canSplit || p.split) && (
          <Button
            size="xs"
            variant={p.split ? 'secondary' : 'ghost'}
            aria-pressed={p.split}
            onClick={p.onToggleSplit}
            title="Split view (Ctrl+\)"
          >
            <ColumnsIcon size={12} />
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={p.onHelp} title="Keyboard shortcuts (?)">
          ?
        </Button>
        <Input
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          placeholder="Filter this folder"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && p.query !== '') {
              e.preventDefault();
              e.stopPropagation();
              p.onQuery('');
            }
          }}
          // ! overrides: the shared Input is w-full / h-9, which otherwise win
          // and stretch the box across its own line.
          className="!h-7 !w-36 min-w-[5rem] shrink !px-2 !text-xs"
        />
        <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground">
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
