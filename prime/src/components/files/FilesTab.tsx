import * as React from 'react';
import type { FsEntry } from '@/types';
import { ApiError, type TransferProgress } from '@/api';
import { useCan } from '@/auth';
import { cn } from '@/lib/utils';
import { Button, Card } from '@/components/ui/primitives';
import { ContextMenu, type MenuEntry } from '@/components/ui/context-menu';
import { SectionHeader } from '@/components/SectionHeader';
import { AddressBar } from './AddressBar';
import { Sidebar } from './Sidebar';
import { usePins } from './hooks/usePins';
import { addPin } from './logic/pins';
import { FileList } from './FileList';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { EDITOR_MAX_BYTES, parentOf } from './fsPath';
import { backgroundMenu, itemMenu, type MenuCtx } from './menus';
import { useFileActions } from './useFileActions';
import { collectDropped } from './dropUpload';
import { installFileDropGuard } from './dropGuard';
import { PIN_TARGET, useDnd } from './useDnd';
import { useBulkRunner } from './hooks/useBulkRunner';
import { useClipboard } from './hooks/useClipboard';
import { fetchListing, invalidateListings, useDirListing } from './hooks/useDirListing';
import { useDirSizes } from './hooks/useDirSizes';
import { useNavHistory } from './hooks/useNavHistory';
import { shortcutFor, typeAheadChar } from './logic/keys';
import { emptySelection, findTypeAhead, selectionReducer } from './logic/selection';
import { DEFAULT_SORT, filterEntries, parseSort, sortEntries, toggleSort, type SortSpec } from './logic/sort';
import { planUploadTree, type UploadPlan } from './logic/upload';
import { NewFolderModal, RenameModal } from './dialogs/NameModals';
import { CopyMoveModal } from './dialogs/CopyMoveModal';
import { FileEditor } from './dialogs/FileEditor';
import { PermsModal } from './dialogs/PermsModal';
import { SendToModal } from './dialogs/SendToModal';
import { TransferFooter } from './dialogs/TransferFooter';
import { TrashModal } from './dialogs/TrashModal';

// FilesTab — desktop-style file explorer over one server's host filesystem.
//
// Paths are HOST-relative (/etc/hosts); the outpost maps them through
// /hostfs. The outpost enforces roles; canControl/canAdmin only grey out
// actions so users get feedback instead of a 403.

interface FilesTabProps {
  serverId: string;
}

type Modal =
  | { kind: 'new'; what: 'folder' | 'file'; parent: string }
  | { kind: 'rename'; entry: FsEntry }
  | { kind: 'copyMove'; entry: FsEntry; mode: 'copy' | 'move' }
  | { kind: 'edit'; entry: FsEntry }
  | { kind: 'sendTo'; entry: FsEntry }
  | { kind: 'perms'; entry: FsEntry }
  | { kind: 'trashBin' };

interface MenuState {
  x: number;
  y: number;
  targets: FsEntry[];
  dir: string;
}

const SORT_STORAGE_KEY = 'vantage.files.sort';

function loadSort(): SortSpec {
  try {
    return parseSort(localStorage.getItem(SORT_STORAGE_KEY));
  } catch {
    return DEFAULT_SORT;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard needs a secure context; plain-http LAN installs
    // fall back to a prompt the user can copy from.
    window.prompt('Copy path', text);
  }
}

function listingError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Protected path — your role or the outpost denylist blocks it.';
  if (err instanceof ApiError && err.status === 404) return 'Folder no longer exists.';
  return err instanceof Error ? err.message : String(err);
}

function rowFor(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
}

export function FilesTab({ serverId }: FilesTabProps) {
  const canControl = useCan('operator');
  const canAdmin = useCan('admin');
  const nav = useNavHistory();
  const { data, loading, error, reload } = useDirListing(serverId, nav.path);
  const clipboard = useClipboard();
  const { pins, save: savePins, error: pinsError } = usePins(serverId);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  React.useEffect(() => {
    if (pinsError) setBanner(`Pins: ${pinsError}`);
  }, [pinsError]);

  const [showHidden, setShowHidden] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortSpec>(loadSort);
  const [sizesKey, setSizesKey] = React.useState(0);
  const [banner, setBanner] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<Modal | null>(null);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [transfers, setTransfers] = React.useState<Record<string, TransferProgress>>({});
  const [editAddress, setEditAddress] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const uploadFilesRef = React.useRef<HTMLInputElement>(null);
  const uploadFolderRef = React.useRef<HTMLInputElement>(null);
  const typeAhead = React.useRef({ buf: '', at: 0 });

  React.useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // per-viewer convenience only
    }
  }, [sort]);

  React.useEffect(() => {
    uploadFolderRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  React.useEffect(() => installFileDropGuard(window), []);

  // --- listing, sizes, ordering -------------------------------------------
  const entries = React.useMemo(() => data?.entries ?? [], [data]);
  const dirPaths = React.useMemo(() => entries.filter((e) => e.type === 'dir').map((e) => e.path), [entries]);
  const sizes = useDirSizes(serverId, nav.path, dirPaths, sizesKey);
  const visible = React.useMemo(
    () => sortEntries(filterEntries(entries, { showHidden, query }), sort, sizes),
    [entries, showHidden, query, sort, sizes],
  );
  const order = React.useMemo(() => visible.map((e) => e.path), [visible]);
  const byPath = React.useMemo(() => new Map(visible.map((e) => [e.path, e])), [visible]);

  // --- selection ------------------------------------------------------------
  const [sel, dispatch] = React.useReducer(selectionReducer, emptySelection);
  const selected = React.useMemo(() => visible.filter((e) => sel.selected.has(e.path)), [visible, sel.selected]);

  React.useEffect(() => {
    dispatch({ type: 'clear' });
    setQuery('');
    setMenu(null);
    setSidebarOpen(false);
  }, [nav.path, serverId]);

  React.useEffect(() => {
    dispatch({ type: 'retain', existing: new Set(order) });
  }, [order]);

  React.useEffect(() => {
    if (sel.focus) rowFor(sel.focus)?.scrollIntoView({ block: 'nearest' });
  }, [sel.focus]);

  // --- mutations ------------------------------------------------------------
  const afterMutation = React.useCallback(
    async (dirs: readonly string[]) => {
      invalidateListings(serverId, dirs);
      setSizesKey((k) => k + 1);
      await reload();
    },
    [serverId, reload],
  );

  const upsertTransfer = React.useCallback((p: TransferProgress) => {
    setTransfers((prev) => ({ ...prev, [p.id]: p }));
  }, []);
  const dismissTransfer = React.useCallback((id: string) => {
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // TransferFooter rows keep one SSE stream each and list this callback in
  // their effect deps; a stable identity keeps path changes from reopening
  // every stream, while the ref still refreshes the current folder.
  const refreshCurrentRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    refreshCurrentRef.current = () => afterMutation([nav.path]);
  });
  const refreshCurrent = React.useCallback(() => refreshCurrentRef.current(), []);

  const { runBulk, dialogs: bulkDialogs } = useBulkRunner(React.useCallback(() => void refreshCurrent(), [refreshCurrent]));
  const onError = React.useCallback((m: string) => setBanner(m), []);
  const actions = useFileActions({ serverId, runBulk, afterMutation, onError, onTransferStarted: upsertTransfer });
  const dnd = useDnd({
    serverId,
    canControl,
    dragItems: (entry) => (sel.selected.has(entry.path) ? selected : [entry]),
    onDropItems: (src, dir, mode) =>
      void actions.transfer(src.items.map((i) => ({ path: i.path, isDir: i.isDir })), dir, mode),
    onExternalDrop: (dt, dir) => {
      collectDropped(dt).then(
        (plan) => void actions.upload(plan, dir),
        (e: unknown) => setBanner(`Could not read the dropped items: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    onPinDrop: (dirs) => void savePins(dirs.reduce(addPin, pins)),
  });

  // --- commands ---------------------------------------------------------------
  const open = React.useCallback(
    (e: FsEntry) => {
      if (e.type === 'dir') {
        nav.go(e.path);
      } else if (e.type === 'symlink') {
        fetchListing(serverId, e.path).then(
          () => nav.go(e.path),
          () => !e.broken && setModal({ kind: 'edit', entry: e }),
        );
      } else if (e.type === 'file') {
        if (e.size <= EDITOR_MAX_BYTES) setModal({ kind: 'edit', entry: e });
        else actions.download([e]);
      }
    },
    [nav, serverId, actions],
  );

  const toClipboard = (list: readonly FsEntry[], mode: 'copy' | 'cut') => {
    if (list.length === 0) return;
    clipboard.set({
      serverId,
      mode,
      items: list.map((e) => ({ path: e.path, isDir: e.type === 'dir', size: e.size })),
    });
  };

  const confirmTrash = (list: readonly FsEntry[]) => {
    if (list.length === 0) return;
    const q = list.length === 1 ? `Move "${list[0]!.name}" to trash?` : `Move ${list.length} items to trash?`;
    if (!window.confirm(q)) return;
    dispatch({ type: 'clear' });
    void actions.trash(list);
  };

  const uploadFromInput = (files: FileList | null, folder: boolean) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const plan: UploadPlan = folder
      ? planUploadTree(list.map((f) => ({ relPath: f.webkitRelativePath || f.name, file: f })))
      : { dirs: [], files: list.map((file) => ({ relDir: '', file })) };
    void actions.upload(plan, nav.path);
  };

  const menuCtx: MenuCtx = {
    canControl,
    canAdmin,
    hasClipboard: clipboard.current !== null,
    showHidden,
    open,
    edit: (e) => setModal({ kind: 'edit', entry: e }),
    download: (list) => actions.download(list),
    cut: (list) => toClipboard(list, 'cut'),
    copy: (list) => toClipboard(list, 'copy'),
    paste: (dir) => {
      const c = clipboard.current;
      if (c) void actions.paste(c, dir);
    },
    rename: (e) => setModal({ kind: 'rename', entry: e }),
    copyTo: (e) => setModal({ kind: 'copyMove', entry: e, mode: 'copy' }),
    moveTo: (e) => setModal({ kind: 'copyMove', entry: e, mode: 'move' }),
    copyPath: (e) => void copyText(e.path),
    pin: (e) => void savePins(addPin(pins, e.path)),
    sendTo: (e) => setModal({ kind: 'sendTo', entry: e }),
    perms: (e) => setModal({ kind: 'perms', entry: e }),
    trash: confirmTrash,
    newItem: (what, dir) => setModal({ kind: 'new', what, parent: dir }),
    uploadFiles: () => uploadFilesRef.current?.click(),
    uploadFolder: () => uploadFolderRef.current?.click(),
    refresh: () => void afterMutation([nav.path]),
    toggleHidden: () => setShowHidden((v) => !v),
    openTrashBin: () => setModal({ kind: 'trashBin' }),
  };

  const openMenu = (x: number, y: number, entry: FsEntry | null) => {
    if (entry && !sel.selected.has(entry.path)) {
      dispatch({ type: 'click', path: entry.path, ctrl: false, shift: false, order });
    }
    const targets = entry ? (sel.selected.has(entry.path) ? selected : [entry]) : [];
    setMenu({ x, y, targets, dir: nav.path });
  };
  const closeMenu = React.useCallback(() => {
    setMenu(null);
    rootRef.current?.focus();
  }, []);
  const menuItems: MenuEntry[] = menu
    ? menu.targets.length > 0
      ? itemMenu(menu.targets, menuCtx)
      : backgroundMenu(menu.dir, menuCtx)
    : [];

  const validatePath = React.useCallback(
    async (p: string) => {
      try {
        await fetchListing(serverId, p, true);
        return null;
      } catch (e) {
        return listingError(e);
      }
    },
    [serverId],
  );

  // --- keyboard ---------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (modal || menu) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    const s = shortcutFor(e, canControl);
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
        if (focused) open(focused);
        break;
      case 'up':
        if (nav.path !== '/') nav.go(parentOf(nav.path));
        break;
      case 'trash':
        confirmTrash(selected);
        break;
      case 'rename':
        if (selected.length === 1) setModal({ kind: 'rename', entry: selected[0]! });
        break;
      case 'selectAll':
        dispatch({ type: 'selectAll', order });
        break;
      case 'escape':
        if (sel.selected.size > 0) dispatch({ type: 'clear' });
        else if (clipboard.current?.mode === 'cut') clipboard.set(null);
        break;
      case 'copy':
        toClipboard(selected, 'copy');
        break;
      case 'cut':
        toClipboard(selected, 'cut');
        break;
      case 'paste':
        menuCtx.paste(nav.path);
        break;
      case 'newFolder':
        setModal({ kind: 'new', what: 'folder', parent: nav.path });
        break;
      case 'editAddress':
        setEditAddress((n) => n + 1);
        break;
      case 'refresh':
        menuCtx.refresh();
        break;
      case 'menu': {
        const anchor = (sel.focus && rowFor(sel.focus)) || e.currentTarget;
        const r = anchor.getBoundingClientRect();
        setMenu({ x: r.left + 48, y: r.top + r.height / 2, targets: selected, dir: nav.path });
        break;
      }
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

  const clip = clipboard.current;
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
        <Button size="xs" variant="outline" onClick={() => void reload()}>Retry</Button>
        {nav.path !== '/' && (
          <Button size="xs" variant="outline" onClick={() => nav.go(parentOf(nav.path))}>Go up</Button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      <SectionHeader
        label="Files"
        count={loading && !data ? 'loading…' : data ? `${visible.length} items` : ''}
      />

      <Card className="overflow-hidden">
        <div className="flex min-h-[420px]">
          {sidebarOpen && (
            <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
          )}
          <aside
            className={cn(
              'w-56 shrink-0 border-r bg-muted/10',
              sidebarOpen
                ? 'fixed inset-y-0 left-0 z-40 block w-64 bg-background shadow-xl md:static md:z-auto md:w-56 md:bg-muted/10 md:shadow-none'
                : 'hidden md:block',
            )}
          >
            <Sidebar
              serverId={serverId}
              currentPath={nav.path}
              showHidden={showHidden}
              refreshKey={sizesKey}
              pins={pins}
              onPinsChange={(next) => void savePins(next)}
              onNavigate={(p) => {
                setSidebarOpen(false);
                nav.go(p);
              }}
              dropPropsFor={dnd.dropPropsFor}
              pinDropProps={dnd.pinDropProps}
              dropTarget={dnd.dropTarget}
              pinDropActive={dnd.dropTarget === PIN_TARGET}
            />
          </aside>
          <div
            ref={rootRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="flex min-w-0 flex-1 flex-col outline-none"
          >
            <AddressBar
              path={nav.path}
              canBack={nav.canBack}
              canForward={nav.canForward}
              onBack={nav.back}
              onForward={nav.forward}
              onUp={() => nav.go(parentOf(nav.path))}
              onRefresh={menuCtx.refresh}
              onNavigate={nav.go}
              validate={validatePath}
              editSignal={editAddress}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              dropPropsFor={dnd.dropPropsFor}
              dropTarget={dnd.dropTarget}
            />
            <Toolbar
              canControl={canControl}
              query={query}
              onQuery={setQuery}
              showHidden={showHidden}
              onShowHidden={setShowHidden}
              onNew={(what) => menuCtx.newItem(what, nav.path)}
              onUploadFiles={menuCtx.uploadFiles}
              onUploadFolder={menuCtx.uploadFolder}
            />
            {banner && (
              <div className="flex items-start justify-between gap-2 border-b bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
                <span>{banner}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setBanner(null)}
                >
                  ×
                </button>
              </div>
            )}
            <FileList
              entries={visible}
              showParent={nav.path !== '/'}
              selection={sel}
              sizes={sizes}
              sort={sort}
              cutPaths={cutPaths}
              loading={loading}
              error={errorNode}
              onSort={(k) => setSort((s) => toggleSort(s, k))}
              onRowClick={(ev, entry) =>
                dispatch({ type: 'click', path: entry.path, ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, order })
              }
              onRowCheck={(entry) => dispatch({ type: 'toggle', path: entry.path })}
              onToggleAll={() =>
                dispatch(sel.selected.size > 0 && sel.selected.size === order.length ? { type: 'clear' } : { type: 'selectAll', order })
              }
              onOpen={open}
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
              canControl={canControl}
              onTrash={() => confirmTrash(selected)}
              onMore={(ev) => {
                const r = ev.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4, targets: selected, dir: nav.path });
              }}
            />
          </div>
        </div>
      </Card>

      <input
        ref={uploadFilesRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          uploadFromInput(e.target.files, false);
          e.target.value = '';
        }}
      />
      <input
        ref={uploadFolderRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          uploadFromInput(e.target.files, true);
          e.target.value = '';
        }}
      />

      {modal?.kind === 'new' && (
        <NewFolderModal
          parent={modal.parent}
          what={modal.what}
          onCancel={() => setModal(null)}
          onSubmit={(name) => {
            setModal(null);
            void actions.create(modal.parent, name, modal.what);
          }}
        />
      )}
      {modal?.kind === 'rename' && (
        <RenameModal
          entry={modal.entry}
          onCancel={() => setModal(null)}
          onSubmit={(name) => {
            setModal(null);
            dispatch({ type: 'clear' });
            void actions.rename(modal.entry, name);
          }}
        />
      )}
      {modal?.kind === 'copyMove' && (
        <CopyMoveModal
          entry={modal.entry}
          mode={modal.mode}
          onCancel={() => setModal(null)}
          onSubmit={(dst, overwrite) => {
            setModal(null);
            void actions.copyOrMoveTo(modal.entry, dst, modal.mode, overwrite);
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <FileEditor
          serverId={serverId}
          entry={modal.entry}
          canSave={canControl}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refreshCurrent();
          }}
        />
      )}
      {modal?.kind === 'sendTo' && (
        <SendToModal
          sourceServerId={serverId}
          entry={modal.entry}
          canPreserveOwnership={canAdmin}
          onCancel={() => setModal(null)}
          onStarted={(p) => {
            setModal(null);
            upsertTransfer(p);
          }}
        />
      )}
      {modal?.kind === 'trashBin' && (
        <TrashModal serverId={serverId} canAdmin={canAdmin} onClose={() => setModal(null)} onRestored={refreshCurrent} />
      )}
      {modal?.kind === 'perms' && (
        <PermsModal
          serverId={serverId}
          entry={modal.entry}
          onCancel={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            await refreshCurrent();
          }}
        />
      )}

      {bulkDialogs}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}

      <TransferFooter
        transfers={transfers}
        onUpdate={upsertTransfer}
        onDismiss={dismissTransfer}
        onRefreshSource={refreshCurrent}
      />
    </div>
  );
}
