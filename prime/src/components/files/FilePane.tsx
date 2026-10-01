import * as React from 'react';
import type { FsEntry } from '@/types';
import { ApiError, type ServerSummary } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { AddressBar } from './AddressBar';
import { FileList } from './FileList';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { parentOf } from './fsPath';
import { PIN_TARGET, useDnd, type DropSource } from './useDnd';
import { ignoresExplorerKeys } from './keyTarget';
import { dropLabel, emptyText, hintFor } from './logic/hints';
import { fetchListing, useDirListing } from './hooks/useDirListing';
import { useDirSizes } from './hooks/useDirSizes';
import type { FsClipboard } from './logic/clipboard';
import { shortcutFor, typeAheadChar } from './logic/keys';
import type { PaneNav } from './logic/paneHistory';
import { childToward, createScrollMemory } from './logic/scrollMemory';
import { emptySelection, findTypeAhead, selectionReducer } from './logic/selection';
import { filterEntries, sortEntries, toggleSort, type SortSpec } from './logic/sort';

// FilePane — one folder view: navigation, listing, folder sizes, selection,
// keyboard and drag & drop for its own rows. Anything shared between panes
// (dialogs, menus, clipboard, transfers) is requested from the shell
// (FilesTab) through onCommand.

export type PaneId = 'left' | 'right';

export type PaneCommand =
  | { type: 'open'; entry: FsEntry }
  | { type: 'menu'; x: number; y: number; targets: FsEntry[] }
  | { type: 'trash'; entries: FsEntry[] }
  | { type: 'rename'; entry: FsEntry }
  | { type: 'newItem'; what: 'folder' | 'file' }
  | { type: 'upload'; folder: boolean }
  | { type: 'clipboard'; mode: 'copy' | 'cut'; entries: FsEntry[] }
  | { type: 'clearCut' }
  | { type: 'paste' }
  | { type: 'toOther'; mode: 'copy' | 'move'; entries: FsEntry[] }
  | { type: 'toggleSplit' }
  | { type: 'switchPane' }
  | { type: 'help' };

export interface FilePaneProps {
  paneId: PaneId;
  serverId: string;
  servers: readonly ServerSummary[];
  onServerChange(id: string): void;
  nav: PaneNav;
  split: boolean;
  canSplit: boolean;
  active: boolean;
  onActivate(): void;
  rootRef: React.RefObject<HTMLDivElement>;
  canControl: boolean;
  showHidden: boolean;
  onShowHidden(v: boolean): void;
  sort: SortSpec;
  onSort(next: SortSpec): void;
  mutationKey: number;
  clipboard: FsClipboard | null;
  blocked: boolean;
  onDropItems(src: DropSource, targetDir: string, mode: 'copy' | 'move'): void;
  onExternalDrop(dt: DataTransfer, targetDir: string): void;
  onCommand(cmd: PaneCommand): void;
  onToggleSidebar(): void;
  // Split view: "server:/path" of the other pane, for button tooltips.
  otherTarget: string | null;
  serverLabel: string;
  showHints: boolean;
  onHideHints(): void;
  // One-off callout rendered above the list (first time split view opens).
  tip?: React.ReactNode;
}

export function listingError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Protected path — your role or the outpost denylist blocks it.';
  if (err instanceof ApiError && err.status === 404) return 'Folder no longer exists.';
  return err instanceof Error ? err.message : String(err);
}

// Row lookups are scoped to the pane: both panes may show the same path.
function rowIn(root: HTMLElement | null, path: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`) ?? null;
}

export function FilePane(p: FilePaneProps) {
  const { serverId, nav } = p;
  const cmd = p.onCommand;
  const { data, loading, error, reload } = useDirListing(serverId, nav.path);
  const [query, setQuery] = React.useState('');
  const [sizesKey, setSizesKey] = React.useState(0);
  const [editAddress, setEditAddress] = React.useState(0);
  const typeAhead = React.useRef({ buf: '', at: 0 });
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;

  // --- listing, sizes, ordering -------------------------------------------
  const entries = React.useMemo(() => data?.entries ?? [], [data]);
  const dirPaths = React.useMemo(() => entries.filter((e) => e.type === 'dir').map((e) => e.path), [entries]);
  const sizes = useDirSizes(serverId, nav.path, dirPaths, sizesKey);
  const visible = React.useMemo(
    () => sortEntries(filterEntries(entries, { showHidden: p.showHidden, query }), p.sort, sizes),
    [entries, p.showHidden, query, p.sort, sizes],
  );
  const order = React.useMemo(() => visible.map((e) => e.path), [visible]);
  const byPath = React.useMemo(() => new Map(visible.map((e) => [e.path, e])), [visible]);

  // --- selection ------------------------------------------------------------
  const [sel, dispatch] = React.useReducer(selectionReducer, emptySelection);
  const selected = React.useMemo(() => visible.filter((e) => sel.selected.has(e.path)), [visible, sel.selected]);

  React.useEffect(() => {
    dispatch({ type: 'clear' });
    setQuery('');
  }, [nav.path, serverId]);

  React.useEffect(() => {
    dispatch({ type: 'retain', existing: new Set(order) });
  }, [order]);

  const { rootRef } = p;
  React.useEffect(() => {
    if (sel.focus) rowIn(rootRef.current, sel.focus)?.scrollIntoView({ block: 'nearest' });
  }, [sel.focus, rootRef]);

  // --- scroll memory ----------------------------------------------------------
  // Each folder keeps its scroll position for the session. On arriving in a
  // folder (once its listing is in), the list returns to that position, and
  // when the new folder is above the old one, the folder you came out of is
  // selected, as in a desktop file manager.
  const listRef = React.useRef<HTMLDivElement>(null);
  const scrollMem = React.useRef(createScrollMemory());
  const arriving = React.useRef<{ path: string; from: string } | null>(null);
  const lastPath = React.useRef(nav.path);
  if (lastPath.current !== nav.path) {
    arriving.current = { path: nav.path, from: lastPath.current };
    lastPath.current = nav.path;
  }
  React.useLayoutEffect(() => {
    const a = arriving.current;
    if (!a || data?.path !== a.path) return;
    arriving.current = null;
    const el = listRef.current;
    if (el) el.scrollTop = scrollMem.current.get(a.path);
    const child = childToward(a.from, a.path);
    if (child && byPath.has(child)) dispatch({ type: 'click', path: child, ctrl: false, shift: false, order });
  }, [data, byPath, order]);
  const onScrollTop = React.useCallback(
    (top: number) => {
      // Ignore the jump while a new folder loads; it isn't where the user was.
      if (!arriving.current) scrollMem.current.set(nav.path, top);
    },
    [nav.path],
  );

  // Any change anywhere (this pane, the other pane, a dialog) bumps
  // mutationKey; reload keeps the rows on screen until fresh data arrives.
  const seenKey = React.useRef(p.mutationKey);
  React.useEffect(() => {
    if (seenKey.current === p.mutationKey) return;
    seenKey.current = p.mutationKey;
    void reloadRef.current();
    setSizesKey((k) => k + 1);
  }, [p.mutationKey]);

  const refresh = React.useCallback(() => {
    void reloadRef.current();
    setSizesKey((k) => k + 1);
  }, []);

  const dnd = useDnd({
    serverId,
    canControl: p.canControl,
    dragItems: (entry) => (sel.selected.has(entry.path) ? selected : [entry]),
    onDropItems: p.onDropItems,
    onExternalDrop: p.onExternalDrop,
  });

  const openMenu = (x: number, y: number, entry: FsEntry | null) => {
    if (entry && !sel.selected.has(entry.path)) {
      dispatch({ type: 'click', path: entry.path, ctrl: false, shift: false, order });
    }
    const targets = entry ? (sel.selected.has(entry.path) ? selected : [entry]) : [];
    cmd({ type: 'menu', x, y, targets });
  };

  const validatePath = React.useCallback(
    async (path: string) => {
      try {
        await fetchListing(serverId, path, true);
        return null;
      } catch (e) {
        return listingError(e);
      }
    },
    [serverId],
  );

  // --- keyboard ---------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (p.blocked) return;
    if (ignoresExplorerKeys(e.target as HTMLElement, e.key)) return;
    const s = shortcutFor(e, p.canControl, p.split, e.target === e.currentTarget);
    if (!s) {
      const ch = typeAheadChar(e);
      if (!ch) return;
      const ta = typeAhead.current;
      const now = Date.now();
      ta.buf = now - ta.at > 700 ? ch : ta.buf + ch;
      ta.at = now;
      const hit = findTypeAhead(visible, ta.buf, sel.focus);
      if (hit) dispatch({ type: 'click', path: hit, ctrl: false, shift: false, order });
      return;
    }
    e.preventDefault();
    const focused = sel.focus ? byPath.get(sel.focus) : undefined;
    switch (s) {
      case 'prev':
      case 'next':
      case 'first':
      case 'last':
        dispatch({ type: 'move', to: s, extend: e.shiftKey, order });
        break;
      case 'open':
        if (focused) cmd({ type: 'open', entry: focused });
        break;
      case 'up':
        if (nav.path !== '/') nav.go(parentOf(nav.path));
        break;
      case 'trash':
        if (selected.length > 0) cmd({ type: 'trash', entries: selected });
        break;
      case 'rename':
        if (selected.length === 1) cmd({ type: 'rename', entry: selected[0]! });
        break;
      case 'selectAll':
        dispatch({ type: 'selectAll', order });
        break;
      case 'escape':
        if (sel.selected.size > 0) dispatch({ type: 'clear' });
        else cmd({ type: 'clearCut' });
        break;
      case 'copy':
      case 'cut':
        if (selected.length > 0) cmd({ type: 'clipboard', mode: s, entries: selected });
        break;
      case 'paste':
        cmd({ type: 'paste' });
        break;
      case 'newFolder':
        cmd({ type: 'newItem', what: 'folder' });
        break;
      case 'editAddress':
        setEditAddress((n) => n + 1);
        break;
      case 'refresh':
        refresh();
        break;
      case 'menu': {
        const anchor = (sel.focus && rowIn(rootRef.current, sel.focus)) || e.currentTarget;
        const r = anchor.getBoundingClientRect();
        cmd({ type: 'menu', x: r.left + 48, y: r.top + r.height / 2, targets: selected });
        break;
      }
      case 'copyOther':
      case 'moveOther':
        if (selected.length > 0) cmd({ type: 'toOther', mode: s === 'copyOther' ? 'copy' : 'move', entries: selected });
        break;
      case 'switchPane':
        cmd({ type: 'switchPane' });
        break;
      case 'toggleSplit':
        cmd({ type: 'toggleSplit' });
        break;
      case 'help':
        cmd({ type: 'help' });
        break;
      case 'paneBack':
        nav.back();
        break;
      case 'paneForward':
        nav.forward();
        break;
      case 'noop':
        break;
    }
  };

  // --- derived display ---------------------------------------------------------
  const selectionSize = React.useMemo(() => {
    let bytes = 0;
    let unknown = false;
    for (const e of selected) {
      if (e.type !== 'dir') {
        bytes += e.size;
        continue;
      }
      const s = sizes.get(e.path);
      if (s?.state === 'done') {
        bytes += s.bytes;
        if (s.partial) unknown = true;
      } else {
        unknown = true;
      }
    }
    return { bytes, unknown };
  }, [selected, sizes]);

  const clip = p.clipboard;
  const cutPaths = React.useMemo(
    () =>
      clip && clip.mode === 'cut' && clip.serverId === serverId
        ? new Set(clip.items.map((i) => i.path))
        : new Set<string>(),
    [clip, serverId],
  );
  const clipboardNote = clip ? `${clip.items.length} ${clip.mode === 'cut' ? 'cut' : 'copied'}` : null;

  const errorNode = error ? (
    <div className="space-y-2 p-4 text-xs">
      <div className="text-destructive">{listingError(error)}</div>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" onClick={refresh}>Retry</Button>
        {nav.path !== '/' && (
          <Button size="xs" variant="outline" onClick={() => nav.go(parentOf(nav.path))}>Go up</Button>
        )}
      </div>
    </div>
  ) : null;

  const serverPicker = p.split ? (
    <select
      value={serverId}
      onChange={(e) => p.onServerChange(e.target.value)}
      title="Server for this pane"
      aria-label="Server for this pane"
      className="h-7 max-w-[9rem] truncate rounded border bg-background px-1 text-xs"
    >
      {p.servers.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  ) : undefined;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDownCapture={p.onActivate}
      onFocusCapture={p.onActivate}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col outline-none',
        p.split && p.paneId === 'right' && 'border-l',
        p.split && p.active && 'ring-1 ring-inset ring-primary',
      )}
    >
      <AddressBar
        path={nav.path}
        canBack={nav.canBack}
        canForward={nav.canForward}
        onBack={nav.back}
        onForward={nav.forward}
        onUp={() => nav.go(parentOf(nav.path))}
        onRefresh={refresh}
        onNavigate={nav.go}
        validate={validatePath}
        editSignal={editAddress}
        onToggleSidebar={p.onToggleSidebar}
        dropPropsFor={dnd.dropPropsFor}
        dropTarget={dnd.dropTarget}
        serverPicker={serverPicker}
        refreshTitle={p.split ? 'Refresh (Ctrl+Shift+R)' : 'Refresh (F5)'}
      >
        <Toolbar
          canControl={p.canControl}
          query={query}
          onQuery={setQuery}
          showHidden={p.showHidden}
          onShowHidden={p.onShowHidden}
          onNew={(what) => cmd({ type: 'newItem', what })}
          onUploadFiles={() => cmd({ type: 'upload', folder: false })}
          onUploadFolder={() => cmd({ type: 'upload', folder: true })}
          split={p.split}
          canSplit={p.canSplit}
          onToggleSplit={() => cmd({ type: 'toggleSplit' })}
          onHelp={() => cmd({ type: 'help' })}
        />
      </AddressBar>
      {p.tip}
      <FileList
        compact={p.split}
        scrollRef={listRef}
        onScrollTop={onScrollTop}
        entries={visible}
        emptyText={emptyText({ query, canControl: p.canControl })}
        showParent={nav.path !== '/'}
        selection={sel}
        sizes={sizes}
        sort={p.sort}
        cutPaths={cutPaths}
        loading={loading}
        error={errorNode}
        onSort={(k) => p.onSort(toggleSort(p.sort, k))}
        onRowClick={(ev, entry) =>
          dispatch({ type: 'click', path: entry.path, ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, order })
        }
        onRowCheck={(entry) => dispatch({ type: 'toggle', path: entry.path })}
        onToggleAll={() =>
          dispatch(sel.selected.size > 0 && sel.selected.size === order.length ? { type: 'clear' } : { type: 'selectAll', order })
        }
        onOpen={(entry) => cmd({ type: 'open', entry })}
        onUp={() => nav.go(parentOf(nav.path))}
        onContextMenu={(ev, entry) => openMenu(ev.clientX, ev.clientY, entry)}
        onBackgroundClick={() => dispatch({ type: 'clear' })}
        dragPropsFor={dnd.dragPropsFor}
        dropPropsFor={dnd.dropPropsFor}
        dropTarget={dnd.dropTarget}
        currentDir={nav.path}
      />
      <StatusBar
        count={visible.length}
        selectedCount={selected.length}
        selectedBytes={selectionSize.bytes}
        sizeUnknown={selectionSize.unknown}
        clipboardNote={clipboardNote}
        canControl={p.canControl}
        onTrash={() => selected.length > 0 && cmd({ type: 'trash', entries: selected })}
        onMore={(ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          cmd({ type: 'menu', x: r.left, y: r.bottom + 4, targets: selected });
        }}
        {...(p.otherTarget !== null
          ? {
              toOther: {
                arrow: p.paneId === 'left' ? ('→' as const) : ('←' as const),
                target: p.otherTarget,
                onCopy: () => selected.length > 0 && cmd({ type: 'toOther', mode: 'copy', entries: selected }),
                onMove: () => selected.length > 0 && cmd({ type: 'toOther', mode: 'move', entries: selected }),
              },
            }
          : {})}
      />
      {p.showHints && (
        <div className="flex items-center gap-2 border-t px-3 py-1 text-[10px] text-muted-foreground">
          <span className="flex-1 truncate">
            {hintFor({ selectedCount: selected.length, split: p.split, canControl: p.canControl, pane: p.paneId })}
          </span>
          <button
            type="button"
            aria-label="Hide hints"
            title="Hide hints (bring them back from the ? sheet)"
            className="hover:text-foreground"
            onClick={p.onHideHints}
          >
            ✕
          </button>
        </div>
      )}
      {dnd.hover && dnd.hover.dir !== PIN_TARGET && (
        <div
          className="pointer-events-none fixed z-50 rounded border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow"
          style={{ left: dnd.hover.x + 14, top: dnd.hover.y + 14 }}
        >
          {dropLabel({
            mode: dnd.hover.mode,
            count: dnd.hover.count,
            target: p.split ? `${p.serverLabel}:${dnd.hover.dir}` : dnd.hover.dir,
          })}
        </div>
      )}
    </div>
  );
}
