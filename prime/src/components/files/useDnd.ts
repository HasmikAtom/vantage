import * as React from 'react';
import type { FsEntry } from '@/types';
import type { ElProps } from './FileList';
import type { ClipItem } from './logic/clipboard';
import { VANTAGE_DND_TYPE, canDropAcross, crossDropMode } from './logic/dnd';

// Sentinel dropTarget value for the sidebar's "Pinned" heading.
export const PIN_TARGET = '\u0000pins';

export interface DropSource {
  serverId: string;
  items: ClipItem[];
}

export interface DragHover {
  dir: string;
  x: number;
  y: number;
  mode: 'copy' | 'move' | 'upload';
  count: number;
  crossServer: boolean;
}

// The drag payload is mirrored here: during dragover browsers expose only
// the MIME types, not the data, and we need the paths (and their server)
// to reject invalid targets and to pick move vs copy. It is module state so
// a drag that starts in one pane can be dropped in the other.
let dragging: DropSource | null = null;

interface DndOptions {
  serverId: string;
  canControl: boolean;
  dragItems(entry: FsEntry): FsEntry[];
  onDropItems(src: DropSource, targetDir: string, mode: 'copy' | 'move'): void;
  onExternalDrop(dt: DataTransfer, targetDir: string): void;
  onPinDrop?: (dirs: string[]) => void;
}

export function useDnd(o: DndOptions) {
  const [hover, setHover] = React.useState<DragHover | null>(null);
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
          items: items.map((x) => ({ path: x.path, isDir: x.type === 'dir', size: x.size })),
        };
        e.dataTransfer.setData(VANTAGE_DND_TYPE, JSON.stringify({ serverId: dragging.serverId, paths: dragging.items.map((i) => i.path) }));
        e.dataTransfer.setData('text/plain', dragging.items.map((i) => i.path).join('\n'));
        e.dataTransfer.effectAllowed = 'all';
      },
      onDragEnd: () => {
        dragging = null;
        setHover(null);
      },
    };
  }, []);

  const dropPropsFor = React.useCallback(
    (dir: string): ElProps => ({
      onDragOver: (e) => {
        if (!opts.current.canControl) return;
        const types = Array.from(e.dataTransfer.types);
        let mode: DragHover['mode'];
        let count: number;
        let crossServer = false;
        if (types.includes(VANTAGE_DND_TYPE)) {
          const d = dragging;
          if (!d || !canDropAcross(d.serverId, d.items.map((i) => i.path), opts.current.serverId, dir)) return;
          crossServer = d.serverId !== opts.current.serverId;
          mode = crossDropMode(e, !crossServer);
          count = d.items.length;
          e.dataTransfer.dropEffect = mode;
        } else if (types.includes('Files')) {
          mode = 'upload';
          count = e.dataTransfer.items.length;
          e.dataTransfer.dropEffect = 'copy';
        } else {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setHover({ dir, x: e.clientX, y: e.clientY, mode, count, crossServer });
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setHover((h) => (h && h.dir === dir ? null : h));
      },
      onDrop: (e) => {
        setHover(null);
        if (!opts.current.canControl) return;
        const types = Array.from(e.dataTransfer.types);
        if (types.includes(VANTAGE_DND_TYPE)) {
          e.preventDefault();
          e.stopPropagation();
          const d = dragging;
          dragging = null;
          if (d && canDropAcross(d.serverId, d.items.map((i) => i.path), opts.current.serverId, dir)) {
            opts.current.onDropItems(d, dir, crossDropMode(e, d.serverId === opts.current.serverId));
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
        const d = dragging;
        // Pins belong to this surface's server; folders from the other
        // server cannot be pinned here.
        if (!d || d.serverId !== opts.current.serverId || !d.items.some((i) => i.isDir)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setHover({ dir: PIN_TARGET, x: e.clientX, y: e.clientY, mode: 'copy', count: 0, crossServer: false });
      },
      onDragLeave: () => setHover((h) => (h && h.dir === PIN_TARGET ? null : h)),
      onDrop: (e) => {
        setHover(null);
        const d = dragging;
        if (!d || d.serverId !== opts.current.serverId) return;
        e.preventDefault();
        dragging = null;
        opts.current.onPinDrop?.(d.items.filter((i) => i.isDir).map((i) => i.path));
      },
    }),
    [],
  );

  return { dragPropsFor, dropPropsFor, pinDropProps, dropTarget: hover?.dir ?? null, hover };
}
