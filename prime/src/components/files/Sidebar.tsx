import * as React from 'react';
import type { FsEntry } from '@/types';
import type { FsPin } from '@/api';
import { cn } from '@/lib/utils';
import { edgeScrollDelta } from './logic/scrollMemory';
import { ContextMenu, type MenuEntry } from '@/components/ui/context-menu';
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PinIcon } from '@/components/ui/icons';
import type { ElProps } from './FileList';
import { ancestorsOf } from './fsPath';
import { fetchListing } from './hooks/useDirListing';
import { movePin, pinLabel, removePin, renamePin } from './logic/pins';

interface SidebarProps {
  serverId: string;
  currentPath: string;
  showHidden: boolean;
  refreshKey: number;
  pins: FsPin[];
  onPinsChange(next: FsPin[]): void;
  onNavigate(path: string): void;
  dropPropsFor?: (dir: string) => ElProps;
  pinDropProps?: ElProps;
  dropTarget?: string | null;
  pinDropActive?: boolean;
}

export function Sidebar(p: SidebarProps) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set(['/']));
  const [broken, setBroken] = React.useState<ReadonlySet<string>>(() => new Set());
  const [pinMenu, setPinMenu] = React.useState<{ x: number; y: number; pin: FsPin } | null>(null);
  const closePinMenu = React.useCallback(() => setPinMenu(null), []);

  // Open the tree down to the folder being viewed.
  React.useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestorsOf(p.currentPath).slice(0, -1)) next.add(a);
      return next.size === prev.size ? prev : next;
    });
  }, [p.currentPath]);

  // Grey out pins whose folder no longer lists.
  React.useEffect(() => {
    let alive = true;
    void Promise.all(
      p.pins.map((pin) => fetchListing(p.serverId, pin.path).then(() => null, () => pin.path)),
    ).then((bad) => {
      if (alive) setBroken(new Set(bad.filter((x): x is string => x !== null)));
    });
    return () => {
      alive = false;
    };
  }, [p.serverId, p.pins]);

  const toggle = React.useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const pinItems = (pin: FsPin): MenuEntry[] => [
    {
      kind: 'item',
      label: 'Rename…',
      onSelect: () => {
        const label = window.prompt('Pin label', pinLabel(pin));
        if (label !== null) p.onPinsChange(renamePin(p.pins, pin.path, label));
      },
    },
    { kind: 'item', label: 'Move up', onSelect: () => p.onPinsChange(movePin(p.pins, pin.path, -1)) },
    { kind: 'item', label: 'Move down', onSelect: () => p.onPinsChange(movePin(p.pins, pin.path, 1)) },
    { kind: 'separator' },
    { kind: 'item', label: 'Unpin', danger: true, onSelect: () => p.onPinsChange(removePin(p.pins, pin.path)) },
  ];

  return (
    // Fills the card: pins stay at the top (scrolling only if there are very
    // many) and the folder tree scrolls underneath.
    <nav aria-label="Folders" className="flex h-full flex-col gap-3 overflow-hidden p-2 text-xs">
      <section className="max-h-[50%] shrink-0 overflow-auto">
        <div
          {...(p.pinDropProps ?? {})}
          className={cn(
            'mb-1 flex items-center gap-1 rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
            p.pinDropActive && 'bg-primary/10 ring-1 ring-primary',
          )}
        >
          <PinIcon size={10} /> Pinned
        </div>
        <ul>
          {p.pins.map((pin) => (
            <li key={pin.path}>
              <button
                type="button"
                title={pin.path}
                {...(p.dropPropsFor?.(pin.path) ?? {})}
                onClick={() => p.onNavigate(pin.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPinMenu({ x: e.clientX, y: e.clientY, pin });
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-muted',
                  p.currentPath === pin.path && 'bg-primary/10 text-primary',
                  broken.has(pin.path) && 'opacity-40',
                  p.dropTarget === pin.path && 'bg-primary/10 ring-1 ring-primary',
                )}
              >
                <FolderIcon size={12} className="shrink-0 text-primary/70" />
                <span className="truncate">{pinLabel(pin)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section
        className="min-h-0 flex-1 overflow-auto"
        onDragOverCapture={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const dy = edgeScrollDelta(e.clientY, r.top, r.bottom);
          if (dy !== 0) e.currentTarget.scrollTop += dy;
        }}
      >
        <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Folders</div>
        <TreeNode
          serverId={p.serverId}
          path="/"
          name="/"
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          currentPath={p.currentPath}
          showHidden={p.showHidden}
          refreshKey={p.refreshKey}
          onNavigate={p.onNavigate}
          dropPropsFor={p.dropPropsFor}
          dropTarget={p.dropTarget}
        />
      </section>
      {pinMenu && <ContextMenu x={pinMenu.x} y={pinMenu.y} items={pinItems(pinMenu.pin)} onClose={closePinMenu} />}
    </nav>
  );
}

interface TreeNodeProps {
  serverId: string;
  path: string;
  name: string;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle(path: string): void;
  currentPath: string;
  showHidden: boolean;
  refreshKey: number;
  onNavigate(path: string): void;
  dropPropsFor?: ((dir: string) => ElProps) | undefined;
  dropTarget?: string | null | undefined;
}

function TreeNode(n: TreeNodeProps) {
  const open = n.expanded.has(n.path);
  const [children, setChildren] = React.useState<FsEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchListing(n.serverId, n.path).then(
      (r) => {
        if (!alive) return;
        setChildren(r.entries.filter((e) => e.type === 'dir'));
        setFailed(false);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open, n.serverId, n.path, n.refreshKey]);

  const kids = (children ?? []).filter((c) => n.showHidden || !c.name.startsWith('.'));

  return (
    <div>
      <div
        {...(n.dropPropsFor?.(n.path) ?? {})}
        style={{ paddingLeft: n.depth * 12 }}
        className={cn(
          'flex items-center rounded hover:bg-muted',
          n.currentPath === n.path && 'bg-primary/10 text-primary',
          n.dropTarget === n.path && 'bg-primary/10 ring-1 ring-primary',
        )}
      >
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
          onClick={() => n.onToggle(n.path)}
          className="p-0.5 text-muted-foreground"
        >
          {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
        </button>
        <button
          type="button"
          title={n.path}
          onClick={() => n.onNavigate(n.path)}
          className={cn('flex-1 truncate py-0.5 pr-1 text-left', failed && 'opacity-40')}
        >
          {n.name}
        </button>
      </div>
      {open &&
        kids.map((c) => (
          <TreeNode key={c.path} {...n} path={c.path} name={c.name} depth={n.depth + 1} />
        ))}
    </div>
  );
}
