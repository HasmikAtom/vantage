import * as React from 'react';
import type { FsEntry } from '@/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoaderIcon } from '@/components/ui/icons';
import { EntryIcon } from './EntryIcon';
import { formatBytes, formatMtime } from './fsPath';
import type { SelectionState } from './logic/selection';
import { formatDirSize, type SizeMap } from './logic/sizes';
import type { SortKey, SortSpec } from './logic/sort';
import { edgeScrollDelta } from './logic/scrollMemory';

export type ElProps = React.HTMLAttributes<HTMLElement>;

export interface FileListProps {
  entries: readonly FsEntry[];
  showParent: boolean;
  selection: SelectionState;
  sizes: SizeMap;
  sort: SortSpec;
  cutPaths: ReadonlySet<string>;
  loading: boolean;
  error: React.ReactNode;
  onSort(key: SortKey): void;
  onRowClick(e: React.MouseEvent, entry: FsEntry): void;
  onRowCheck(entry: FsEntry): void;
  onToggleAll(): void;
  onOpen(entry: FsEntry): void;
  onUp(): void;
  onContextMenu(e: React.MouseEvent, entry: FsEntry | null): void;
  onBackgroundClick(): void;
  dragPropsFor?: (entry: FsEntry) => ElProps;
  dropPropsFor?: (dir: string) => ElProps;
  dropTarget?: string | null;
  currentDir?: string;
  emptyText?: string;
  // Narrow pane (split view): drop the Owner and Mode columns.
  compact?: boolean;
  // The scrolling element, and its scroll position as it changes.
  scrollRef?: React.Ref<HTMLDivElement>;
  onScrollTop?: (top: number) => void;
}

const NARROW_HIDDEN: ReadonlySet<SortKey> = new Set<SortKey>(['owner', 'mode']);

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size', className: 'text-right' },
  { key: 'mtime', label: 'Modified' },
  { key: 'owner', label: 'Owner' },
  { key: 'mode', label: 'Mode' },
];

function HeaderCheckbox(p: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = p.indeterminate;
  }, [p.indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all"
      className="h-3 w-3"
      checked={p.checked}
      onChange={p.onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function FileList(p: FileListProps) {
  const selCount = p.entries.reduce((n, e) => n + (p.selection.selected.has(e.path) ? 1 : 0), 0);
  const all = p.entries.length > 0 && selCount === p.entries.length;
  const bgDrop = p.currentDir !== undefined ? p.dropPropsFor?.(p.currentDir) ?? {} : {};

  return (
    <div
      {...bgDrop}
      ref={p.scrollRef}
      data-file-scroll=""
      onScroll={(e) => p.onScrollTop?.(e.currentTarget.scrollTop)}
      // Dragging near the top or bottom edge scrolls the list.
      onDragOverCapture={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const dy = edgeScrollDelta(e.clientY, r.top, r.bottom);
        if (dy !== 0) e.currentTarget.scrollTop += dy;
      }}
      className={cn(
        'relative min-h-[160px] flex-1 overflow-auto',
        p.currentDir !== undefined && p.dropTarget === p.currentDir && 'bg-primary/5 ring-1 ring-inset ring-primary/40',
      )}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('tr[data-path], tr[data-parent-row]')) p.onBackgroundClick();
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('tr[data-path]')) return;
        e.preventDefault();
        p.onContextMenu(e, null);
      }}
    >
      {/* Compact rows: 32 px instead of the shared table's 41 px. */}
      {p.error ?? (
        <Table className="[&_td]:py-1.5 [&_th]:h-8" containerClassName="">
          {/* Column headers stay visible while the list scrolls. */}
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="w-7 pr-0">
                <HeaderCheckbox checked={all} indeterminate={selCount > 0 && !all} onChange={p.onToggleAll} />
              </TableHead>
              <TableHead className="w-6 pr-0" />
              {COLUMNS.filter((c) => !p.compact || !NARROW_HIDDEN.has(c.key)).map((c) => (
                <TableHead
                  key={c.key}
                  className={cn('cursor-pointer select-none', c.className)}
                  onClick={() => p.onSort(c.key)}
                  aria-sort={p.sort.key === c.key ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {p.sort.key === c.key && (
                    <span className="ml-1 text-muted-foreground">{p.sort.dir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.showParent && (
              <TableRow data-parent-row="" onClick={p.onUp} className="cursor-pointer hover:bg-muted/50">
                <TableCell />
                <TableCell className="pr-0 text-muted-foreground/60">↩</TableCell>
                <TableCell className="font-mono text-xs">..</TableCell>
                <TableCell colSpan={p.compact ? 2 : 4} className="text-xs text-muted-foreground/60">parent folder</TableCell>
              </TableRow>
            )}
            {p.entries.length === 0 && !p.loading && (
              <TableRow>
                <TableCell colSpan={p.compact ? 5 : 7} className="text-xs text-muted-foreground">{p.emptyText ?? 'empty'}</TableCell>
              </TableRow>
            )}
            {p.entries.map((e) => (
              <Row key={e.path} entry={e} p={p} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function Row({ entry: e, p }: { entry: FsEntry; p: FileListProps }) {
  const selected = p.selection.selected.has(e.path);
  const size = e.type === 'dir' ? p.sizes.get(e.path) : undefined;
  return (
    <TableRow
      data-path={e.path}
      aria-selected={selected}
      {...(p.dragPropsFor?.(e) ?? {})}
      {...(e.type === 'dir' ? p.dropPropsFor?.(e.path) ?? {} : {})}
      onClick={(ev) => {
        ev.stopPropagation();
        p.onRowClick(ev, e);
      }}
      onDoubleClick={() => p.onOpen(e)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        p.onContextMenu(ev, e);
      }}
      className={cn(
        'cursor-pointer select-none',
        selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/50',
        p.selection.focus === e.path && 'outline outline-1 -outline-offset-1 outline-primary/50',
        p.cutPaths.has(e.path) && 'opacity-50',
        e.type === 'dir' && p.dropTarget === e.path && 'bg-primary/20 ring-1 ring-inset ring-primary',
      )}
    >
      <TableCell
        className="pr-0"
        onClick={(ev) => {
          ev.stopPropagation();
          p.onRowCheck(e);
        }}
      >
        <input type="checkbox" className="h-3 w-3" checked={selected} readOnly tabIndex={-1} aria-label={`Select ${e.name}`} />
      </TableCell>
      <TableCell className="pr-0">
        <EntryIcon entry={e} />
      </TableCell>
      <TableCell className="max-w-[420px] truncate font-mono text-xs">
        {e.name}
        {e.type === 'symlink' && e.target && <span className="ml-1.5 text-muted-foreground/60">→ {e.target}</span>}
        {e.broken && <Badge variant="danger" className="ml-1.5 rounded-sm">broken</Badge>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {e.type !== 'dir' ? (
          formatBytes(e.size)
        ) : size?.state === 'pending' ? (
          <LoaderIcon size={11} className="ml-auto animate-spin" />
        ) : (
          formatDirSize(size)
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{formatMtime(e.mtime)}</TableCell>
      {!p.compact && (
        <>
          <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
            {e.owner}
            <span className="text-muted-foreground/40">:</span>
            {e.group}
          </TableCell>
          <TableCell className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">{e.modeStr}</TableCell>
        </>
      )}
    </TableRow>
  );
}
