import * as React from 'react';
import type { FsEntry } from '@/types';
import type { ElProps } from './FileList';
import { VANTAGE_DND_TYPE, canDropInto, dropMode } from './logic/dnd';

// Sentinel dropTarget value for the sidebar's "Pinned" heading.
export const PIN_TARGET = '\u0000pins';

// The drag payload is mirrored here: during dragover browsers expose only
// the MIME types, not the data, and we need the paths to reject invalid
// targets (a folder into itself, items into their own folder).
let dragging: { serverId: string; paths: string[]; dirs: string[] } | null = null;

interface DndOptions {
  serverId: string;
  canControl: boolean;
  dragItems(entry: FsEntry): FsEntry[];
  onInternalDrop(paths: string[], targetDir: string, mode: 'copy' | 'move'): void;
  onExternalDrop(dt: DataTransfer, targetDir: string): void;
  onPinDrop(dirs: string[]): void;
}

export function useDnd(o: DndOptions) {
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const opts = React.useRef(o);
  opts.current = o;

  const dragPropsFor = React.useCallback((entry: FsEntry): ElProps => {
    // Viewers cannot move anything, so rows are not draggable for them.
    if (!opts.current.canControl) return {};
    return {
      draggable: true,
      onDragStart: (e) => {
        const items = opts.current.dragItems(entry);
        dragging = {
          serverId: opts.current.serverId,
          paths: items.map((x) => x.path),
          dirs: items.filter((x) => x.type === 'dir').map((x) => x.path),
        };
        e.dataTransfer.setData(VANTAGE_DND_TYPE, JSON.stringify({ serverId: dragging.serverId, paths: dragging.paths }));
        e.dataTransfer.setData('text/plain', dragging.paths.join('\n'));
        e.dataTransfer.effectAllowed = 'all';
      },
      onDragEnd: () => {
        dragging = null;
        setDropTarget(null);
      },
    };
  }, []);

  const dropPropsFor = React.useCallback(
    (dir: string): ElProps => ({
      onDragOver: (e) => {
        if (!opts.current.canControl) return;
        const types = Array.from(e.dataTransfer.types);
        if (types.includes(VANTAGE_DND_TYPE)) {
          if (!dragging || dragging.serverId !== opts.current.serverId || !canDropInto(dragging.paths, dir)) return;
          e.dataTransfer.dropEffect = dropMode(e);
        } else if (types.includes('Files')) {
          e.dataTransfer.dropEffect = 'copy';
        } else {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(dir);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropTarget((t) => (t === dir ? null : t));
      },
      onDrop: (e) => {
        setDropTarget(null);
        if (!opts.current.canControl) return;
        const types = Array.from(e.dataTransfer.types);
        if (types.includes(VANTAGE_DND_TYPE)) {
          e.preventDefault();
          e.stopPropagation();
          const d = dragging;
          dragging = null;
          if (d && d.serverId === opts.current.serverId && canDropInto(d.paths, dir)) {
            opts.current.onInternalDrop(d.paths, dir, dropMode(e));
          }
        } else if (types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          opts.current.onExternalDrop(e.dataTransfer, dir);
        }
      },
    }),
    [],
  );

  const pinDropProps = React.useMemo<ElProps>(
    () => ({
      onDragOver: (e) => {
        if (!dragging || dragging.dirs.length === 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setDropTarget(PIN_TARGET);
      },
      onDragLeave: () => setDropTarget((t) => (t === PIN_TARGET ? null : t)),
      onDrop: (e) => {
        setDropTarget(null);
        if (!dragging) return;
        e.preventDefault();
        const dirs = dragging.dirs;
        dragging = null;
        opts.current.onPinDrop(dirs);
      },
    }),
    [],
  );

  return { dragPropsFor, dropPropsFor, pinDropProps, dropTarget };
}
